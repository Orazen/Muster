// CLI-only credential IO. Node built-ins keep the standalone CLI bundle portable.
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const posix = process.platform !== "win32";
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const failConfig = () => new Error("Pairing config is unreadable or unsafe. Check the config directory and file permissions before pairing again.");
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- This is the JSON config boundary parser in the built-in-only CLI, before constructing config values.
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const owned = (stat) => !posix || stat.uid === process.getuid();

function parent(file, create) {
  const directory = dirname(file);
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) { if (!create && error.code === "ENOENT") return null; throw failConfig(); }
  // Inspect the selected directory, not system ancestors such as macOS /var.
  // Existing directories are not chmod'ed: they may contain other user data.
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (posix && (stat.mode & 0o022))) throw failConfig();
  return { directory, stat, file: join(fs.realpathSync(directory), basename(file)) };
}

function verifyParent(receipt) {
  const current = fs.lstatSync(receipt.directory);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(receipt.stat, current)
    || !owned(current) || (posix && (current.mode & 0o022))) throw failConfig();
}

function snapshot(file) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw failConfig(); }
  if (!before.isFile() || before.nlink !== 1 || !owned(before) || before.size > MAX_CONFIG_BYTES) throw failConfig();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !owned(opened) || !sameFile(before, opened)) throw failConfig();
    // mode supplied to writeFile only affects new files; repair old 0644 files too.
    // Windows access is governed by ACLs, not these POSIX permission bits.
    if (posix) fs.fchmodSync(fd, 0o600);
    const bytes = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (Buffer.byteLength(bytes) > MAX_CONFIG_BYTES || after.nlink !== 1 || !current.isFile()
      || current.nlink !== 1 || !sameFile(opened, current) || after.size !== Buffer.byteLength(bytes)) throw failConfig();
    const value = JSON.parse(bytes);
    if (!record(value)) throw failConfig();
    return { value, stat: after };
  } catch { throw failConfig(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function loadCliConfig(file) {
  const receipt = parent(file, false);
  if (!receipt) return {};
  const existing = snapshot(receipt.file);
  verifyParent(receipt);
  return existing?.value ?? {};
}

export function saveCliConfig(file, patch) {
  if (!record(patch)) throw failConfig();
  const receipt = parent(file, true);
  const existing = snapshot(receipt.file);
  const text = JSON.stringify({ ...existing?.value, ...patch }, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw failConfig();
  const temporary = `${receipt.file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    if (posix) fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    verifyParent(receipt);
    let current;
    try { current = fs.lstatSync(receipt.file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing ? !current?.isFile() || current.nlink !== 1 || !sameFile(existing.stat, current)
      || current.size !== existing.stat.size || current.mtimeMs !== existing.stat.mtimeMs
      : current !== undefined) throw failConfig();
    fs.renameSync(temporary, receipt.file);
    created = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) {
      try { fs.unlinkSync(temporary); }
      catch { /* Preserve the original failure; any leftover temporary file is 0600. */ }
    }
  }
}

export function rejectPasswordArgument(argv) {
  if (argv.some((value) => value === "--password" || value.startsWith("--password="))) {
    throw new Error("Passwords in command arguments are not supported. Omit --password for a hidden prompt, or use --password-stdin with input from your secret manager.");
  }
}

function passwordValue(text) {
  const value = text.replace(/\r?\n$/, "");
  if (!value || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > MAX_PASSWORD_BYTES) {
    throw new Error("Supply one nonempty password line, at most 4096 bytes, without NUL characters.");
  }
  return value;
}

async function fromStdin(input) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_PASSWORD_BYTES + 2) throw new Error("Password input is too long (maximum 4096 bytes).");
      chunks.push(bytes);
    }
  } catch (error) {
    if (size > MAX_PASSWORD_BYTES + 2) throw error;
    throw new Error("Could not read the password from stdin.");
  }
  return passwordValue(Buffer.concat(chunks).toString("utf8"));
}

function hiddenPrompt(input, output) {
  return new Promise((resolve, reject) => {
    // readline puts the TTY into raw mode; the sink prevents echo and redisplay.
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const wasRaw = Boolean(input.isRaw);
    let rl;
    let settled = false;
    const inputError = () => finish(new Error("Could not read the password."));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      rl?.close();
      input.off("error", inputError);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    try {
      output.write("Password (hidden): ");
      input.once("error", inputError);
      rl = createInterface({ input, output: muted, terminal: true, historySize: 0 });
      rl.once("SIGINT", () => finish(new Error("Pairing cancelled.")));
      rl.once("close", () => finish(new Error("Password entry ended before a password was entered.")));
      rl.once("error", () => finish(new Error("Could not read the password.")));
      rl.question("", (answer) => {
        try { finish(null, passwordValue(answer)); } catch (error) { finish(error); }
      });
    } catch { finish(new Error("Could not open the hidden password prompt.")); }
  });
}

export async function readPairPassword(argv, { input = process.stdin, output = process.stderr } = {}) {
  rejectPasswordArgument(argv);
  if (argv.includes("--password-stdin")) return fromStdin(input);
  if (!input.isTTY || !output.isTTY) {
    throw new Error("A terminal is required for hidden password entry. For scripts, use --password-stdin with input from your secret manager.");
  }
  return hiddenPrompt(input, output);
}

export function sessionCookie(headers, base) {
  const secure = new URL(base).protocol === "https:";
  const allowed = secure ? ["__Secure-better-auth.session_token", "better-auth.session_token"] : ["better-auth.session_token"];
  const cookies = headers.getSetCookie();
  for (const name of allowed) {
    for (const raw of cookies) {
      const pair = raw.split(";", 1)[0];
      if (pair.startsWith(`${name}=`) && pair.length > name.length + 1 && !/[\r\n\s]/.test(pair)) return pair;
    }
  }
  throw new Error("Sign-in returned no usable session. Your saved pairing has not been changed.");
}
