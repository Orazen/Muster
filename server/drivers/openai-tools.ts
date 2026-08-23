// What.
// The tool-calling half of every OpenAI-shaped chat-completions driver —
// the generic factory (openai-compatible.ts) and the first-party twins
// (openai.ts, grok.ts). MCP integrations spawn here; the model's
// `tools` / `tool_calls` wire shapes are translated here.
//
// Why.
// openai-compatible.ts proved the pattern; grok.ts and openai.ts needed the
// same loop, and three near-identical copies of an agentic loop is two too
// many. One module owns: MCP spawn contract per integration, the
// "serverKey__toolName" routing scheme, response parsing, and the capped
// call-results-repeat loop. Drivers keep only what genuinely differs: their
// fetch (URL, key header, error text).

import type { SendTurnInput } from "../contracts.ts";
import { connectMcpStdio, type McpClient } from "../mcp-client.ts";
import { callKey } from "../repeat-detector.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { JsonObject } from "../schema.ts";

const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

/** Every OpenAI-compatible chat-completions API accepts `tools` in this
 * exact shape — it's the same de facto standard the request/response body
 * already is. Translating MCP's inputSchema straight through works because
 * both are plain JSON Schema. Some servers omit input_schema entirely; the
 * empty object is then what keeps the API contract happy. */
export function toOpenAiTool(
  serverKey: string,
  tool: { name: string; description?: string; inputSchema?: JsonObject },
) {
  return {
    type: "function" as const,
    function: {
      name: `${serverKey}__${tool.name}`,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

export type OpenAiTool = ReturnType<typeof toOpenAiTool>;

/** One model turn's worth of tool traffic, decoded from a non-streaming
 * chat-completions response. */
export interface ToolCallRound {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: { input: number; output: number } | null;
}

/** The shape every real OpenAI-compatible tool-calling response returns:
 * content plus an optional tool_calls array with stringified arguments. */
export function parseChatToolResponse(json: any): ToolCallRound {
  const message = json?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((tc: any) => ({
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      }))
    : [];
  return {
    text: message.content ?? "",
    toolCalls,
    usage: json?.usage
      ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
      : null,
  };
}

/** Spawn an MCP client per configured integration the driver actually
 * supports (computer, composio — agents/dweb are the same mechanical
 * pattern, not wired yet). Each tool name gets prefixed with its server
 * key ("computer__screenshot") so a tool_call can be routed back to the
 * right client; every real OpenAI-compatible API leaves function names
 * otherwise unconstrained, so this is a safe, collision-proof scheme. */
export async function connectIntegrations(
  integrations: SendTurnInput["integrations"] | undefined,
): Promise<{ clients: Map<string, McpClient>; tools: OpenAiTool[] }> {
  const clients = new Map<string, McpClient>();
  const tools: OpenAiTool[] = [];
  const specs: Array<{ key: string; command: string; args: string[]; env: Record<string, string> }> = [];

  if (integrations?.computer) {
    specs.push({
      key: "computer",
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: { ...NODE_ENV_FLAG, ...computerProxyEnv(integrations.computer) },
    });
  } else if (integrations?.localComputer) {
    specs.push({ key: "computer", ...integrations.localComputer });
  }
  if (integrations?.composio) {
    specs.push({ key: "composio", ...integrations.composio });
  }

  await Promise.all(
    specs.map(async (spec) => {
      try {
        const client = await connectMcpStdio(spec.command, spec.args, spec.env, { timeoutMs: 20_000 });
        clients.set(spec.key, client);
        for (const tool of client.tools) tools.push(toOpenAiTool(spec.key, tool));
      } catch {
        // A tool source that fails to connect is simply absent this turn —
        // matches the CLI drivers' own behavior (a dead MCP server doesn't
        // crash the turn, its tools just aren't there).
      }
    }),
  );

  return { clients, tools };
}

export function closeAll(clients: Map<string, McpClient>) {
  for (const client of clients.values()) client.close();
}

/** A model call that can carry tools: non-streaming, so tool_calls survive
 * the round trip (streamed tool-call deltas would need reassembly here for
 * no benefit — the loop's intermediate rounds are never shown live). */
export type ToolChat = (
  messages: Array<JsonObject>,
  model: string,
  tools: OpenAiTool[],
  signal?: AbortSignal,
) => Promise<ToolCallRound>;

/** Cap on agentic rounds. A model that keeps asking for tools instead of
 * answering must not hang a turn forever; 20 rounds is far past any real
 * screenshot-and-click flow. */
export const MAX_TOOL_ROUNDS = 20;

/** Loop enforcement (v2 plan 3.3, API drivers only — the harness owns these
 * calls end-to-end; CLI turns can only be interrupted wholesale, see the
 * verified EOF note on item 3.2). Keyed exactly like the observe-side
 * detector: tool name plus whitespace-normalized arguments. At the advisory
 * threshold the call still runs but its result carries a nudge; at the hard
 * threshold the call is NOT executed and the model gets a synthetic
 * termination result instead — a repeated identical click is not something
 * running a sixth time makes better. */
const ADVISORY_AT = 3;
const TERMINATE_AT = 6;

function enforcementNote(count: number): string {
  return `[harness] this exact call has now been made ${count} times this turn with identical arguments — it is almost certainly stuck in a loop. Do not repeat it again; change approach or answer directly.]`;
}

function terminationText(count: number): string {
  return `terminated by harness after ${count} identical calls this turn — do not repeat this call; change approach or answer directly.`;
}

/** The agentic loop: ask the model, run whatever tools it asked for, feed
 * the results back, repeat until it answers with no more tool calls. */
export async function runToolLoop(opts: {
  chat: ToolChat;
  messages: Array<JsonObject>;
  model: string;
  clients: Map<string, McpClient>;
  tools: OpenAiTool[];
  signal?: AbortSignal;
}): Promise<{ text: string; usage: { input: number; output: number } | null }> {
  const { chat, model, clients, tools, signal } = opts;
  const messages = [...opts.messages];
  let totalUsage: { input: number; output: number } | null = null;
  // per-turn repeat ledger for enforcement (see ADVISORY_AT above) — lives
  // outside the round loop: the point is catching repeats ACROSS rounds
  const counts = new Map<string, number>();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { text, toolCalls, usage } = await chat(messages, model, tools, signal);
    if (usage) {
      const priorInput: number = totalUsage === null ? 0 : totalUsage.input;
      const priorOutput: number = totalUsage === null ? 0 : totalUsage.output;
      totalUsage = { input: priorInput + usage.input, output: priorOutput + usage.output };
    }
    if (toolCalls.length === 0) return { text, usage: totalUsage };

    // Plain JSON wire shapes are structurally JsonObject; no cast needed.
    const assistantRound: JsonObject = {
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantRound);
    for (const call of toolCalls) {
      const sepIdx = call.name.indexOf("__");
      const serverKey = sepIdx === -1 ? "" : call.name.slice(0, sepIdx);
      const toolName = sepIdx === -1 ? call.name : call.name.slice(sepIdx + 2);
      const client = clients.get(serverKey);

      const key = callKey(toolName, call.arguments) ?? `bare:${call.name}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= TERMINATE_AT) {
        messages.push({ role: "tool", tool_call_id: call.id, content: terminationText(count) });
        continue;
      }

      let resultText: string;
      if (!client) {
        resultText = `error: no such tool source "${serverKey}"`;
      } else {
        try {
          const args = JSON.parse(call.arguments || "{}");
          const result = await client.callTool(toolName, args);
          resultText = result.content.map((c) => c.text ?? c.data ?? "").join("\n") || "(no output)";
        } catch (e) {
          resultText = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (count >= ADVISORY_AT) resultText = `${resultText}\n${enforcementNote(count)}`;
      const toolResult: JsonObject = { role: "tool", tool_call_id: call.id, content: resultText };
      messages.push(toolResult);
    }
  }
  return { text: "(stopped after too many tool calls)", usage: totalUsage };
}
