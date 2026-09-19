#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_MODE   happy (default) | empty-reply | exit-early | hang | no-auth | auth-required | permission
//                   | permission-gated (reply only after the exact allow-once
//                     response; any other decision produces a denied reply)
//                   | rehearsal-gated (state an explicit two-tool plan before
//                     permission, then emit matching successes only if allowed)
//                   | die-midturn (engine exits code 9 mid-prompt while a
//                     grandchild holds stdio open — the pipe-held crash the
//                     liveness reaper exists for)
//                   | quota-error (fail session/prompt with an explicit HTTP 429 quota error)
//                   | quota-after-progress (emit a tool call, then the quota error)
//                   | fallback-healthy (happy, except explicit FAKE_FALLBACK_HANG prompt holds)
//                   | no-session-config (reject session/set_mode + set_model
//                     with -32601, i.e. an agent predating those methods)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | delegate-peer (same as ask-peer but uses delegate_bot —
//                     returns immediately, the peer runs after our turn)
//                   | echo-gated (reply by echoing the full prompt, and when
//                     FAKE_ACP_GATE_FILE is set hold the turn open until that
//                     file exists — a deterministic busy window for the
//                     steer-queue e2e, with the echo pinning exactly what a
//                     drained turn was sent)
//                   | peer-capability (hold a real prompt until the owned
//                     <pid>.release file exists in FAKE_ACP_PEER_DIRECTORY)
//   FAKE_ACP_PEER_DIRECTORY  explicit owned directory for private per-process
//                     MCP credential receipts and prompt/terminal markers
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_MODELS      comma-separated model ids. Enables the opencode-shaped
//                        surface: session/new and session/load return
//                        configOptions, and session/set_config_option switches
//                        the model (rejecting an unadvertised one with -32602).
//   FAKE_ACP_MODEL_STICKS  session/set_config_option succeeds but leaves the
//                        model where it was, so the confirmation guard in
//                        core.ts has something to catch
//   FAKE_ACP_SESSION_MODE  advertise an initial mode in configOptions;
//                        FAKE_ACP_MODE_STICKS ignores requested mode changes
//   FAKE_ACP_MODE_RESETS_MODEL  a mode change restores the first model
//   FAKE_ACP_MODEL_RESETS_MODE  a model change restores auto-approve mode
//   sparse-permission     permission mode with metadata in a prior tool_call
//                        update and only its id in the permission callback
//   FAKE_ACP_USAGE_ROOT  put the prompt result's usage at the root instead of
//                        under _meta (what opencode 1.18.18 actually does)
//   FAKE_ACP_PERMISSION_DUMP  optional path for the actual permission outcome
//                        received in either gated mode (JSON, not inferred
//                        from the visible reply)
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
// opencode-shaped surface: the session carries its own model catalog and the
// model is chosen with session/set_config_option, because `opencode acp` takes
// no -m. Off unless FAKE_ACP_MODELS is set, so every existing mode is byte-
// identical to before.
const models = (process.env.FAKE_ACP_MODELS ?? "").split(",").filter(Boolean);
let currentModel: string | null = models[0] ?? null;
let currentMode = process.env.FAKE_ACP_SESSION_MODE ?? "default";
const configOptions = () =>
  models.length
    ? [
        ...(process.env.FAKE_ACP_SESSION_MODE ? [{ id: "mode", currentValue: currentMode }] : []),
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: models.map((value) => ({ value, name: value })),
        },
      ]
    : null;
const argv = process.argv.slice(2);
// FAKE_ACP_PIDFILE  path to write this process's pid, so a test can kill
//                   the engine externally mid-turn (liveness reaper e2e)
if (process.env.FAKE_ACP_PIDFILE) writeFileSync(process.env.FAKE_ACP_PIDFILE, String(process.pid));
if (process.env.FAKE_ACP_DUMP) {
  const dumpEnv = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SystemRoot",
      "FAKE_ACP_MODE",
      "FAKE_ACP_RPC_DUMP",
      "TEST_POLICY",
      "OPENCODE_API_KEY",
      "OPENAI_API_KEY",
      "MISTRAL_API_KEY",
      "VIBE_HOME",
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "XAI_API_KEY",
      "UNSLOTH_STUDIO_AUTH_TOKEN",
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
  );
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: dumpEnv }, null, 2));
}
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}

const out = <M>(obj: M) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = <I, R>(id: I, res: R) => out({ jsonrpc: "2.0", id, result: res });
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_ACP_RPC_DUMP) writeFileSync(process.env.FAKE_ACP_RPC_DUMP, JSON.stringify(rpcMethods));
};

// session/set_mode + session/set_model calls seen this run
const configCalls: Array<{ method: string; params: unknown }> = [];

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: ((allowOnce: boolean) => void) | null = null;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { name?: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;
const peerDirectory = process.env.FAKE_ACP_PEER_DIRECTORY;
type PeerReceipt = { pid: number; method: "session/new" | "session/load"; servers: McpEntry[] } |
  { pid: number; received: true } | { pid: number; completed: true } | { pid: number; canceled: number };
let peerCancelCount = 0;
const peerReceipt = (suffix: string, value: PeerReceipt) => {
  if (peerDirectory) writeFileSync(join(peerDirectory, `${process.pid}.${suffix}`), JSON.stringify(value), { mode: 0o600 });
};

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = <M>(obj: M) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

/** True only for primitive strings — the ACP wire contract for id fields. */
const isText = <T>(value: T): value is T & string => String(value) === value;

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    const answered = onPermissionAnswered;
    onPermissionAnswered = null;
    const outcome = msg.result?.outcome;
    if ((mode === "permission-gated" || mode === "rehearsal-gated") && process.env.FAKE_ACP_PERMISSION_DUMP) {
      writeFileSync(process.env.FAKE_ACP_PERMISSION_DUMP, JSON.stringify(outcome ?? null), { mode: 0o600 });
    }
    answered?.(outcome?.outcome === "selected" && outcome?.optionId === "allow-once");
    return;
  }
  if (!msg.method) return;
  recordMethod(msg.method);

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: "cached_token" }];
      result(msg.id, { protocolVersion: 1, authMethods, _meta: { modelState: { currentModelId: "fake-acp-model" } } });
      break;
    }
    case "authenticate":
      result(msg.id, {});
      break;
    case "session/new": {
      if (mode === "auth-required") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required", data: { providerId: "opencode-go" } },
        });
        break;
      }
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = servers.find((s) => s.name === "agents") ?? null;
      peerReceipt("session.json", { pid: process.pid, method: "session/new", servers });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(servers, null, 2));
      }
      const opts = configOptions();
      result(msg.id, opts ? { sessionId: "fake-acp-session", configOptions: opts } : { sessionId: "fake-acp-session" });
      break;
    }
    case "session/load": {
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      if (peerDirectory) agentsMcp = servers.find((s) => s.name === "agents") ?? null;
      peerReceipt("session.json", { pid: process.pid, method: "session/load", servers });
      const opts = configOptions();
      result(msg.id, opts ? { configOptions: opts } : {});
      break;
    }
    // per-session settings (droid sets model/autonomy here, not via argv).
    // Recorded next to FAKE_ACP_DUMP so a test can assert what was applied.
    // NOTE: last writer wins — each turn spawns a fresh child, so a two-turn
    // test would only ever see the final turn's calls.
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        // an older agent that predates these methods
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      const settingId = msg.method === "session/set_mode" ? "modeId" : "modelId";
      if (!isText(msg.params?.sessionId) || !isText(msg.params?.[settingId])) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: sessionId and ${settingId} must be strings` },
        });
        break;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      result(msg.id, {});
      break;
    }
    case "session/set_config_option": {
      const { configId, value } = msg.params ?? {};
      if (configId === "mode" && process.env.FAKE_ACP_SESSION_MODE) {
        if (!process.env.FAKE_ACP_MODE_STICKS) currentMode = value;
        if (process.env.FAKE_ACP_MODE_RESETS_MODEL) currentModel = models[0] ?? null;
        result(msg.id, { configOptions: configOptions() });
        break;
      }
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      // FAKE_ACP_MODEL_STICKS: answer OK and keep the old model anyway. Nothing
      // in the protocol forbids it, and it is the shape core.ts's confirmation
      // guard exists for — an error is loud, this is silent.
      if (!process.env.FAKE_ACP_MODEL_STICKS) currentModel = value;
      if (process.env.FAKE_ACP_MODEL_RESETS_MODE) currentMode = "auto-approve";
      result(msg.id, { configOptions: configOptions() });
      break;
    }
    case "session/prompt": {
      peerReceipt("prompt.json", { pid: process.pid, received: true });
      if (mode === "quota-error" || mode === "quota-after-progress") {
        if (mode === "quota-after-progress") {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "quota-progress", title: "Owned work already started" } } });
        }
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "HTTP429 quota exceeded" } });
        return;
      }
      if (mode === "hang" || (mode === "fallback-healthy" && String(msg.params?.prompt?.[0]?.text ?? "").includes("FAKE_FALLBACK_HANG"))) {
        // never resolve the prompt — lets tests exercise interrupt
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "die-midturn") {
        // Simulates the crash the liveness reaper exists for: the engine
        // dies mid-turn, but a grandchild inherits stdout/stderr, so the
        // client sees neither a result nor an EOF — no close event ever
        // fires and the driver hangs. The grandchild's pid is journalled
        // so the test can reap it.
        const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
          stdio: ["ignore", process.stdout, process.stderr],
        });
        if (process.env.FAKE_ACP_PIDFILE) {
          writeFileSync(`${process.env.FAKE_ACP_PIDFILE}.gc`, String(gc.pid));
        }
        gc.unref();
        process.exit(9);
      }
      const complete = () => {
        peerReceipt("completed.json", { pid: process.pid, completed: true });
        recordMethod("session/prompt.result");
        result(
          msg.id,
          // FAKE_ACP_USAGE_ROOT reproduces opencode 1.18.18's shape: usage at
          // the result root with an empty _meta, instead of usage under _meta.
          process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      if (mode === "peer-capability") {
        if (!peerDirectory) throw new Error("peer-capability mode requires an owned receipt directory");
        const deadline = Date.now() + 60_000;
        const held = setInterval(() => {
          if (!existsSync(join(peerDirectory, `${process.pid}.release`))) {
            if (Date.now() < deadline) return;
            clearInterval(held);
            process.stderr.write("fake-acp: owned peer capability hold expired\n");
            process.exit(8);
          }
          clearInterval(held);
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Owned held turn completed" } } } });
          complete();
        }, 20);
        return;
      }
      if (mode === "ask-peer" && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e: Error) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${e.message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "recommend-peer" && agentsMcp) {
        // Jev dispatch e2e: rank the roster with recommend_team, then ask the
        // top pick — proves the decision engine through the real proxy →
        // harness → endpoint chain, with the fold-back assertion in comms.
        void driveMcp(agentsMcp, [
          {
            name: "recommend_team",
            args: () => ({ task: "our login page needs an authentication review" }),
          },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "review the login flow" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `recommended says: ${reply}` } } } });
            complete();
          })
          .catch((e: Error) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `recommend error: ${e.message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated") {
        // echoing the WHOLE prompt (system + turn text) lets a test assert
        // both what a drained turn was sent and what it was NOT sent (e.g.
        // the webhook untrusted-data paragraph a steered turn must not get)
        const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        if (gate && !existsSync(gate)) {
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            finish();
          }, 50);
          return;
        }
        finish();
        return;
      }
      if (mode === "delegate-peer" && agentsMcp) {
        // async peer-handoff e2e: queue the delegation and return
        // immediately; the harness fires the peer's depth-1 turn after our
        // turn settles. We don't need the peer's reply in our text — the
        // comms e2e verifies the channel mirroring on its own.
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "delegated task",
              reason: "followup",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated: ${reply}` } } } });
            complete();
          })
          .catch((e: Error) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${e.message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "permission-gated" || mode === "rehearsal-gated") {
        if (mode === "rehearsal-gated") {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: {
            sessionUpdate: "agent_message_chunk", content: { text: "Open and inspect the page.\nPLAN TOOLS:\n- browser_open\n- screenshot" },
          } } });
        }
        pendingPermissionId = 9001;
        onPermissionAnswered = (allowOnce) => {
          // The ACP client wraps the selected option in result.outcome. A
          // rejection, cancellation, malformed response or RPC error must
          // never make the success assertion pass.
          if (allowOnce) {
            if (mode === "rehearsal-gated") {
              // ACP normalizes rawInput.command ahead of title. Omit rawInput
              // so these exact titles match the declared tool identifiers.
              for (const title of ["browser_open", "screenshot"]) {
                const toolCallId = `rehearsal-${title}`;
                out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId, title } } });
                out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" } } });
              }
              const reply = "\n\nWHY: Exercise an owned approval rehearsal fixture.\n"
                + "DECISIONS:\n- Wait for Allow once before emitting simulated tool successes.\n"
                + "- Record browser_open then screenshot in the fixture journal.\n"
                + "HYPOTHESIS: Two ordered successful fixture tools will match the next stated plan.\n"
                + "FINDINGS: The fixture emitted browser_open and screenshot in order; no real browser action was performed.\n\n"
                + "hello from fake acp";
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: reply } } } });
            } else {
              playTurn();
            }
          } else {
            const denied = mode === "rehearsal-gated" ? "\n\npermission denied by fake acp" : "permission denied by fake acp";
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: denied } } } });
          }
          complete();
        };
        out({
          jsonrpc: "2.0", id: pendingPermissionId, method: "session/request_permission",
          params: {
            toolCall: { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      if (mode !== "empty-reply") playTurn();
      if (mode === "permission" || mode === "sparse-permission") {
        if (mode === "sparse-permission") {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "sparse", kind: "execute", title: "Run command", rawInput: { command: "echo pending" } } } });
        }
        // ask the client to approve a tool, then complete once answered
        pendingPermissionId = 9001;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: mode === "sparse-permission" ? { toolCallId: "sparse" } : { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      // the interrupted prompt resolves as cancelled
      peerReceipt("cancel.json", { pid: process.pid, canceled: ++peerCancelCount });
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
