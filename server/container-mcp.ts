// Transparent stdio bridge into Cua Driver's official MCP server inside the
// Local VM. This process defines no tools and parses no MCP messages —
// piping, drain-safe exit, and the who-is-driving gate live in mcp-bridge.ts,
// shared with every other computer entry point.
import { runMcpBridge, type BridgeOptions } from "./mcp-bridge.ts";

const [runtime, container, socket] = process.argv.slice(2);
if (!runtime || !["docker", "podman", "container"].includes(runtime)) {
  process.stderr.write("invalid Local VM runtime\n");
  process.exit(2);
}
if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container) || !socket?.startsWith("/run/user/1000/")) {
  process.stderr.write("invalid Local VM connection\n");
  process.exit(2);
}

// The who-is-driving pair rides in env, not argv — argv is world-readable
// through `ps`, and the token guards a loopback endpoint. Absent → the
// bridge stays fully transparent (no harness control configured).
const controlUrl = process.env.MUSTER_CONTROL_URL ?? "";
const controlToken = process.env.MUSTER_CONTROL_TOKEN ?? "";

const bridge: BridgeOptions = {
  command: runtime,
  args: [
    "exec",
    "-i",
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    "DISPLAY=:1",
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    container,
    "/usr/local/libexec/muster/cua-driver",
    "mcp",
    "--socket",
    socket,
  ],
  label: "Cua Driver",
  // The Local VM's runtime CLI talks to a local daemon and fails fast on
  // its own, so no dead-transport watchdog here.
};
if (controlUrl && controlToken) bridge.gate = { url: controlUrl, token: controlToken };
runMcpBridge(bridge);
