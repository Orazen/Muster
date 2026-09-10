// Input contracts and daemon control for the dependency-free CLI bundle.
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";

/** @typedef {{ pid: number, port: number, fingerprint?: string }} RunRecord */
/** @typedef {"matching" | "unreachable" | "mismatch"} ServerIdentity */

function objectInput(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This is the JSON boundary parser in the dependency-free CLI, not a substitute for a domain contract.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textInput(value, label, allowEmpty = false) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate primitive text at the JSON boundary before constructing model/domain values; no external parser dependency is installed by the CLI.
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${label} must be text`);
  return value;
}

function validRunTarget(value) {
  return objectInput(value) && Object.hasOwn(value, "pid") && Object.hasOwn(value, "port") &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2_147_483_647 &&
    Number.isSafeInteger(value.port) && value.port >= 1 && value.port <= 65_535;
}

/** @param {string} text @returns {RunRecord | null} */
export function parseRunRecord(text) {
  try {
    const value = JSON.parse(text);
    if (!validRunTarget(value)) return null;
    return { pid: value.pid, port: value.port, fingerprint: createHash("sha256").update(text).digest("hex") };
  } catch { return null; }
}

/** @param {string} path @returns {RunRecord | null} */
export function readRunRecordAt(path) {
  try { return parseRunRecord(readFileSync(path, "utf8")); }
  catch { return null; }
}

/** Preserve a newer record written while the stop operation was waiting.
 * The final read and unlink contain no await; this is not a cross-process lock.
 * @param {string} path @param {RunRecord | null} expected */
export function clearRunRecordAt(path, expected) {
  if (!expected?.fingerprint) return false;
  const current = readRunRecordAt(path);
  if (!current || current.fingerprint !== expected.fingerprint) return false;
  try { unlinkSync(path); return true; }
  catch { return false; }
}

/** @param {RunRecord} record @param {typeof fetch} request @returns {Promise<ServerIdentity>} */
export async function inspectRecordedServer(record, request = fetch) {
  if (!validRunTarget(record)) return "mismatch";
  try {
    const res = await request(`http://127.0.0.1:${record.port}/api/health`, { signal: AbortSignal.timeout(1_500), redirect: "error" });
    if (!res.ok) return "unreachable";
    const body = await res.json().catch(() => null);
    return objectInput(body) && body.app === "muster" && body.pid === record.pid ? "matching" : "mismatch";
  } catch { return "unreachable"; }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

/** @typedef {{
 * probe?: (record: RunRecord) => Promise<ServerIdentity>,
 * signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void,
 * exists?: (pid: number) => boolean,
 * now?: () => number,
 * wait?: (ms: number) => Promise<void>,
 * timeoutMs?: number,
 * forceTimeoutMs?: number
 * }} StopDependencies */

/** Only signal after this record's port identifies the same Muster PID.
 * Health failure is not proof of ownership or process exit. Escalation
 * requires a fresh identity match; success requires observing PID exit.
 * @param {RunRecord} record @param {StopDependencies} dependencies
 * @returns {Promise<{ stopped: boolean, forced: boolean, reason?: string }>} */
export async function stopRecordedServer(record, dependencies = {}) {
  if (!validRunTarget(record)) throw new Error("Invalid background Muster record");
  const {
    probe = inspectRecordedServer, signal = (pid, sig) => { process.kill(pid, sig); },
    exists = processExists, now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 10_000, forceTimeoutMs = 2_000,
  } = dependencies;
  const initial = await probe(record);
  if (initial !== "matching") {
    // An absent PID needs no signal and lets a stale crash/reboot record be cleared.
    if (!exists(record.pid)) return { stopped: true, forced: false };
    return { stopped: false, forced: false, reason: initial === "mismatch"
      ? "The saved port does not identify the recorded Muster process."
      : "The recorded Muster process could not be verified because its health endpoint is unavailable." };
  }
  try { signal(record.pid, "SIGTERM"); }
  catch (error) {
    if (error?.code === "ESRCH") return { stopped: true, forced: false };
    throw new Error("Could not send the stop signal to the verified Muster process.", { cause: error });
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!exists(record.pid)) return { stopped: true, forced: false };
    const identity = await probe(record);
    if (identity === "mismatch") return { stopped: false, forced: false, reason: "The port changed to a different process while Muster was stopping." };
    await wait(200);
  }
  if (!exists(record.pid)) return { stopped: true, forced: false };
  if (await probe(record) !== "matching") {
    return { stopped: false, forced: false, reason: "Muster has not exited and its identity can no longer be verified. No force-stop was sent." };
  }
  try { signal(record.pid, "SIGKILL"); }
  catch (error) {
    if (error?.code === "ESRCH") return { stopped: true, forced: true };
    throw new Error("Could not force-stop the verified Muster process.", { cause: error });
  }
  const forcedDeadline = now() + forceTimeoutMs;
  while (exists(record.pid) && now() < forcedDeadline) await wait(100);
  if (exists(record.pid)) return { stopped: false, forced: true, reason: "The stop signal was sent, but process exit could not be confirmed." };
  return { stopped: true, forced: true };
}

function modelOptions(value) {
  if (!Array.isArray(value)) throw new Error("Engine model options must be a list");
  return value.map((option) => {
    if (objectInput(option)) {
      const id = textInput(option.id, "Model ID");
      return { id, label: option.label === undefined ? id : textInput(option.label, "Model label", true) };
    }
    const id = textInput(option, "Model ID");
    return { id, label: id };
  });
}

/** Parse the /api/instances response before interactive setup uses it. */
export function parseSetupInstances(payload) {
  if (!objectInput(payload) || !Array.isArray(payload.instances)) throw new Error("Muster returned an unreadable engine list");
  return payload.instances.map((instance) => {
    if (!objectInput(instance)) throw new Error("Muster returned an unreadable engine");
    const instanceId = textInput(instance.instanceId, "Engine ID");
    const displayName = textInput(instance.displayName, "Engine name");
    const driverKind = textInput(instance.driverKind, "Engine driver");
    let state;
    if (instance.snapshot !== undefined && instance.snapshot !== null) {
      if (!objectInput(instance.snapshot)) throw new Error("Engine status must be an object");
      state = textInput(instance.snapshot.state, "Engine status");
    }
    let model = "", options = [];
    if (instance.models !== undefined && instance.models !== null) {
      if (!objectInput(instance.models)) throw new Error("Engine models must be an object");
      if (instance.models.default !== undefined && instance.models.default !== null) model = textInput(instance.models.default, "Default model", true);
      options = modelOptions(instance.models.options ?? []);
    }
    return { instanceId, displayName, driverKind, state, models: { default: model, options } };
  });
}
