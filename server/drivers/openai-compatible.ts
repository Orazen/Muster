// Factory for the OpenAI-shaped chat-completions API — DeepSeek, Mistral,
// Groq, Together, Fireworks, and OpenRouter all implement this exact
// request/response/SSE shape (it's become a de facto standard). One
// implementation, one set of bugs to fix, instead of six near-duplicates
// of openai.ts/grok.ts.
// Tool calling lives in ./openai-tools.ts, shared with those twins.
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
import type { McpClient } from "../mcp-client.ts";
import { appendNative } from "./native.ts";
import {
  closeAll,
  connectIntegrations,
  parseChatToolResponse,
  runToolLoop,
  type OpenAiTool,
} from "./openai-tools.ts";
import type { JsonObject, JsonValue } from "../schema.ts";

// Values decoded here only ever originate from JSON.parse of persisted
// instance config: the predicate decides exactly the primitive a
// representation test would.
const isText = (v: JsonValue): v is string => Object.is(String(v), v);

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

  function decodeConfig(raw: JsonValue | undefined): OpenAICompatibleConfig {
    // Non-object configs fall back to every default, field by field.
    const o: JsonObject = raw instanceof Object && !Array.isArray(raw) ? raw : {};
    return {
      url: isText(o.url) ? o.url : defaultUrl,
      apiKeyEnv: isText(o.apiKeyEnv) ? o.apiKeyEnv : defaultApiKeyEnv,
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
        for (const l of listeners) l(event);
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

      /** Same request shape as complete(), but non-streamed and carrying the
       * integration tools. Parsing + the loop live in ./openai-tools.ts; kept
       * separate from complete() rather than folding tool support into it:
       * a turn with no integrations (the overwhelming common case) keeps
       * using the exact same streaming path this factory already had,
       * zero behavior change, zero added risk. */
      const completeWithTools = async (
        messages: Array<JsonObject>,
        model: string,
        tools: OpenAiTool[],
        signal?: AbortSignal,
      ): Promise<ReturnType<typeof parseChatToolResponse>> => {
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
        return parseChatToolResponse(await res.json());
      };

      const runTurnToolLoop = (messages: Array<JsonObject>, model: string, clients: Map<string, McpClient>, tools: OpenAiTool[], signal?: AbortSignal) =>
        runToolLoop({ chat: completeWithTools, messages, model, clients, tools, signal });

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
              ({ text, usage } = await runTurnToolLoop(messages, model, clients, tools, abort.signal));
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
            const aborted = e instanceof Error && e.name === "AbortError";
            if (!aborted) {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: e instanceof Error ? e.message : String(e) });
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
