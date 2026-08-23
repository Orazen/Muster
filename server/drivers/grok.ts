// Grok driver — xAI chat-completions API with SSE streaming. Unlike the
// CLI drivers this one is transcript-replay: the server hands it the
// folded thread history each turn (SendTurnInput.transcript) and it emits
// true token-level content.delta events. Also supplies the instance's
// generateText (bot titles, thread names) — upstream's TextGeneration slot.
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
import type { JsonObject, JsonValue } from "../schema.ts";
import { appendNative } from "./native.ts";
import {
  closeAll,
  connectIntegrations,
  parseChatToolResponse,
  runToolLoop,
  type OpenAiTool,
} from "./openai-tools.ts";
import { MAX_RETRIES, abortableSleep, retryDelayMs, transientReason } from "./retry.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";

const MODELS = {
  default: "grok-4",
  options: [
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
  ],
};

export interface GrokConfig {
  url: string;
  /** resolved at create-time from instance environment / app config */
  apiKeyEnv: string;
}

/** Wire text fields decode as primitive strings and nothing else. */
const isText = (v: JsonValue): v is string => Object.is(String(v), v);

function decodeConfig(raw: JsonValue | undefined): GrokConfig {
  // Non-object configs (null, arrays, primitives) fall back to every default,
  // matching the previous `raw ?? {}` handling field by field.
  const o = raw instanceof Object && !Array.isArray(raw) ? raw : {};
  return {
    url: isText(o.url) ? o.url : DEFAULT_URL,
    apiKeyEnv: isText(o.apiKeyEnv) ? o.apiKeyEnv : "XAI_API_KEY",
  };
}

export const GrokDriver: ProviderDriver<GrokConfig> = {
  driverKind: DRIVER_KIND,
  // "(API)" distinguishes this key-billed driver from grokAgent, the CLI one
  metadata: { displayName: "Grok (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<GrokConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of listeners) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
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
        throw new Error(`xAI HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
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

    /** Non-streaming request carrying integration tools; parsing + the
     * agentic loop live in ./openai-tools.ts, shared with openai.ts and
     * the generic compatible factory. */
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
        throw new Error(`xAI HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      return parseChatToolResponse(await res.json());
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) throw new Error(`no xAI key — set ${config.apiKeyEnv} or config.json xai.key`);
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
      appendNative(threadId, { dir: "out", source: "xai.chat.completions", msg: { model: turn.model, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });

      // Shared endings for both the tool path and the streaming retry loop.
      const finishOk = (text: string, usage: { input: number; output: number } | null) => {
        appendNative(threadId, { dir: "in", source: "xai.chat.completions", msg: { text, usage } });
        if (text.trim()) {
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        }
        if (usage) {
          emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
        }
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
      };
      const finishErr = (error: Error, aborted: boolean) => {
        active.delete(threadId);
        if (!aborted) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: error.message });
        }
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok: false,
          stopReason: aborted ? "interrupted" : "error",
          cost: null,
        });
      };

      (async () => {
        const { clients, tools } = await connectIntegrations(turn.integrations);
        try {
          if (tools.length > 0) {
            // Tool turns never auto-retry: a retried round would re-run the
            // model's earlier tool calls — a second click, a second post.
            // One pass, then success or failure, exactly like a dirty retry.
            try {
              const { text, usage } = await runToolLoop({
                chat: completeWithTools,
                messages,
                model: turn.model || MODELS.default,
                clients,
                tools,
                signal: abort.signal,
              });
              finishOk(text, usage);
            } catch (e) {
              // SAFETY: abort and fetch failures both surface as Error instances.
              const error = e instanceof Error ? e : new Error(String(e));
              finishErr(error, error.name === "AbortError");
            }
            return;
          }
          // Bounded auto-retry on transient failures (v2 plan 3.4): a 429/5xx
          // or dropped socket retries with backoff as long as nothing has been
          // streamed yet; once deltas reached the chat, a retry would duplicate
          // them, so the turn fails instead. Abort during backoff = interrupt.
          for (let attempt = 1; ; attempt++) {
          let gotDelta = false;
          try {
            const { text, usage } = await complete(messages, turn.model || MODELS.default, {
              stream: true,
              signal: abort.signal,
              onDelta: (delta) => {
                gotDelta = true;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              },
            });
            finishOk(text, usage);
            return;
          } catch (e) {
            // SAFETY: abort and fetch failures both surface as Error instances;
            // anything else is normalized so the event still carries a message.
            const error = e instanceof Error ? e : new Error(String(e));
            const aborted = error.name === "AbortError";
            const transient = !aborted && !gotDelta && attempt <= MAX_RETRIES ? transientReason(error.message) : null;
            if (transient) {
              emit({ ...base(threadId, turnId), type: "turn.retrying", attempt, maxAttempts: MAX_RETRIES, reason: transient.reason });
              await abortableSleep(retryDelayMs(attempt), abort.signal);
              if (!abort.signal.aborted) continue;
            }
            finishErr(error, aborted);
            return;
          }
          }
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
          reason: `no xAI API key — add {"xai":{"key":"xai-…"}} to ~/.muster/config.json or set ${config.apiKeyEnv}`,
        };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session", computerMcp: true, composioMcp: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
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
        const { text } = await complete([{ role: "user", content: prompt }], "grok-3-mini", { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
