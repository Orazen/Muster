// Readers poll this fixture's receipt while the standalone child updates it.
// Hold the actual filesystem write after truncation to make CI's race exact,
// rather than relying on a high-iteration timing lottery or forgiving JSON.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const fakeSource = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
const methodsSchema = z.array(z.string());
const responseSchema = z.object({ id: z.number().optional() }).passthrough();

const preloadSource = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
const dump = process.env.FAKE_ACP_RPC_DUMP;
const marker = process.env.FAKE_TEST_MARKER;
const release = process.env.FAKE_TEST_RELEASE;
const mode = process.env.FAKE_TEST_MODE;
let intercepted = false;
fs.writeFileSync = (file, value, options) => {
  if (!intercepted && String(file).startsWith(dump) && (mode === "hold-write" || mode === "fail-write")) {
    intercepted = true;
    const opts = typeof options === "object" ? options : {};
    const fd = fs.openSync(file, opts?.flag ?? "w", opts?.mode ?? 0o666);
    try {
      if (mode === "fail-write") {
        fs.writeSync(fd, String(value).slice(0, 3));
        throw new Error("Owned injected RPC snapshot write failure");
      }
      originalWrite(marker, "write is open and truncated");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) throw new Error("Owned write barrier expired");
        Atomics.wait(wait, 0, 0, 10);
      }
      fs.writeSync(fd, String(value));
    } finally { fs.closeSync(fd); }
    return;
  }
  return originalWrite(file, value, options);
};
fs.renameSync = (from, to) => {
  if (mode === "fail-rename" && String(to) === dump) throw new Error("Owned injected RPC snapshot rename failure");
  return originalRename(from, to);
};
syncBuiltinESMExports();
`;

interface Fixture {
  child: ChildProcessWithoutNullStreams;
  responses: Set<number>;
  closed: Promise<void>;
  errors(): string;
  send(id: number, method: string): void;
}

describe("standalone fake ACP RPC snapshot publication", () => {
  let directory = "";
  let dump = "";
  let marker = "";
  let release = "";
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "muster-rpc-snapshot-"));
    dump = join(directory, "methods.json");
    marker = join(directory, "write-open");
    release = join(directory, "release-write");
  });
  afterEach(async () => {
    for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM", graceMs: 500 });
    await removeTempDir(directory);
  });

  function start(mode = ""): Fixture {
    // Copying exactly as onboarding does proves the fake needs no project imports.
    const fake = join(directory, "standalone-fake.ts");
    const preload = join(directory, "write-barrier.mjs");
    writeFileSync(fake, readFileSync(fakeSource));
    writeFileSync(preload, preloadSource);
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "--experimental-strip-types", fake], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: directory,
        USERPROFILE: directory,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        FAKE_ACP_MODE: "happy",
        FAKE_ACP_RPC_DUMP: dump,
        FAKE_TEST_MODE: mode,
        FAKE_TEST_MARKER: marker,
        FAKE_TEST_RELEASE: release,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    const responses = new Set<number>();
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = responseSchema.parse(JSON.parse(line));
        if (response.id !== undefined) responses.add(response.id);
      }
    });
    const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    return { child, responses, closed, errors: () => errors, send: (id, method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }) + "\n") };
  }

  async function until(fixture: Fixture, condition: () => boolean) {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (fixture.child.exitCode !== null || fixture.child.signalCode !== null || Date.now() > deadline) {
        throw new Error(`Owned fake did not reach expected write state: ${fixture.errors()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const readMethods = () => methodsSchema.parse(JSON.parse(readFileSync(dump, "utf8")));
  const stagingFiles = () => readdirSync(directory).filter((name) => name.startsWith("methods.json."));

  it("does not expose a first snapshot before its contents are complete", async () => {
    const fixture = start("hold-write");
    fixture.send(1, "initialize");
    await until(fixture, () => existsSync(marker));
    expect(existsSync(dump)).toBe(false);
    writeFileSync(release, "release");
    await until(fixture, () => fixture.responses.has(1));
    expect(readMethods()).toEqual(["initialize"]);
    expect(stagingFiles()).toEqual([]);
  });

  it("keeps the previous complete snapshot visible during a replacement write", async () => {
    writeFileSync(dump, JSON.stringify(["previous-complete"]));
    const fixture = start("hold-write");
    fixture.send(1, "initialize");
    await until(fixture, () => existsSync(marker));
    // This strict read is the exact reader that failed in onboarding beforeAll.
    expect(readMethods()).toEqual(["previous-complete"]);
    writeFileSync(release, "release");
    await until(fixture, () => fixture.responses.has(1));
    expect(readMethods()).toEqual(["initialize"]);
    fixture.send(2, "authenticate");
    await until(fixture, () => fixture.responses.has(2));
    expect(readMethods()).toEqual(["initialize", "authenticate"]);
    expect(stagingFiles()).toEqual([]);
  });

  it.each(["fail-write", "fail-rename"])("preserves the last receipt and removes staging after %s", async (mode) => {
    writeFileSync(dump, JSON.stringify(["previous-complete"]));
    const fixture = start(mode);
    fixture.send(1, "initialize");
    await fixture.closed;
    expect(fixture.child.exitCode).not.toBe(0);
    expect(fixture.errors()).toContain("Owned injected RPC snapshot");
    expect(readMethods()).toEqual(["previous-complete"]);
    expect(stagingFiles()).toEqual([]);
    expect(fixture.responses.size, "A failed receipt must not be silently acknowledged").toBe(0);
  });

  it("records the complete RPC order through a real standalone happy turn", async () => {
    const fixture = start();
    const methods = ["initialize", "authenticate", "session/new", "session/prompt"];
    for (const [index, method] of methods.entries()) {
      fixture.send(index + 1, method);
      await until(fixture, () => fixture.responses.has(index + 1));
      expect(readMethods()).toEqual(method === "session/prompt" ? [...methods, "session/prompt.result"] : methods.slice(0, index + 1));
    }
    expect(stagingFiles()).toEqual([]);
  });
});
