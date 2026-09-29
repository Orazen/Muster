import { afterEach, describe, expect, it } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConfig, readPairPassword, rejectPasswordArgument, saveCliConfig, sessionCookie } from "./credentials.mjs";

const posix = process.platform !== "win32";
const unreadable = "Pairing config is unreadable or unsafe";
const directories = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), "muster-credentials-fixture-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const config = (home) => join(home, "cli.json");
const seed = (home, value) => { writeFileSync(config(home), JSON.stringify(value)); return config(home); };

function stdin(text) {
  return Readable.from([Buffer.from(text, "utf8")]);
}

const terminal = () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  return { input, output };
};

describe("pairing config reads", () => {
  it("returns nothing before a first pair instead of failing", () => {
    expect(loadCliConfig(config(directory()))).toEqual({});
  });

  it("round trips a pairing and merges later keys without losing earlier ones", () => {
    const home = directory();
    saveCliConfig(config(home), { base: "http://127.0.0.1:8799", cookie: "session.signature" });
    saveCliConfig(config(home), { cloudEmail: "owner@example.test" });
    expect(loadCliConfig(config(home))).toEqual({
      base: "http://127.0.0.1:8799",
      cookie: "session.signature",
      cloudEmail: "owner@example.test",
    });
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"session"'],
    ["an empty file", ""],
  ])("refuses %s instead of pairing with a value it did not write", (_label, body) => {
    const home = directory();
    writeFileSync(config(home), body);
    expect(() => loadCliConfig(config(home))).toThrow(unreadable);
  });

  it("refuses a config larger than the bound it will read", () => {
    const home = directory();
    writeFileSync(config(home), JSON.stringify({ blob: "x".repeat(130 * 1024) }));
    expect(() => loadCliConfig(config(home))).toThrow(unreadable);
  });

  it.skipIf(!posix)("creates the directory owner-only and the file owner-only even under a permissive umask", () => {
    const home = directory();
    const previous = process.umask(0);
    try {
      saveCliConfig(config(home), { cookie: "session.signature" });
    } finally {
      process.umask(previous);
    }
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(config(home)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("tightens a file an older CLI left group- or world-readable", () => {
    const home = directory();
    const path = seed(home, { cookie: "session.signature" });
    chmodSync(path, 0o644);
    expect(loadCliConfig(path)).toEqual({ cookie: "session.signature" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("refuses a directory another user could write into", () => {
    const home = directory();
    seed(home, { cookie: "session.signature" });
    chmodSync(home, 0o770);
    expect(() => loadCliConfig(config(home))).toThrow(unreadable);
  });

  it.skipIf(!posix)("refuses a config that is a link to another file", () => {
    const home = directory();
    const elsewhere = join(home, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ cookie: "attacker.signature" }));
    symlinkSync(elsewhere, config(home));
    expect(() => loadCliConfig(config(home))).toThrow(unreadable);
    expect(() => saveCliConfig(config(home), { cookie: "session.signature" })).toThrow(unreadable);
    expect(readFileSync(elsewhere, "utf8")).toBe(JSON.stringify({ cookie: "attacker.signature" }));
  });

  it.skipIf(!posix)("refuses a config with a second hard link, where a write would change both", () => {
    const home = directory();
    seed(home, { cookie: "session.signature" });
    linkSync(config(home), join(home, "second-name.json"));
    expect(() => loadCliConfig(config(home))).toThrow(unreadable);
    expect(() => saveCliConfig(config(home), { cookie: "replacement.signature" })).toThrow(unreadable);
  });

  it.skipIf(!posix)("refuses a config directory reached through a link", () => {
    const home = directory();
    const real = join(home, "real");
    const linked = join(home, "linked");
    mkdirSync(real, { mode: 0o700 });
    seed(real, { cookie: "session.signature" });
    symlinkSync(real, linked);
    expect(() => loadCliConfig(join(linked, "cli.json"))).toThrow(unreadable);
  });
});

describe("pairing config writes", () => {
  it("refuses a patch that is not a record", () => {
    const home = directory();
    expect(() => saveCliConfig(config(home), ["cookie"])).toThrow(unreadable);
    expect(() => saveCliConfig(config(home), "session.signature")).toThrow(unreadable);
  });

  it("keeps the earlier pairing when a write cannot be serialised", () => {
    const home = directory();
    saveCliConfig(config(home), { base: "http://127.0.0.1:8799", cookie: "session.signature" });
    const before = readFileSync(config(home), "utf8");
    const patch = { cookie: "next.signature" };
    patch.self = patch;
    expect(() => saveCliConfig(config(home), patch)).toThrow();
    expect(readFileSync(config(home), "utf8")).toBe(before);
    expect(readdirSync(home)).toEqual(["cli.json"]);
  });

  it("keeps a config another writer replaced, rather than overwriting it", () => {
    const home = directory();
    saveCliConfig(config(home), { base: "http://127.0.0.1:8799", cookie: "session.signature" });
    const replacement = JSON.stringify({ base: "http://127.0.0.1:8800", cookie: "newer-writer.signature" });
    const patch = { cookie: "session.signature" };
    Object.defineProperty(patch, "base", { enumerable: true, get: () => { writeFileSync(config(home), replacement); return "http://127.0.0.1:8799"; } });
    expect(() => saveCliConfig(config(home), patch)).toThrow(unreadable);
    expect(readFileSync(config(home), "utf8")).toBe(replacement);
    expect(readdirSync(home)).toEqual(["cli.json"]);
  });

  it("refuses a pairing that would grow past the bound it can read back", () => {
    const home = directory();
    saveCliConfig(config(home), { blob: "x".repeat(126 * 1024) });
    expect(() => saveCliConfig(config(home), { cookie: "y".repeat(8 * 1024) })).toThrow(unreadable);
    expect(loadCliConfig(config(home)).blob).toHaveLength(126 * 1024);
  });
});

describe("pairing password entry", () => {
  it("refuses a password passed as a command argument", () => {
    expect(() => rejectPasswordArgument(["--email", "owner@example.test", "--password", "secret"])).toThrow(/not supported/);
    expect(() => rejectPasswordArgument(["--password=secret"])).toThrow(/not supported/);
    expect(() => rejectPasswordArgument(["--email", "owner@example.test", "--password-stdin"])).not.toThrow();
    expect(() => rejectPasswordArgument(["--email", "owner@example.test"])).not.toThrow();
  });

  it("reads one line from a secret manager without a terminal", async () => {
    const input = stdin("synthetic-fixture-password\n");
    expect(await readPairPassword(["--password-stdin"], { input, output: { isTTY: false, write() {} } })).toBe("synthetic-fixture-password");
  });

  it("refuses a scripted pairing with no way to supply the password", async () => {
    const input = stdin("secret\n");
    await expect(readPairPassword([], { input, output: { isTTY: false, write() {} } })).rejects.toThrow(/terminal is required/);
  });

  it.each([
    ["an empty line", "\n"],
    ["two lines", "first\nsecond\n"],
    ["an embedded newline", "first\nsecond"],
  ])("refuses %s from stdin", async (_label, body) => {
    await expect(readPairPassword(["--password-stdin"], { input: stdin(body), output: { isTTY: false, write() {} } })).rejects.toThrow(/nonempty password line/);
  });

  it("accepts a password of spaces, which some local accounts do have", async () => {
    await expect(readPairPassword(["--password-stdin"], { input: stdin("   \n"), output: { isTTY: false, write() {} } })).resolves.toBe("   ");
  });

  it("refuses input past the bound it accepts", async () => {
    await expect(readPairPassword(["--password-stdin"], { input: stdin(`${"x".repeat(4097)}\n`), output: { isTTY: false, write() {} } })).rejects.toThrow(/at most 4096 bytes/);
    await expect(readPairPassword(["--password-stdin"], { input: stdin(`${"x".repeat(20 * 1024)}\n`), output: { isTTY: false, write() {} } })).rejects.toThrow(/too long/);
  });

  it("keeps the terminal prompt off the value and restores the previous mode", async () => {
    const { input, output } = terminal();
    const previous = input.isRaw;
    const reading = readPairPassword([], { input, output });
    input.write("synthetic-fixture-password\n");
    expect(await reading).toBe("synthetic-fixture-password");
    const shown = output.read()?.toString("utf8") ?? "";
    expect(shown).toContain("Password (hidden): ");
    expect(shown).not.toContain("synthetic-fixture-password");
    expect(input.isRaw).toBe(previous);
  });
});

describe("session cookie selection", () => {
  const headers = (...cookies) => ({ getSetCookie: () => cookies });

  it("takes the plain session cookie over plain HTTP", () => {
    expect(sessionCookie(headers("better-auth.session_token=local.signature; Path=/; HttpOnly"), "http://127.0.0.1:8799")).toBe("better-auth.session_token=local.signature");
  });

  it("prefers the prefixed cookie a TLS origin sets", () => {
    const reply = headers("better-auth.session_token=plain.signature; Path=/", "__Secure-better-auth.session_token=secure.signature; Path=/");
    expect(sessionCookie(reply, "https://muster.example")).toBe("__Secure-better-auth.session_token=secure.signature");
  });

  it("returns exactly one cookie, without attributes", () => {
    const reply = headers("better-auth.session_token=local.signature; Path=/; HttpOnly; SameSite=Lax", "better-auth.session_token=second.signature; Path=/");
    expect(sessionCookie(reply, "http://127.0.0.1:8799")).toBe("better-auth.session_token=local.signature");
  });

  it.each([
    ["no cookies at all", []],
    ["an unrelated cookie only", ["theme=dark; Path=/"]],
    ["an empty session value", ["better-auth.session_token=; Path=/"]],
    ["a value carrying a line break", ["better-auth.session_token=local.signature\r\nSet-Cookie: x=y"]],
  ])("refuses a sign-in reply with %s", (_label, cookies) => {
    expect(() => sessionCookie(headers(...cookies), "https://muster.example")).toThrow(/no usable session/);
  });
});
