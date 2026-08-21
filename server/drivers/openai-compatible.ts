// Factory for the OpenAI-shaped chat-completions API — DeepSeek, Mistral,
// Groq, Together, Fireworks, and OpenRouter all implement this exact
// request/response/SSE shape (it's become a de facto standard). One
// implementation, one set of bugs to fix, instead of six near-duplicates
// of openai.ts/grok.ts.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { connectMcpStdio, type McpClient } from "../mcp-client.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

/** Every OpenAI-compatible chat-completions API accepts `tools` in this
 * exact shape — it's the same de facto standard the request/response body
 * already is (this factory's own header comment). Translating MCP's
 * inputSchema straight through works because both are plain JSON Schema. */
function toOpenAiTool(serverKey: string, tool: { name: string; description?: string; inputSchema: Record<string, unknown> }) {
  return {
    type: "function" as const,
    function: {
      name: `${serverKey}__${tool.name}`,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

/** Spawn an MCP client per configured integration this driver actually
 * supports (computer, composio — agents/dweb are the same mechanical
 * pattern, not wired yet). Each tool name gets prefixed with its server
 * key ("computer__screenshot") so a tool_call can be routed back to the
 * right client; every real OpenAI-compatible API leaves function names
 * otherwise unconstrained, so this is a safe, collision-proof scheme. */
async function connectIntegrations(
  integrations: SendTurnInput["integrations"] | undefined,
): Promise<{ clients: Map<string, McpClient>; tools: ReturnType<typeof toOpenAiTool>[] }> {
  const clients = new Map<string, McpClient>();
  const tools: ReturnType<typeof toOpenAiTool>[] = [];
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

function closeAll(clients: Map<string, McpClient>) {
  for (const client of clients.values()) client.close();
}

export interface OpenAICompatibleConfig {
  url: string;
  apiKeyEnv: string;
}

export interface OpenAICompatibleSpec {
  driverKind: string;
  displayName: string;
  defaultUrl: string;
  defaultApiKeyEnv: string;
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Model used for generateText (titles/thread names) — usually the
   * cheapest/fastest option in the catalog. */
  quickModel: string;
}

export function createOpenAICompatibleDriver(spec: OpenAICompatibleSpec): ProviderDriver<OpenAICompatibleConfig> {
  const { driverKind, displayName, defaultUrl, defaultApiKeyEnv, models, quickModel } = spec;

  function decodeConfig(raw: unknown): OpenAICompatibleConfig {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      url: typeof o.url === "string" ? o.url : defaultUrl,
      apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : defaultApiKeyEnv,
    };
  }

  return {
    driverKind,
    metadata: { displayName, supportsMultipleInstances: true },
    models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<OpenAICompatibleConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, { abort: AbortController; turnId: string }>();

      const emit = (event: RuntimeEvent) => {
        for (const l of [...listeners]) l(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: driverKind,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const complete = async (
        messages: Array<{ role: string; content: string }>,
        model: string,
        opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
      ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
        const res = await fetch(`${config.url}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages, stream: opts.stream }),
          signal: opts.signal ?? AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${displayName} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        if (!opts.stream) {
          const json: any = await res.json();
          return {
            text: json.choices?.[0]?.message?.content ?? "",
            usage: json.usage
              ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
              : null,
          };
        }
        let text = "";
        let usage: { input: number; output: number } | null = null;
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk: any;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              opts.onDelta?.(delta);
            }
            if (chunk.usage) {
              usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
            }
          }
        }
        return { text, usage };
      };

      /** Same request shape as complete(), but non-streamed and returning
       * any tool_calls the model asked for — the shape every real
       * OpenAI-compatible tool-calling response actually returns. Kept
       * separate from complete() rather than folding tool support into it:
       * a turn with no integrations (the overwhelming common case) keeps
       * using the exact same streaming path this factory already had,
       * zero behavior change, zero added risk. */
      const completeWithTools = async (
        messages: Array<Record<string, unknown>>,
        model: string,
        tools: ReturnType<typeof toOpenAiTool>[],
        signal?: AbortSignal,
      ): Promise<{
        text: string;
        toolCalls: Array<{ id: string; name: string; arguments: string }>;
        usage: { input: number; output: number } | null;
      }> => {
        const res = await fetch(`${config.url}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages, tools, tool_choice: "auto", stream: false }),
          signal: signal ?? AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${displayName} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        const json: any = await res.json();
        const message = json.choices?.[0]?.message ?? {};
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
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
        };
      };

      /** The agentic loop: ask the model, run whatever tools it asked for,
       * feed the results back, repeat until it answers with no more tool
       * calls. Capped so a model that never stops calling tools can't hang
       * a turn forever. */
      const runToolLoop = async (
        initialMessages: Array<Record<string, unknown>>,
        model: string,
        clients: Map<string, McpClient>,
        tools: ReturnType<typeof toOpenAiTool>[],
        signal?: AbortSignal,
      ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
        const messages = [...initialMessages];
        let totalUsage: { input: number; output: number } | null = null;
        const MAX_ROUNDS = 20;
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const { text, toolCalls, usage } = await completeWithTools(messages, model, tools, signal);
          if (usage) {
            const priorInput: number = totalUsage === null ? 0 : totalUsage.input;
            const priorOutput: number = totalUsage === null ? 0 : totalUsage.output;
            totalUsage = { input: priorInput + usage.input, output: priorOutput + usage.output };
          }
          if (toolCalls.length === 0) return { text, usage: totalUsage };

          messages.push({
            role: "assistant",
            content: text || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });
          for (const call of toolCalls) {
            const sepIdx = call.name.indexOf("__");
            const serverKey = sepIdx === -1 ? "" : call.name.slice(0, sepIdx);
            const toolName = sepIdx === -1 ? call.name : call.name.slice(sepIdx + 2);
            const client = clients.get(serverKey);
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
            messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
          }
        }
        return { text: "(stopped after too many tool calls)", usage: totalUsage };
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (!apiKey) {
          throw new Error(`no ${displayName} key — set ${config.apiKeyEnv} or config.json providers.${driverKind}.apiKey`);
        }
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        const abort = new AbortController();
        active.set(threadId, { abort, turnId });

        const messages = [
          ...(turn.system ? [{ role: "system", content: turn.system }] : []),
          ...(turn.transcript ?? []).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.text,
          })),
          { role: "user", content: turn.text },
        ];
        appendNative(threadId, {
          dir: "out",
          source: `${driverKind}.chat.completions`,
          msg: { model: turn.model, messages },
        });

        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? models.default });

        (async () => {
          const { clients, tools } = await connectIntegrations(turn.integrations);
          try {
            const model = turn.model || models.default;
            let text: string;
            let usage: { input: number; output: number } | null;
            if (tools.length > 0) {
              // A tool-using turn isn't streamed mid-flight (completeWithTools
              // is non-streaming, needed to read tool_calls out of the
              // response) — the whole answer arrives as one chunk once the
              // loop finishes, same "item.completed" event either way.
              ({ text, usage } = await runToolLoop(messages, model, clients, tools, abort.signal));
            } else {
              ({ text, usage } = await complete(messages, model, {
                stream: true,
                signal: abort.signal,
                onDelta: (delta) =>
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
              }));
            }
            appendNative(threadId, { dir: "in", source: `${driverKind}.chat.completions`, msg: { text, usage } });
            if (text.trim()) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            if (usage) {
              emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
            }
            active.delete(threadId);
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
          } catch (e) {
            active.delete(threadId);
            const aborted = (e as Error).name === "AbortError";
            if (!aborted) {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            }
            emit({
              ...base(threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: aborted ? "interrupted" : "error",
              cost: null,
            });
          } finally {
            closeAll(clients);
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        if (!apiKey) {
          return {
            state: "unavailable",
            reason: `no ${displayName} API key — add it in Settings → Providers, or set ${config.apiKeyEnv}`,
          };
        }
        return { state: "available", authenticated: true, version: null };
      };

      return {
        instanceId,
        driverKind,
        displayName: input.displayName,
        enabled: input.enabled,
        models,
        snapshot,
        adapter: {
          provider: driverKind,
          capabilities: { sessionModelSwitch: "in-session", computerMcp: true, composioMcp: true },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
          respondToRequest: async () => "unavailable" as const,
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { abort } of active.values()) abort.abort();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        generateText: async (prompt: string) => {
          const { text } = await complete([{ role: "user", content: prompt }], quickModel, { stream: false });
          return text;
        },
        dispose: async () => {
          for (const { abort } of active.values()) abort.abort();
          listeners.clear();
        },
      };
    },
  };
}
