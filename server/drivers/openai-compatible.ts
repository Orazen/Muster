// Factory for the OpenAI-shaped chat-completions API — DeepSeek, Mistral,
// Groq, Together, Fireworks, and OpenRouter all implement this exact
// request/response/SSE shape (it's become a de facto standard). One
// implementation, one set of bugs to fix, instead of six near-duplicates
// of openai.ts/grok.ts.
// Tool calling lives in ./openai-tools.ts, shared with those twins.
import type {
  DriverCreateInput,
  EngineInstall,
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

/** One chat-completions message. Content is a plain string for text turns
 * and an OpenAI content-part array when the turn carries images (vision
 * twins only — dispatch never sets turn.images without visionParts). */
type ChatMessage = {
  role: string;
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

/** The final user message of a turn: text alone, or text plus one image
 * part per attached image, each as a self-contained data URL so no extra
 * upload round-trip exists. History replays stay text-only by design —
 * re-sending every past screenshot on every turn would multiply cost with
 * no benefit; the model answered them already. */
function userContent(turn: SendTurnInput): ChatMessage["content"] {
  const images = turn.images ?? [];
  if (images.length === 0) return turn.text;
  return [
    { type: "text", text: turn.text },
    ...images.map((i) => ({
      type: "image_url" as const,
      image_url: { url: `data:${i.mediaType};base64,${i.dataBase64}` },
    })),
  ];
}

// Values decoded here only ever originate from JSON.parse of persisted
// instance config: the predicate decides exactly the primitive a
// representation test would.
const isText = (v: JsonValue): v is string => Object.is(String(v), v);

/** Extract the model id list from a /v1/models payload. The wire shape is
 * `{ data: [{ id: "…" }] }` across Ollama, LM Studio and vLLM; anything
 * else decodes to an empty list, which the caller treats as "keep what we
 * had". */
function modelIdsOf(json: JsonValue): string[] {
  // JsonValue's object arm narrows through instanceof; no casts needed.
  const root = json instanceof Object && !Array.isArray(json) ? json : null;
  if (!root || !Array.isArray(root.data)) return [];
  return root.data.flatMap((row) => {
    const record = row instanceof Object && !Array.isArray(row) ? row : null;
    if (!record) return [];
    return isText(record.id) ? [record.id] : [];
  });
}

export interface OpenAICompatibleConfig {
  url: string;
  apiKeyEnv: string;
  /** Per-instance model catalog — the custom BYOK provider driver's list
   * arrives from instance config (custom-providers.ts) rather than the
   * driver spec. Undefined keeps the driver-level static list. */
  models?: { default: string; options: Array<{ id: string; label: string }> };
}

export interface OpenAICompatibleSpec {
  driverKind: string;
  displayName: string;
  defaultUrl: string;
  defaultApiKeyEnv: string;
  models: {
    default: string;
    options: Array<{ id: string; label: string; vision?: boolean }>;
  };
  /** Model used for generateText (titles/thread names) — usually the
   * cheapest/fastest option in the catalog. With dynamicModels the live
   * catalog's default wins when present. */
  quickModel: string;
  /** Keyless local server: a placeholder Bearer is sent (some stacks reject
   * a missing authorization header outright) and a missing key is NOT an
   * unavailable state — the server being up is the only availability
   * question. */
  keyless?: boolean;
  /** snapshot() actually pings GET {url}/models, so an installed-but-not-
   * running server reports unavailable-with-reason instead of available.
   * Cloud APIs are always reachable if the key exists; localhost is not. */
  pingSnapshot?: boolean;
  /** The model list comes from the server's own GET /v1/models at create
   * time — only models the user actually pulled appear — and
   * refreshModels() re-fetches without a restart. Falls back to the static
   * spec list until the first successful fetch. */
  dynamicModels?: boolean;
  /** Install/sign-in affordances surfaced by the picker rail. */
  install?: EngineInstall;
  /** Capability-flag overrides. Defaults keep the cloud-API behavior
   * (computer + composio MCP mounted); local engines set honest falses. */
  capabilities?: { computerMcp?: boolean; composioMcp?: boolean };
  /** Vision: the provider's chat endpoint accepts multimodal content parts
   * (image_url data URLs). Opt-in per twin — a text-only model 4xxs on
   * image parts, and the app's contract is to refuse the attach politely
   * up front rather than fail mid-turn. */
  vision?: boolean;
}

export function createOpenAICompatibleDriver(spec: OpenAICompatibleSpec): ProviderDriver<OpenAICompatibleConfig> {
  const {
    driverKind,
    displayName,
    defaultUrl,
    defaultApiKeyEnv,
    models: staticModels,
    quickModel: specQuickModel,
    keyless = false,
    pingSnapshot = false,
    dynamicModels = false,
    install,
    capabilities: capabilityOverrides,
    vision,
  } = spec;

  function decodeConfig(raw: JsonValue | undefined): OpenAICompatibleConfig {
    // Non-object configs fall back to every default, field by field.
    const o: JsonObject = raw instanceof Object && !Array.isArray(raw) ? raw : {};
    const modelsRaw = o.models;
    const modelsRoot = modelsRaw instanceof Object && !Array.isArray(modelsRaw) ? modelsRaw : null;
    const rawOptions = modelsRoot && Array.isArray(modelsRoot.options) ? modelsRoot.options : [];
    const options = rawOptions.flatMap((row) => {
      const record = row instanceof Object && !Array.isArray(row) ? row : null;
      if (!record || !isText(record.id)) return [];
      return [{ id: record.id, label: isText(record.label) ? record.label : record.id }];
    });
    const statedDefault = modelsRoot && isText(modelsRoot.default) ? modelsRoot.default : "";
    const preferred = options.some((m) => m.id === statedDefault) ? statedDefault : options[0]?.id;
    // Only instances whose config actually carries a models list get one;
    // built-in twins keep their driver-spec catalog untouched. Built as
    // statements, not a conditional spread — omission must be explicit.
    const decoded: OpenAICompatibleConfig = {
      url: isText(o.url) ? o.url : defaultUrl,
      apiKeyEnv: isText(o.apiKeyEnv) ? o.apiKeyEnv : defaultApiKeyEnv,
    };
    if (options.length > 0) decoded.models = { default: preferred ?? "", options };
    return decoded;
  }

  const driver: ProviderDriver<OpenAICompatibleConfig> = {
    driverKind,
    metadata: { displayName, supportsMultipleInstances: true },
    models: staticModels,
    // optional install affordance flows straight from the spec; undefined
    // simply leaves the readonly contract field unset
    install,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<OpenAICompatibleConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
      // Keyless local servers (Ollama, LM Studio, vLLM) ignore the value but
      // some HTTP stacks reject a request with no authorization header at
      // all — send a placeholder instead of special-casing every call site.
      const bearer = keyless && !apiKey ? "local" : apiKey;
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, { abort: AbortController; turnId: string }>();

      // Live model catalog for dynamicModels instances: starts as the static
      // fallback and is replaced by whatever GET /v1/models actually returns
      // — only models the user pulled should appear in the picker. A failed
      // fetch keeps the last known list; availability is snapshot()'s job.
      // Custom BYOK instances carry their catalog in instance config: the
      // user picked the exact model list to expose, and it outranks any
      // driver-spec list. Built-in twins pass no config models and keep
      // the static spec behavior below, byte for byte.
      const configModels = input.config.models;
      let catalog = configModels ?? staticModels;
      let quickModel = configModels?.default ?? specQuickModel;
      const fetchModelCatalog = async (): Promise<boolean> => {
        try {
          const res = await fetch(`${config.url}/models`, {
            headers: { authorization: `Bearer ${bearer}` },
            signal: AbortSignal.timeout(4_000),
          });
          if (!res.ok) return false;
          // SAFETY: res.json() returns `any` by platform contract; the
          // payload is only handled as JsonValue from here on.
          const json = (await res.json()) as JsonValue;
          const ids = modelIdsOf(json);
          if (!ids.length) return false;
          const preferred = ids.includes(staticModels.default) ? staticModels.default : ids[0]!;
          catalog = { default: preferred, options: ids.map((id) => ({ id, label: id })) };
          if (!ids.includes(specQuickModel)) quickModel = preferred;
          return true;
        } catch {
          return false;
        }
      };
      if (dynamicModels) await fetchModelCatalog();;

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
        messages: Array<ChatMessage>,
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
        // Tolerance for gateways that ignore `stream: true` and answer with
        // a plain JSON body (no `data:` lines) — previously this path read
        // zero deltas and returned an EMPTY reply with no error, which made
        // custom BYOK providers look broken when the endpoint simply
        // doesn't stream. Content-type is the honest signal; fall back to
        // the non-streaming parse when it isn't an event stream.
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const json: any = await res.json();
          return {
            text: json.choices?.[0]?.message?.content ?? "",
            usage: json.usage
              ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
              : null,
          };
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
        if (!apiKey && !keyless) {
          throw new Error(`no ${displayName} key — set ${config.apiKeyEnv} or config.json providers.${driverKind}.apiKey`);
        }
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        const abort = new AbortController();
        active.set(threadId, { abort, turnId });

      const messages: Array<ChatMessage> = [
          ...(turn.system ? [{ role: "system", content: turn.system }] : []),
          ...(turn.transcript ?? []).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.text,
          })),
          { role: "user", content: userContent(turn) },
        ];
        appendNative(threadId, {
          dir: "out",
          source: `${driverKind}.chat.completions`,
          msg: { model: turn.model, messages },
        });

        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? catalog.default });

        (async () => {
          const { clients, tools } = await connectIntegrations(turn.integrations);
          try {
            const model = turn.model || catalog.default;
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
        // Local servers are only "there" if something answers the socket:
        // an installed-but-not-running engine must read as unavailable with
        // a reason, not as a ready engine that fails on first send.
        if (pingSnapshot) {
          try {
            const res = await fetch(`${config.url}/models`, {
              headers: { authorization: `Bearer ${bearer}` },
              signal: AbortSignal.timeout(3_000),
            });
            if (!res.ok) {
              return { state: "unavailable", reason: `${displayName} answered HTTP ${res.status} at ${config.url}` };
            }
            return { state: "available", authenticated: true, version: null };
          } catch (e) {
            // SAFETY: fetch refusals surface as Error instances.
            const message = e instanceof Error ? e.message : String(e);
            return {
              state: "unavailable",
              reason: `${displayName} isn't reachable at ${config.url} (${message}) — is the server running?`,
            };
          }
        }
        if (!apiKey && !keyless) {
          return {
            state: "unavailable",
            reason: `no ${displayName} API key — add it in Settings → Providers, or set ${config.apiKeyEnv}`,
          };
        }
        return { state: "available", authenticated: true, version: null };
      };

      // `refreshModels` is readonly on the public contract — readers must
      // not hot-swap it — so the hook is chosen HERE, at construction, and
      // travels with the literal instead of being assigned afterwards.
      const refreshModelsHook = dynamicModels
        ? async (): Promise<void> => {
            await fetchModelCatalog();
          }
        : undefined;

      const instance: ProviderInstance = {
        instanceId,
        driverKind,
        displayName: input.displayName,
        enabled: input.enabled,
        // getter, not a captured value: fetchModelCatalog reassigns the
        // catalog variable, and readers must see the live object
        get models() {
          return catalog;
        },
        snapshot,
        refreshModels: refreshModelsHook,
        adapter: {
          provider: driverKind,
          capabilities: {
            sessionModelSwitch: "in-session",
            computerMcp: capabilityOverrides?.computerMcp ?? true,
            composioMcp: capabilityOverrides?.composioMcp ?? true,
            // every factory-built driver reads turn.transcript directly
            transcriptReplay: true,
            // Vision twins get ONE switch that does the whole job: `images`
            // unlocks the composer's paste/drop affordance, `visionParts`
            // makes dispatch hand this turn's attachments to sendTurn. A
            // driver that accepted parts but refused the attach would be a
            // dead feature; non-vision twins keep both off so the composer
            // refuses politely instead of failing mid-turn. A mixed catalog
            // (some vision-flagged models) enables both too — per-model
            // gating then applies via modelAcceptsImages().
            images: vision === true || staticModels.options.some((m) => m.vision === true),
            visionParts: vision === true || staticModels.options.some((m) => m.vision === true),
          },
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
      return instance;
    },
  };
  return driver;
}
