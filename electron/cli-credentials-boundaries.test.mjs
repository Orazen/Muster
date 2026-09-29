// Supplementary boundary tests for cli/credentials.mjs. The primary suite
// lives in cli/credentials.test.mjs and the CLI journeys in
// electron/cli-runtime.test.mjs; this file pins the hardening invariants
// neither covers: filesystem attack boundaries, terminal failure
// restoration, and secure-cookie downgrade rejection.
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { loadCliConfig, saveCliConfig, readPairPassword, sessionCookie } from "../cli/credentials.mjs";

const directories = [];
const posix = process.platform !== "win32";
function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(join(process.env.MUSTER_CREDENTIAL_TEST_ROOT || tmpdir(), "muster-cli-credentials-boundaries-")));
  directories.push(directory);
  return { directory, file: join(directory, "cli.json") };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("config filesystem boundaries", () => {
  it("rejects a nonregular config path instead of writing through it", () => {
    const { file } = fixture();
    fs.mkdirSync(file);
    assert.throws(() => loadCliConfig(file), /unreadable or unsafe/);
    assert.throws(() => saveCliConfig(file, { cookie: "new" }), /unreadable or unsafe/);
    assert.deepEqual(fs.readdirSync(file), []);
  });
  it.skipIf(!posix)("rejects a linked config and preserves the target bytes and mode", () => {
    const { directory, file } = fixture(), target = join(directory, "target");
    fs.writeFileSync(target, '{"cookie":"keep"}', { mode: 0o644 });
    for (const link of [fs.symlinkSync, fs.linkSync]) {
      link(target, file);
      assert.throws(() => loadCliConfig(file), /unreadable or unsafe/);
      assert.throws(() => saveCliConfig(file, { cookie: "new" }), /unreadable or unsafe/);
      assert.equal(fs.readFileSync(target, "utf8"), '{"cookie":"keep"}');
      assert.equal(fs.statSync(target).mode & 0o777, 0o644);
      fs.unlinkSync(file);
    }
  });
  it.skipIf(!posix)("rejects a linked or group-writable selected directory", () => {
    const { directory } = fixture();
    const target = join(directory, "target"), link = join(directory, "link");
    fs.mkdirSync(target); fs.symlinkSync(target, link);
    assert.throws(() => saveCliConfig(join(link, "cli.json"), { cookie: "new" }), /unreadable or unsafe/);
    assert.deepEqual(fs.readdirSync(target), []);
    fs.chmodSync(target, 0o770);
    assert.throws(() => saveCliConfig(join(target, "cli.json"), { cookie: "new" }), /unreadable or unsafe/);
  });
});

function terminal() {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; output.isTTY = true; input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  let shown = ""; output.on("data", (chunk) => { shown += chunk.toString(); });
  return { input, output, shown: () => shown };
}
describe("terminal restoration on failure", () => {
  it("restores terminal state after Ctrl-C", async () => {
    const tty = terminal(), result = readPairPassword([], tty);
    tty.input.write("fixture-secret\x03");
    await assert.rejects(result, /cancelled/);
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.shown(), "Password (hidden): \n");
  });
  it("restores the prior raw mode after EOF without a password", async () => {
    const tty = terminal(); tty.input.isRaw = true;
    const result = readPairPassword([], tty);
    tty.input.end();
    await assert.rejects(result, /ended before/);
    assert.equal(tty.input.isRaw, true);
  });
  it("restores terminal state without exposing an input error", async () => {
    const tty = terminal(), result = readPairPassword([], tty);
    tty.input.emit("error", new Error("fixture-secret"));
    await assert.rejects(result, (error) => error.message === "Could not read the password.");
    assert.equal(tty.input.isRaw, false);
    assert.ok(!tty.shown().includes("fixture-secret"));
  });
  it("does not print stream errors that could contain secrets", async () => {
    const input = new Readable({ read() { this.destroy(new Error("fixture-secret")); } });
    await assert.rejects(readPairPassword(["--password-stdin"], { input }), (error) => error.message === "Could not read the password from stdin.");
  });
});

describe("session-cookie downgrade rejection", () => {
  it("never accepts the secure cookie name over plain HTTP", () => {
    for (const cookie of ["__Secure-better-auth.session_token=value; Secure", "better-auth.session_token.evil=bad", "other=value", "better-auth.session_token=; Path=/", ""]) {
      const headers = new Headers(); if (cookie) headers.append("set-cookie", cookie);
      assert.throws(() => sessionCookie(headers, "http://127.0.0.1:54321"), /no usable session/);
    }
  });
});
