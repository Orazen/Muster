/** Test-child preload: runtime discovery must never initialize host container
 * storage. A temporary HOME and a network mock do not isolate native CLIs.
 * Keep this out of production; pairingServerEnvironment opts fixture children
 * and their Node descendants in explicitly. Browser VM behavior is mocked,
 * and container unit tests exercise their injected CommandRunner separately. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runtimes = new Set(["docker", "podman", "container"]);
const name = (file) => basename(file).replace(/\.exe$/i, "").toLowerCase();
// Delegate to the native API with an absent executable: callers receive the
// real callback/ChildProcess/sync/promisified ENOENT shape, not a partial mock.
const unavailable = fileURLToPath(new URL("./__disabled_host_containers__/unavailable", import.meta.url));
function isolate(args) {
  const command = name(args[0]);
  const discovery = ["which", "where"].includes(command) && Array.isArray(args[1])
    && args[1].some((arg) => runtimes.has(name(arg)));
  return runtimes.has(command) || discovery ? [unavailable, ...args.slice(1)] : args;
}

for (const method of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original = childProcess[method];
  const wrapped = (...args) => original(...isolate(args));
  if (method === "execFile") {
    const originalPromise = promisify(original);
    Object.defineProperty(wrapped, promisify.custom, {
      value: (...args) => originalPromise(...isolate(args)),
    });
  }
  childProcess[method] = wrapped;
}
syncBuiltinESMExports();
