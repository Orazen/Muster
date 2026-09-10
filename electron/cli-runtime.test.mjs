import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clearRunRecordAt, inspectRecordedServer, parseRunRecord, parseSetupInstances, readRunRecordAt, stopRecordedServer } from "../cli/runtime-contracts.mjs";

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL("../cli/muster.mjs", import.meta.url));
const directories = [];
const children = [];
const record = { pid: 24680, port: 54321 };

function directory() {
  const path = mkdtempSync(join(tmpdir(), "muster-cli-fixture-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL"); // Only children created by this test file.
      await exited;
    }
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function clock() {
  let time = 0;
  return { now: () => time, wait: async (ms) => { time += ms; } };
}

describe("CLI run records", () => {
  it.each([null, [], {}, { pid: 0, port: 80 }, { pid: -1, port: 80 }, { pid: 2.5, port: 80 },
    { pid: "2", port: 80 }, { pid: 2_147_483_648, port: 80 }, { pid: 2, port: 0 },
    { pid: 2, port: 65_536 }, { pid: 2, port: "80" }, { pid: 2, port: 80.5 }])("rejects invalid process targets: %j", (value) => {
    expect(parseRunRecord(JSON.stringify(value))).toBeNull();
  });

  it("rejects damaged JSON and accepts bounded PID/port records", () => {
    expect(parseRunRecord("{broken")).toBeNull();
    expect(parseRunRecord(JSON.stringify(record))).toMatchObject(record);
    expect(parseRunRecord('{"pid":2147483647,"port":65535}')).toMatchObject({ pid: 2_147_483_647, port: 65_535 });
  });

  it("preserves replacements, including same-PID records with a new start marker", () => {
    const path = join(directory(), "run.json");
    writeFileSync(path, JSON.stringify({ ...record, started: "first" }));
    const old = readRunRecordAt(path);
    const replacement = JSON.stringify({ ...record, started: "second" });
    writeFileSync(path, replacement);
    expect(clearRunRecordAt(path, old)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(clearRunRecordAt(path, readRunRecordAt(path))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("does not unlink unreadable or unverified records", () => {
    const path = join(directory(), "run.json");
    writeFileSync(path, "{broken");
    expect(readRunRecordAt(path)).toBeNull();
    expect(clearRunRecordAt(path, null)).toBe(false);
    expect(clearRunRecordAt(path, record)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });
});

describe("CLI health identity", () => {
  it("requires the recorded app and PID, and refuses redirects", async () => {
    const request = vi.fn(async () => Response.json({ app: "muster", pid: record.pid }));
    expect(await inspectRecordedServer(record, request)).toBe("matching");
    expect(request).toHaveBeenCalledWith(`http://127.0.0.1:${record.port}/api/health`, { redirect: "error", signal: expect.any(AbortSignal) });
  });

  it.each([{ app: "other", pid: record.pid }, { app: "muster", pid: record.pid + 1 },
    { app: "muster", pid: String(record.pid) }, { app: "muster" }, null, []])("rejects a different or unreadable identity: %j", async (body) => {
    expect(await inspectRecordedServer(record, async () => Response.json(body))).toBe("mismatch");
  });

  it("distinguishes transport failure from an unreadable successful response", async () => {
    expect(await inspectRecordedServer(record, async () => { throw new Error("offline"); })).toBe("unreachable");
    expect(await inspectRecordedServer(record, async () => new Response("busy", { status: 503 }))).toBe("unreachable");
    expect(await inspectRecordedServer(record, async () => new Response("broken json"))).toBe("mismatch");
  });

  it("rejects an invalid target before making a request", async () => {
    const request = vi.fn();
    expect(await inspectRecordedServer({ pid: -1, port: 80 }, request)).toBe("mismatch");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("CLI daemon stop", () => {
  it.each(["mismatch", "unreachable"])("does not signal an existing unverified PID: %s", async (identity) => {
    const signal = vi.fn();
    const result = await stopRecordedServer(record, { signal, probe: async () => identity, exists: () => true });
    expect(result.stopped).toBe(false);
    expect(signal).not.toHaveBeenCalled();
  });

  it("allows stale-record cleanup once the PID is confirmed absent, without a signal", async () => {
    const signal = vi.fn();
    expect(await stopRecordedServer(record, { signal, probe: async () => "unreachable", exists: () => false })).toEqual({ stopped: true, forced: false });
    expect(signal).not.toHaveBeenCalled();
  });

  it("rejects a process-group PID before probes or signals", async () => {
    const probe = vi.fn(), signal = vi.fn(), exists = vi.fn();
    await expect(stopRecordedServer({ pid: 0, port: 80 }, { probe, signal, exists })).rejects.toThrow("Invalid background");
    expect(probe).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it("observes graceful exit after verified SIGTERM", async () => {
    const signal = vi.fn();
    expect(await stopRecordedServer(record, { signal, probe: async () => "matching", exists: () => false })).toEqual({ stopped: true, forced: false });
    expect(signal).toHaveBeenCalledExactlyOnceWith(record.pid, "SIGTERM");
  });

  it("does not treat failed health as process exit or permission to force-stop", async () => {
    const probe = vi.fn().mockResolvedValueOnce("matching").mockResolvedValue("unreachable");
    const signal = vi.fn();
    const result = await stopRecordedServer(record, { ...clock(), probe, signal, exists: () => true, timeoutMs: 400 });
    expect(result).toMatchObject({ stopped: false, forced: false });
    expect(signal).toHaveBeenCalledExactlyOnceWith(record.pid, "SIGTERM");
  });

  it("stops escalating when another process takes the port", async () => {
    const signal = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce("matching").mockResolvedValue("mismatch");
    expect(await stopRecordedServer(record, { ...clock(), probe, signal, exists: () => true })).toMatchObject({ stopped: false, forced: false });
    expect(signal).toHaveBeenCalledExactlyOnceWith(record.pid, "SIGTERM");
  });

  it("requires a fresh identity before SIGKILL and observes forced exit", async () => {
    let alive = true;
    const sequence = [];
    const signal = (pid, sig) => { sequence.push(sig); expect(pid).toBe(record.pid); if (sig === "SIGKILL") alive = false; };
    const probe = async () => { sequence.push("probe"); return "matching"; };
    expect(await stopRecordedServer(record, { ...clock(), probe, signal, exists: () => alive, timeoutMs: 200 })).toEqual({ stopped: true, forced: true });
    expect(sequence).toEqual(["probe", "SIGTERM", "probe", "probe", "SIGKILL"]);
  });

  it("does not report success when process exit cannot be confirmed after force-stop", async () => {
    const signal = vi.fn();
    expect(await stopRecordedServer(record, { ...clock(), probe: async () => "matching", signal, exists: () => true, timeoutMs: 200, forceTimeoutMs: 200 })).toMatchObject({ stopped: false, forced: true });
    expect(signal).toHaveBeenCalledTimes(2);
  });

  it("treats ESRCH as exited but surfaces permission failures", async () => {
    const probe = async () => "matching";
    expect(await stopRecordedServer(record, { probe, signal: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } })).toEqual({ stopped: true, forced: false });
    await expect(stopRecordedServer(record, { probe, signal: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } })).rejects.toThrow("Could not send the stop signal");
  });
});

const engine = { instanceId: "fixture", displayName: "Fixture engine", driverKind: "codex", snapshot: { state: "available" } };
describe("CLI engine list boundary", () => {
  it("supports current object models and legacy string IDs without coercing bad data", () => {
    expect(parseSetupInstances({ instances: [{ ...engine, models: { default: "model-a", options: ["model-a", { id: "model-b", label: "Model B" }, { id: "model-c" }] } }] })).toEqual([
      { instanceId: "fixture", displayName: "Fixture engine", driverKind: "codex", state: "available", models: { default: "model-a", options: [{ id: "model-a", label: "model-a" }, { id: "model-b", label: "Model B" }, { id: "model-c", label: "model-c" }] } },
    ]);
  });

  it("accepts an empty list and engines without a snapshot or model choice", () => {
    expect(parseSetupInstances({ instances: [] })).toEqual([]);
    expect(parseSetupInstances({ instances: [{ ...engine, snapshot: null }] })[0]).toMatchObject({ state: undefined, models: { default: "", options: [] } });
  });

  it.each([null, [], {}, { instances: {} }, { instances: [null] }, { instances: [{ ...engine, instanceId: 4 }] },
    { instances: [{ ...engine, snapshot: { state: 4 } }] }, { instances: [{ ...engine, models: { default: 4 } }] },
    { instances: [{ ...engine, models: { options: {} } }] }, { instances: [{ ...engine, models: { options: [{}] } }] },
    { instances: [{ ...engine, models: { options: [null] } }] }, { instances: [{ ...engine, models: { options: [{ id: "ok", label: 42 }] } }] },
  ])("rejects malformed engine responses: %j", (payload) => {
    expect(() => parseSetupInstances(payload)).toThrow();
  });
});

async function fixtureServer(app = "muster") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:http';
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ app: process.argv[1], pid: process.pid }));
    });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
  `, app], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const [port] = await once(child, "message");
  const home = directory();
  mkdirSync(join(home, "run"));
  const path = join(home, "run", "up.json");
  writeFileSync(path, JSON.stringify({ pid: child.pid, port }));
  return { child, path, home };
}

describe("CLI command integration with owned fixture processes", () => {
  it("stops its matching fixture and removes only its run record", async () => {
    const { child, path, home } = await fixtureServer();
    const exited = once(child, "exit");
    const result = await run(process.execPath, [cliPath, "stop"], { env: { ...process.env, MUSTER_DIR: home }, timeout: 5000 });
    await exited;
    expect(result.stdout).toContain(`Stopped Muster (PID ${child.pid}`);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to stop another app and preserves its record and process", async () => {
    const { child, path, home } = await fixtureServer("fixture-other-app");
    const before = readFileSync(path, "utf8");
    await expect(run(process.execPath, [cliPath, "stop"], { env: { ...process.env, MUSTER_DIR: home }, timeout: 5000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("does not identify the recorded Muster process") });
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(["up", "setup"])("does not replace an unverified run record during %s", async (command) => {
    const home = directory();
    mkdirSync(join(home, "run"));
    const path = join(home, "run", "up.json");
    writeFileSync(path, "{unreadable");
    await expect(run(process.execPath, [cliPath, command], { env: { ...process.env, MUSTER_DIR: home }, timeout: 5000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("could not be verified") });
    expect(readFileSync(path, "utf8")).toBe("{unreadable");
  });

  it("refuses malformed stop records without reporting success", async () => {
    const home = directory();
    mkdirSync(join(home, "run"));
    writeFileSync(join(home, "run", "up.json"), '{"pid":0,"port":80}');
    await expect(run(process.execPath, [cliPath, "stop"], { env: { ...process.env, MUSTER_DIR: home }, timeout: 5000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("No stop signal was sent") });
  });
});
