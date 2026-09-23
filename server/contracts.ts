// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;

export type ProviderErrorCode =
  | "missing_cli"
  | "invalid_credentials"
  | "inactive_subscription"
  | "quota_or_region_restriction"
  | "upstream_outage"
  | "model_catalog_outage";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** Reasoning-effort levels, ascending. A union of everything any engine
 * accepts; each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrow untrusted API/config input before it becomes a model selection. */
export function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.some((level) => level === value);
}

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
  /** Optional: no effort means no flag, and the CLI keeps its own default. */
  effort?: EffortLevel;
}

// ── instance configuration envelope ────────────────────────────────────
// `driver` is any slug — NOT validated against known drivers; unknown
// drivers round-trip and surface as unavailable shadow snapshots so a
// config from a newer build downgrades safely.
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

// ── canonical runtime events ───────────────────────────────────────────
// Subset of upstream's 49-member ProviderRuntimeEvent union — the ~12 types
// the recipe says to start with, sharing one base. `raw` carries the
// native protocol message when a consumer needs to see behind the
// normalization.
export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: { source: string; payload: unknown };
}

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        /** The turn's engine process pid, once known. Emitted shortly after
         * turn.started (the CLI child may still be spawning when sendTurn
         * returns); lets the harness bind the liveness reaper's death
         * attribution to the exact turn instead of guessing by spawn time. */
        type: "turn.engine-pid";
        pid: number;
      }
    | {
        type: "turn.retrying";
        /** 1-based number of the attempt that just failed; the next try is
         * attempt + 1 of maxAttempts + 1 total. */
        attempt: number;
        maxAttempts: number;
        /** Why the failure looked transient — shown on the retry chip. */
        reason: string;
      }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
        /** THIS turn's token total, as the provider reports it at the end.
         * The one figure the harness accumulates — thread.token-usage.updated
         * is a live indicator whose meaning differs per driver (a per-call
         * delta, a thread total, a per-step figure) and must never be summed. */
        usage?: { input: number; output: number };
      }
    | { type: "item.started"; itemType: "tool" | "reasoning"; title?: string }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        choices?: string[];
      }
    | {
        type: "request.resolved";
        behavior: "allow" | "deny" | "answer";
        /** who decided: a person, auto mode, the ask's own timeout, the
         * harness (turn ended / settings changed), or nobody — the answerer
         * was already gone and the action never ran */
        source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";
      }
    | { type: "thread.token-usage.updated"; input: number; output: number }
    // `setup: true` marks a failure the user fixes by installing or
    // configuring something, not by retrying — the UI offers setup instead.
    | { type: "runtime.error"; message: string; setup?: boolean }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/** What became of an answer to an ask. `allowed-once` grants only the
 * asked-about action — broadening ("always allow") stays a separate,
 * explicit step. `unavailable` is the fail-closed default: no answerer,
 * no action. */
export type RequestOutcome = "allowed-once" | "rejected" | "answered" | "unavailable";

// ── adapter contract (upstream ProviderAdapterShape, promise-flavored) ──
// The conversation runtime every provider is flattened into. streamEvents
// becomes onEvent(listener) → unsubscribe; sessions start implicitly on
// the first turn (the agentcal per-turn-process model) with resumeCursor
// carrying the provider-native continuation (e.g. a claude session id).
export interface SendTurnInput {
  threadId: ThreadId;
  text: string;
  model?: string;
  effort?: EffortLevel;
  resumeCursor?: unknown;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Images attached to THIS turn, base64-encoded. Only API drivers whose
   * capabilities carry visionParts consume these — CLI drivers ignore the
   * field entirely because their prompt already carries <attached-image/>
   * file paths they open themselves. */
  images?: Array<{ mediaType: string; dataBase64: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** A local stdio bridge owns the remote Composio transport. Keeping the
     * bridge harness-controlled lets it turn connection requests into trusted
     * chat cards consistently across provider CLIs. */
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** Cloud computer, reached through Muster's REST-to-MCP adapter. Two
     * backends share this one adapter (server/computer-proxy.ts dispatches
     * internally) — "box" is box.ascii.dev, "opensandbox" is a self-hosted
     * OpenSandbox deployment (server/opensandbox-lifecycle.ts). */
    computer?:
      | { kind?: "box"; boxId: string; token: string }
      | { kind: "opensandbox"; sandboxId: string; url: string; apiKey: string };
    /** Direct stdio connection to a Cua Driver MCP server (host or sandbox). */
    localComputer?: { command: string; args: string[]; env: Record<string, string> };
    /** Peer-agent comms: an MCP proxy (list_bots / ask_bot) that routes back
     * through the harness so this bot can message other bots. The harness
     * owns turns, permissions, and recursion limits; the proxy only forwards. */
    agents?: { command: string; args: string[]; env: Record<string, string> };
    /** dweb network daemon: an MCP proxy exposing dweb status, repo, and
     * opencode model access as tools. url is the dweb HTTP base. */
    dweb?: { url: string };
    /** User-registered stdio MCP servers (Settings → MCP Servers), already
     * command-safety validated at save time and filtered to this bot.
     * Mounted verbatim by drivers whose capabilities.customMcp is true;
     * ignored by the rest — never half-mounted. */
    custom?: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>;
  };
  cwd?: string;
}

export interface TurnStartResult {
  turnId: TurnId;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    /** True when the driver mounts turn.integrations.agents as MCP tools —
     * the harness only offers agents tooling (and prompts about it) to
     * drivers that can actually hand it to the agent. */
    agentsMcp?: boolean;
    /** True when the driver mounts turn.integrations.computer (the box's
     * screenshot/click tools). Same rule as agentsMcp: a bot must never be
     * told it has a computer whose tools its driver cannot mount — it
     * burns turns hunting for tools that aren't there. */
    computerMcp?: boolean;
    /** True when the driver mounts turn.integrations.composio (the user's
     * connected apps). Same rule again: a key in the config says the user
     * HAS those connections, not that this driver can reach them. */
    composioMcp?: boolean;
    /** True when the driver's engine can take an image: CLI engines get
     * the path inside <attached-image/> and open it themselves; vision API
     * drivers receive turn.images parts instead. Gates the composer's
     * paste/drop affordance — without it the UI refuses politely rather
     * than silently degrading the bot's understanding. */
    images?: boolean;
    /** True when the driver mounts turn.integrations.custom — the
     * user-registered stdio MCP servers from Settings → MCP Servers. Same
     * rule as computerMcp/composioMcp: a saved server must not be advertised
     * to a bot whose engine cannot mount it. */
    customMcp?: boolean;
    /** API drivers only: sendTurn consumes turn.images as multimodal
     * content parts (OpenAI-shaped chat APIs). Always paired with `images`
     * true — one switch, two flags — so the composer affordance and the
     * wire behavior can never disagree. */
    visionParts?: boolean;
    /** Effort levels this driver can pass to its CLI, ascending. Absent =
     * the driver cannot set effort, so the app never offers the control —
     * same rule as computerMcp: never show a knob the driver cannot turn. */
    effortLevels?: readonly EffortLevel[];
    /** True when the engine consumes SendTurnInput.transcript directly (the
     * OpenAI-shaped chat-completions drivers). For these, rewind/fresh
     * history is delivered structurally as transcript entries and the
     * turn text must NOT also embed a prose replay of it — double delivery.
     * Drivers that ignore the transcript field (CLI/session engines) leave
     * this off and get the inline replay wrapper instead. */
    transcriptReplay?: boolean;
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  /** Answer a pending ask. Resolves with what actually happened — never
   * throws for an ask that is no longer there: `unavailable` means nobody
   * could take the answer (the turn ended, the broker died, the driver
   * has no asks), and the caller treats it as a deny. Callers branch on the
   * outcome, not on prose. */
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: { behavior: "allow" | "deny" | "answer"; message?: string },
  ): Promise<RequestOutcome>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  version?: string | null;
  /** How this instance is paid for, when the driver can tell: a reported
   * cost on a subscription is notional and the UI labels it as such. */
  billing?: "metered" | "subscription";
}

// ── engine install descriptor ───────────────────────────────────────────
// How a user gets this engine onto their machine. Declared by the driver so
// that adding a provider stays "one file in drivers/ plus a registration":
// onboarding, the model picker, and settings all render from this instead of
// hardcoding per-engine copy in the UI.
//
// Installing is rarely the whole job — most CLIs then need an interactive
// sign-in, which is why signInCommand exists and why the UI sends people to a
// terminal rather than trying to shell out silently.
export interface EngineInstall {
  /** One-liner per platform. Omit a platform that has no such command —
   * the UI falls back to docsUrl rather than offering something that
   * cannot work there (a curl|bash line is not a Windows command). */
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  /** Docs or download page. The only route for GUI-installed engines. */
  docsUrl?: string;
  /** Interactive sign-in run after installing, when install isn't enough. */
  signInCommand?: string;
  /** `command` needs npm on PATH, so the UI can say so when Node is absent. */
  needsNode?: boolean;
}

// ── driver SPI (upstream ProviderDriver — a plain record, not a service) ─
// `create` owns ALL per-instance state; two create calls share nothing.
// Failures must reject, never throw synchronously — the registry downgrades
// a rejection to an unavailable shadow snapshot.
export interface ModelCatalog {
  default: string;
  options: Array<{
    id: string;
    label: string;
    custom?: boolean;
    loaded?: boolean;
    /** Declared context window in tokens. Absent = unknown; context sizing
     * falls back to a conservative default (see server/model-context.ts). */
    contextWindow?: number;
    /** Declared max output tokens, when the provider publishes one. */
    maxTokens?: number;
    /** This specific model accepts image parts. Gates the composer's
     * attach affordance per model on providers whose catalogs mix text and
     * vision entries — the driver-wide `capabilities.images` unlocks the
     * affordance only for drivers where EVERY model can see. */
    vision?: boolean;
  }>;
}

/** The one rule for "may THIS bot's composer accept an image right now",
 * shared by the UI (Composer) and dispatch (server/index.ts) so the two can
 * never disagree. Driver-wide capability unlocks the affordance; when any
 * catalog entry is flagged, a mixed catalog applies and only flagged models
 * pass — attaching to a text-only model would 4xx mid-turn. */
export function modelAcceptsImages(
  catalog: Pick<ModelCatalog, "options"> | undefined,
  capabilities: { images?: boolean } | undefined,
  selectedModel: string | undefined,
): boolean {
  if (capabilities?.images !== true) return false;
  const options = catalog?.options ?? [];
  const hasVisionEntries = options.some((o) => o.vision === true);
  if (!hasVisionEntries) return true;
  return options.some((o) => o.id === selectedModel && o.vision === true);
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  /** Refresh a live catalog without recreating the provider instance. */
  readonly refreshModels?: () => Promise<void>;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  /** Cheap one-shot text call (upstream TextGeneration) — titles, summaries. */
  generateText?(prompt: string): Promise<string>;
  dispose(): Promise<void>;
}

/** How an engine is presented in the picker rail.
 *  `subscription` — first-party cloud catalog; Custom is extra.
 *  `custom` — no subscription catalog; Custom is the product. */
export type EngineAccess = "subscription" | "custom";

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: {
    displayName: string;
    supportsMultipleInstances?: boolean;
    access?: EngineAccess;
  };
  /** How to get this engine installed. Omit for engines that need no local
   * binary (API-key drivers), which is what makes it optional. */
  readonly install?: EngineInstall;
  /** Decode the opaque config envelope; throw on invalid (→ shadow). The
   * envelope is driver-owned by design — each decodeConfig is its own parse
   * boundary, and the persisted shape is deliberately untyped here so no
   * single engine's schema leaks into the registry. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the raw envelope is the named contract; drivers own its decode
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

/** Configuration readiness for manual installation backups, not proof of
 * Google account ownership, successful transport, or portable recovery. */
export interface WorkspaceBackupCapability {
  capabilityVersion: 1;
  workspaceBackupAvailable: boolean;
  unavailableReason: string | null;
  /** Legacy account-linked flag stays false while that flow is contained. */
  drive: false;
  installationDrive: { configured: boolean; operationsAvailable: boolean };
  /** The signed-in user's own Google Drive (drive.appdata on their account
   * row). Available on local installs for any signed-in user; `connected`
   * says a Drive refresh token is already stored. Hosted keeps it off. */
  accountDrive: { available: boolean; connected: boolean };
}

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();

// ── follow-up queue snapshot (the composer's multi-item strip) ─────────
// The steer-queue's wire shape. The client renders ONLY this snapshot:
// what drained, was removed, or died with a restart is absent, never
// re-promised.

/** One send waiting for a busy bot: its persisted message id, the thread
 * it landed in, and the words (already visible in the transcript). */
export interface QueuedSendMessage {
  messageId: string;
  threadId: ThreadId;
  text: string;
}

export interface SteerQueueSnapshot {
  botId: string;
  /** The user's hold: a held queue is skipped by the drain until an
   * explicit resume releases it. */
  paused: boolean;
  items: QueuedSendMessage[];
}

// ── task plans: ordered checkpoints the client can steer ───────────────
// The wire shape of the durable task engine. A plan is an ordered list of
// at most twelve steps; a step can block on typed input or on a human
// approval, and both waits are persisted so a restart resumes exactly
// where the plan stopped instead of losing the question.

/** Plan lifecycle. Terminal: succeeded | cancelled. `failed` is resting
 * but retryable until the attempt budget runs out. */
export type TaskPlanStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

/** What a step is for. An `input` step collects a typed answer, an
 * `approval` step stops for a human decision, and a `checkpoint` is
 * ordered progress a worker reports as it goes. */
export type TaskStepKind = "checkpoint" | "input" | "approval";

export type TaskStepStatus = "pending" | "active" | "done" | "skipped" | "failed";

export interface TaskPlanStep {
  /** 1-based position; steps never renumber, so an answer or a
   * checkpoint can always name the exact step it belongs to. */
  n: number;
  title: string;
  kind: TaskStepKind;
  status: TaskStepStatus;
  startedAt?: number;
  finishedAt?: number;
}

/** One declared field of an input request: the typed shape an answer has
 * to satisfy, so a wrong answer is rejected instead of stored. */
export interface TaskPlanInputField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  /** Required unless the author says otherwise — an unanswered required
   * field is what makes the wait a wait. */
  required: boolean;
  options?: string[];
}

export interface TaskPlanInputRequest {
  prompt: string;
  fields: TaskPlanInputField[];
  /** The `n` of the step blocked on this answer. */
  step: number;
  askedAt: number;
}

export interface TaskPlanApprovalRequest {
  title: string;
  step: number;
  askedAt: number;
  by?: string;
}

/** At most one worker holds a running plan; the lease is what lets a
 * second claimant be refused rather than race the first. */
export interface TaskPlanLease {
  holder: string;
  expiresAt: number;
}

export interface TaskPlanAnswer {
  name: string;
  value: string | number | boolean;
  at: number;
}

export interface TaskPlanRecord {
  id: string;
  botId: string;
  ownerId?: string;
  threadId?: string;
  title: string;
  status: TaskPlanStatus;
  steps: TaskPlanStep[];
  /** The `n` of the step the plan is on, or null before anything ran. */
  currentStep: number | null;
  /** What the plan was doing when it was paused, so resume restores the
   * wait instead of quietly dropping the question that caused it. */
  pausedFrom?: TaskPlanStatus;
  lease?: TaskPlanLease;
  /** Failures so far; a plan refuses another retry at `maxAttempts`. */
  attempts: number;
  maxAttempts: number;
  inputRequest?: TaskPlanInputRequest;
  approvalRequest?: TaskPlanApprovalRequest;
  /** Typed answers collected so far, oldest first. */
  inputAnswers: TaskPlanAnswer[];
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** Client control verbs. `start` exists because recovery requeues work
 * that no worker is holding — without it a plan recovered from a restart
 * could never be picked up again. */
export type TaskControlAction = "start" | "pause" | "resume" | "cancel" | "retry";

export interface TaskControlBody {
  action: TaskControlAction;
  actorId?: string;
  reason?: string;
}

export interface TaskInputBody {
  /** One declared field, one primitive value: the engine coerces each
   * answer against its field's type before anything is stored. */
  answers: Record<string, string | number | boolean | null>;
  actorId?: string;
}

export interface TaskApprovalBody {
  decision: "approve" | "reject";
  actorId?: string;
  reason?: string;
}

/** One legal status move, kept in a bounded ring next to the plans so
 * "who moved this and when" survives the same restart the plan does. */
export interface TaskTransitionEvent {
  planId: string;
  botId: string;
  from: TaskPlanStatus;
  to: TaskPlanStatus;
  at: number;
  /** The verb that caused the move: start, pause, resume, cancel, retry,
   * complete, fail, request-input, submit-input, request-approval,
   * approve, reject, recover. */
  action: string;
  step?: number;
  actorId?: string;
  reason?: string;
}

/** A step as it arrives on the wire: a bare title, or an object the
 * engine validates, clamps and numbers. */
export type TaskPlanStepEntry = string | { title?: string; kind?: string };

/** One field of an input request as it arrives: the engine checks the
 * name, type and options against its own tables before asking anything. */
export interface TaskPlanFieldEntry {
  name?: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
}

/** POST /api/task-plans. Steps arrive as loose entries — a bare title or
 * an object with `title`/`kind` — because the engine is what validates,
 * clamps and numbers them; nothing on the wire is trusted as ordered. */
export interface TaskPlanCreateInput {
  botId: string;
  title?: string;
  steps: TaskPlanStepEntry[];
  ownerId?: string;
  threadId?: string;
  /** Leave false to hold the plan queued instead of starting it at once. */
  start?: boolean;
  /** Who the running plan is leased to. */
  actorId?: string;
  maxAttempts?: number;
}
