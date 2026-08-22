// Anthropic driver — Messages API (not chat-completions: system is a
// top-level field, SSE uses named `event:` lines with content_block_delta,
// usage splits across message_start/message_delta). Same transcript-replay
// shape as grok.ts/openai.ts otherwise.
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

const DRIVER_KIND = "anthropic";
const DEFAULT_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

const MODELS = {
  default: "claude-sonnet-4-5",
  options: [
    { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

export interface AnthropicConfig {
  url: string;
  apiKeyEnv: string;
}

const isText = <T>(value: T): value is T & string => String(value) === value;

/** A config record, or null for every other wire shape (scalars, arrays). */
function jsonRecordOf(value: JsonValue | undefined): JsonObject | null {
  return value instanceof Object && !Array.isArray(value) ? value : null;
}

function decodeConfig(raw: JsonValue | undefined): AnthropicConfig {
  const o = jsonRecordOf(raw) ?? {};
  return {
    url: isText(o.url) ? o.url : DEFAULT_URL,
    apiKeyEnv: isText(o.apiKeyEnv) ? o.apiKeyEnv : "ANTHROPIC_API_KEY",
  };
}

export const AnthropicDriver: ProviderDriver<AnthropicConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Anthropic (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AnthropicConfig>): Promise<ProviderInstance> {
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
      system: string | undefined,
      model: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${config.url}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          // an absent system reads the same on the wire as an omitted key:
          // JSON.stringify drops undefined-valued fields
          system,
          messages,
          stream: opts.stream,
        }),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Anthropic HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      if (!opts.stream) {
        const json: any = await res.json();
        const text = (json.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        return {
          text,
          usage: json.usage
            ? { input: json.usage.input_tokens ?? 0, output: json.usage.output_tokens ?? 0 }
            : null,
        };
      }
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
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
          if (!data) continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
            const delta = chunk.delta.text;
            text += delta;
            opts.onDelta?.(delta);
          } else if (chunk.type === "message_start" && chunk.message?.usage) {
            inputTokens = chunk.message.usage.input_tokens ?? 0;
          } else if (chunk.type === "message_delta" && chunk.usage) {
            outputTokens = chunk.usage.output_tokens ?? 0;
          }
        }
      }
      const usage = inputTokens || outputTokens ? { input: inputTokens, output: outputTokens } : null;
      return { text, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey)
        throw new Error(`no Anthropic key — set ${config.apiKeyEnv} or config.json providers.anthropic.apiKey`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const messages = [
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, {
        dir: "out",
        source: "anthropic.messages",
        msg: { model: turn.model, system: turn.system, messages },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });

      (async () => {
        try {
          const { text, usage } = await complete(messages, turn.system, turn.model || MODELS.default, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta) =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
          });
          appendNative(threadId, { dir: "in", source: "anthropic.messages", msg: { text, usage } });
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
            const message = e instanceof Error ? e.message : String(e);
            emit({ ...base(threadId, turnId), type: "runtime.error", message });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no Anthropic API key — add it in Settings → Providers, or set ${config.apiKeyEnv}`,
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
        capabilities: { sessionModelSwitch: "in-session" },
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
        const { text } = await complete([{ role: "user", content: prompt }], undefined, "claude-haiku-4-5", {
          stream: false,
        });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
