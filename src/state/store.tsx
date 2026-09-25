// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EffortLevel } from "../../server/contracts.ts";
import type { AgentCharacter, AgentColor } from "@/lib/mascot";
import type { Routine, RoutineInput, RoutineRun } from "@/lib/routines";
import type { SocialProfile, SocialPostView, SocialState } from "@/lib/social";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "@/lib/webhooks";
import { currentCall } from "@/lib/call";
import { soulMdFor, type AgentTemplate } from "@/lib/agent-templates";
import { seedDraft } from "@/lib/drafts";
import { showNotification } from "@/lib/notify";
import { speaker } from "@/lib/tts";
import { readChatSelection, resolveChatSelection, saveChatSelection } from "./chat-selection";
import { mergeSeedCardResult, SeedCardSession, seedCardReference, type SeedAnswer, type SeedCardReference, type SeedCardResult } from "./seed-card-session";
import { EMPTY_STOP_ACTION, StopCleanupSession } from "./stop-cleanup-session";

export type { AgentColor } from "@/lib/mascot";

export interface ApprovalWhy {
  source: "previous-run";
  runId: string;
  botId: string;
  threadId: string;
  at: number;
  intent: string;
  decisions: string[];
  outcome: "done" | "failed" | "partial";
  hypothesis?: string;
  findings?: string;
}

export interface OptionCardData {
  purpose?: string;
  seedAnswer?: SeedAnswer;
  why?: ApprovalWhy;
  rehearsal?: { plannedSteps: number; matchedSteps: number; matchedRuns: number; reviewedRuns: number; summary: string };
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  /** certify-lite evidence (ARC patterns §1.2): this bot's past with this
   * tool, from the decision ledger. Evidence, not a verdict. */
  history?: {
    total: number;
    approved: number;
    denied: number;
    auto: number;
    lastDecision: "approved" | "denied" | "auto" | null;
    summary: string | null;
  };
  /** Grounded desktop controls for this ask — a ranked, human-only choice
   * list plus evidence of what was detected on screen. Built server-side
   * from real detections; never an answer, never executed without a human
   * tap on the existing respond path. */
  suggestions?: Array<{ id: string; label: string; source: string; actionKind: string }>;
}

export interface ConnectorCardData {
  slug: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "compaction" | "privacy";
  text?: string;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying. */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  /** compaction messages: model-context summary marker (server-generated) */
  compaction?: { summary: string; firstKeptId: string; tokensBefore: number; at: number };
  /** privacy messages: what Privacy Shield masked before this turn left
   * for a cloud model. Counts only — the server never stores values. */
  privacy?: { secrets: number; emails: number; phones: number };
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: AgentColor };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: AgentColor };
  /** sent while the bot was mid-turn; auto-sends when the turn settles.
   * Rendered only while the bot is busy, so a flag stranded by a server
   * restart never shows a promise nothing will keep. */
  queued?: boolean;
  /** turn provenance: which engine + model actually produced this reply,
   * stamped by the server so the UI can show "who said that". */
  via?: { instanceId: string; model: string; effort?: string };
}

/** A bounded autonomy loop: one goal the bot works toward across turns
 * until it reports completion, fails, hits its round cap, or is stopped. */
export interface Goal {
  id: string;
  botId: string;
  threadId: string;
  text: string;
  status: "active" | "done" | "stopped" | "failed";
  rounds: number;
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
  lastOutcome?: string;
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** A room: several bots + you in one shared thread. */
export interface Group {
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  /** the room's shared desk — where member turns run their shell tools,
   * overriding each member's own folder; absent = each member's own */
  cwd?: string;
  /** folder the room's turns actually run in, pinned on the first turn;
   * null = each member's own default; absent = not pinned yet */
  pinnedCwd?: string | null;
  messages: Message[];
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
  /** what this task has spent, banked once per settled turn */
  usage?: TaskUsage;
  /** folder this task's turns run in, pinned on its first turn; null =
   * legacy home-folder session; absent = not pinned yet */
  cwd?: string | null;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** null until any turn reported a cost — most engines never do; records
   * from builds before cost existed lack the field entirely */
  costUsd: number | null;
  turns: number;
}

export interface Bot {
  id: string;
  threadId: string;
  /** every context this bot has, newest first */
  tasks?: Task[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: AgentColor;
  character?: AgentCharacter;
  mascotExpression?: string | null;
  unread: boolean;
  busy?: boolean;
  /** what the bot is doing, as the harness sees it; busy is derived from it */
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  modelSelection: ModelSelection;
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "vm" | "local" | "opensandbox" | "vps" | "off";
  /** where new tasks run their shell tools; absent = the private bot workspace */
  cwd?: string;
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
  /** tools this bot may always use without asking */
  alwaysAllow?: string[];
  /** speak this bot's replies aloud as they settle */
  speakReplies?: boolean;
  /** this bot's own voice id (falls back to the app-wide one) */
  voice?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** The workspace's one primary coordinator. */
  chiefOfStaff?: boolean;
  /** When this bot wants to talk to another bot (ask_bot/delegate_bot),
   * pause and ask the user first. Off by default. */
  approvePeerComms?: boolean;
  /** Whether this bot may use the workspace's connected apps. Unset means
   * allowed for existing bots; imported bots start with this disabled. */
  composio?: boolean;
  /** Privacy Shield: mask secrets/emails/phones before prompts reach a
   * cloud model (server-side, opt-in per bot). */
  privacyShield?: boolean;
  /** Muster Vault (lite): lifetime token budget. New turns are refused
   * once the bot's settled usage crosses it, until raised or cleared. */
  tokenBudget?: number | null;
  /** Daily USD spend cap (resets each calendar day). New turns are refused
   * once today's settled cost crosses it, until raised, cleared, or midnight. */
  dailyUsdCap?: number | null;
  /** Obscura browser: mount the 14 browser_* tools for this bot (local
   * installs where the `obscura` binary exists). */
  browser?: boolean;
  messages: Message[];
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
}

/** The visible conversation: walk parentId links from the active leaf back
 * to the root. Falls back to the flat list for pre-branching payloads. */
export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** All versions of a user message (itself + the forks that replaced it),
 * oldest first. Length 1 = never edited. */
export function messageVersions(bot: Bot, message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  return bot.messages
    .filter(
      (m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null),
    )
    .sort((a, b) => a.at - b.at);
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: { configured: boolean; mode?: "managed" | "self-hosted" | "unavailable" };
  /** The Muster Connector (self-hosted OpenConnector runtime). */
  openConnector?: { configured: boolean };
  box: { configured: boolean };
  opensandbox?: { configured: boolean };
  opencodeGo?: { configured: boolean };
  /** Opt-in identity bridge — see server/muster-cloud.ts. url is not a
   * secret (it's a server address, not a credential), shown back so the
   * Settings row can display what's actually configured. */
  musterCloud?: { configured: boolean; url: string };
  /** hi.new agent-mail: configured = a token is saved; name is the handle
   * it belongs to (a setting, not a secret). */
  hiNew?: { configured: boolean; name: string };
  providers?: Record<string, { configured: boolean }>;
  /** Voice (ElevenLabs). `configured` = a key is saved; `ready` = a key AND
   * a voice, which is what it takes to actually speak. The key itself is
   * never echoed back. */
  tts?: { configured: boolean; ready: boolean; voice: string };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string; about?: string };
  /** Server-side cap on every bot turn in a channel, in minutes. Direct
   * chats are exempt — they stop on silence via the stall watchdog. */
  channels?: { turnCapMinutes: number };
  /** Event-log retention (OMB parity): null = control OFF. The daily sweep
   * deletes archived-thread event logs past the threshold and/or trims each
   * log to the cap — never transcripts or the message database. */
  eventLogRetention?: { deleteArchivedAfterDays: number | null; trimToMib: number | null };
  /** Parallel threads per bot (OMB parity). Group threads never parallelize. */
  parallelThreads?: { default: number; perBot: Record<string, number> };
  /** Reasoning effort seeded into every NEW bot's model selection; null = engine default. */
  bots?: { defaultEffort: EffortLevel | null };
  /** BYO VPS computer; the alias is a setting, credentials stay in ssh(1). */
  vps?: { sshAlias: string };
  /** Storage-sovereignty gate (decision 14): required on hosted deployments,
   * satisfied once the user's own Drive (or install Telegram) is connected.
   * `options` reports what this deployment can actually offer, so the gate
   * modal never presents a connect action the server would refuse. */
  storageGate?: {
    required: boolean;
    satisfied: boolean;
    options?: {
      googleDrive: { available: boolean; connected: boolean };
      telegram: { configured: boolean };
    };
  };
}

/** How an engine gets installed — declared by its driver, mirrors
 * EngineInstall in server/contracts.ts. Absent for engines that need no
 * local binary. `command` omits platforms that have no one-liner. */
export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
    /** a reported cost on a subscription is notional; the UI says so */
    billing?: "metered" | "subscription";
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean; vision?: boolean; contextWindow?: number; maxTokens?: number }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    /** Engine reads images given by path — gates the composer's paste/drop
     * image affordance (see server/contracts.ts ProviderAdapter). */
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
  };
  /** `custom` agents sit below the rail divider — no subscription catalog. */
  access?: "subscription" | "custom";
  install?: EngineInstall;
  /** Configured CLI path override — set ONLY when the user overrode it;
   * absent means the driver default is in effect. */
  cli?: string;
  /** Driver's default binary name (e.g. "claude"). */
  cliDefault?: string;
  /** Absolute paths of every default binary found on PATH, PATH order. */
  cliCandidates?: string[];
}

export type AppSettingsSection =
  | "general"
  | "workspaces"
  | "localFirst"
  | "organisation"
  | "brain"
  | "appearance"
  | "experimental"
  | "connections"
  | "engines"
  | "providers"
  | "mcp"
  | "companion"
  | "remoteAccess"
  | "voice"
  | "computer"
  | "usage"
  | "vault"
  | "people"
  | "activity"
  | "backups"
  | "audit"
  | "why";

export interface AppState {
  bots: Bot[];
  groups: Group[];
  /** A successful roster snapshot has arrived for this account mount. */
  rosterHydrated: boolean;
  /** This provider renders conversations, rather than an OS overview. */
  readSelectedMessages: boolean;
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  activeView: "chat" | "routines" | "social";
  routines: Routine[];
  goals: Goal[];
  routineRuns: RoutineRun[];
  /** agent social layer state (profiles + friend graph); null until hydrated */
  social: SocialState | null;
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  /** the per-bot visible browser side panel (human watch/drive) */
  browserPanelOpen: boolean;
  /** the per-thread event inspector (runtime stream + native protocol tee) */
  inspectorOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  /** a search hit to scroll to once its thread is on screen; nonce lets the
   * same message be focused twice in a row */
  focusMessage: { threadId: string; messageId: string; nonce: number; consumed: boolean } | null;
  connected: boolean;
  error: string | null;
}

type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

interface PreparedUnreadAnnouncement<T> {
  record: T;
  markRead: boolean;
}

/** Decide whether a live unread announcement represents a visible chat.
 * Return an acknowledgement only for that case; never mutate SSE records. */
export function prepareUnreadAnnouncement<T extends { id: string; unread?: boolean }>(
  state: Pick<AppState, "readSelectedMessages" | "selectedId">,
  record: T,
): PreparedUnreadAnnouncement<T> {
  const markRead = state.readSelectedMessages && record.id === state.selectedId && Boolean(record.unread);
  return { record: markRead ? { ...record, unread: false } : record, markRead };
}

/** Fields a bot-settings PATCH may change; also what duplicateBot copies. */
type BotPatch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "notifications"
    | "computer"
    | "color"
    | "character"
    | "mascotExpression"
    | "autoApprove"
    | "speakReplies"
    | "voice"
    | "pinned"
    | "hidden"
    | "chiefOfStaff"
    | "approvePeerComms"
    | "composio"
    | "modelSelection"
  >
>;

export type Action =
  | { type: "hydrate"; bots: Bot[]; groups: Group[] }
  | { type: "showRoutines" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinePatched"; routine: Routine }
  | { type: "goalsHydrated"; goals: Goal[] }
  | { type: "goalPatched"; goal: Goal }
  | { type: "startGoal"; botId: string; text: string; maxRounds?: number }
  | { type: "stopGoal"; goalId: string }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "showSocial" }
  | { type: "socialHydrated"; social: SocialState }
  | { type: "socialProfilePatched"; profile: SocialProfile }
  | { type: "socialProfileDeleted"; botId: string }
  | { type: "socialRefresh" }
  | { type: "setSocialProfile"; input: { botId: string; tagline?: string; bio?: string; visibility: "private" | "public"; handle?: string } }
  | { type: "sendSocialPost"; input: { botId: string; text: string; replyToPostId?: string } }
  | { type: "reactSocialPost"; postId: string; botId: string }
  | { type: "loadMoreSocialPosts"; cursor: string }
  | { type: "socialFeedLoaded"; posts: SocialPostView[]; nextCursor: string | null }
  | { type: "sendFriendRequest"; input: { fromBotId: string; toHandle: string; message?: string } }
  | { type: "acceptFriendRequest"; requestId: string }
  | { type: "declineFriendRequest"; requestId: string }
  | { type: "withdrawFriendRequest"; requestId: string }
  | { type: "unfriend"; friendshipId: string }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "markRoutineRunSeen"; runId: string }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string; everyoneAnswers?: boolean }
  | { type: "sendGroup"; groupId: string; text: string }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "defaultResponder">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "toggleReaction"; threadId: string; messageId: string; emoji: string }
  | { type: "interruptGroup"; groupId: string }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string }
  | { type: "editMessage"; botId: string; messageId: string; text: string }
  | { type: "switchBranch"; botId: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "seedCardRecorded"; reference: SeedCardReference; result: SeedCardResult }
  | { type: "dismissCard"; botId: string; messageId: string }
  // permission cards answer by THREAD, so a request raised inside a room
  // can be answered the same way as one in a 1:1 chat
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** remember this exact grant (the server's allowKey) for the bot */
      alwaysAllow?: { botId: string; key: string };
    }
  | { type: "newTask"; botId: string }
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "taskSwitched"; bot: Bot }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot" }
  | { type: "hireTemplate"; template: AgentTemplate }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: BotAnnouncement }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleBrowserPanel"; open?: boolean }
  | { type: "toggleInspector"; open?: boolean }
  | { type: "focusMessage"; threadId: string; messageId: string }
  | { type: "focusMessageConsumed"; nonce: number }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection }
  | {
      type: "updateBot";
      botId: string;
      patch: BotPatch;
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      // Reconciliation snapshots (?messages=0) carry NO transcripts — they
      // exist only to refresh busy/activity truth. Merging them naively used
      // to WIPE every loaded transcript thirty seconds after load: the
      // "empty log while Working…" plague. When an incoming bot has no
      // messages, keep the ones already held; messages only grow server-side,
      // so a held transcript is never stale in the harmful direction.
      const prevById = new Map(state.bots.map((b) => [b.id, b]));
      const prevGroupById = new Map(state.groups.map((g) => [g.id, g]));
      // SAFETY: T is constrained to carry a messages array; the spread only
      // substitutes prev.messages (same shape) when incoming has none.
      const keepTranscripts = <T extends { id: string; messages?: unknown[] }>(
        incoming: T,
        prev?: T,
      ): T =>
        !incoming.messages?.length && prev?.messages?.length ? ({ ...incoming, messages: prev.messages } as T) : incoming;
      const bots = action.bots.map((b) => keepTranscripts(b, prevById.get(b.id)));
      const groups = (action.groups ?? []).map((g) => keepTranscripts(g, prevGroupById.get(g.id)));
      const selectedId = resolveChatSelection(state.selectedId, bots, groups);
      return { ...state, bots, groups, selectedId, rosterHydrated: true };
    }
    case "showRoutines":
      return {
        ...state,
        activeView: "routines",
        settingsOpen: false,
        computerOpen: false,
        browserPanelOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "showSocial":
      return {
        ...state,
        activeView: "social",
        settingsOpen: false,
        computerOpen: false,
        browserPanelOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "socialHydrated":
      return { ...state, social: action.social };
    case "socialProfilePatched": {
      if (!state.social) return state;
      const exists = state.social.profiles.some((p) => p.botId === action.profile.botId);
      return {
        ...state,
        social: {
          ...state.social,
          profiles: exists
            ? state.social.profiles.map((p) => (p.botId === action.profile.botId ? action.profile : p))
            : [...state.social.profiles, action.profile],
        },
      };
    }
    case "socialProfileDeleted":
      if (!state.social) return state;
      return { ...state, social: { ...state.social, profiles: state.social.profiles.filter((p) => p.botId !== action.botId) } };
    case "socialFeedLoaded":
      if (!state.social) return state;
      return {
        ...state,
        social: {
          ...state.social,
          feed: [...state.social.feed, ...action.posts.filter((p) => !state.social!.feed.some((f) => f.id === p.id))],
          feedNextCursor: action.nextCursor,
        },
      };
    case "routinesHydrated":
      return { ...state, routines: action.routines, routineRuns: action.runs };
    case "routinePatched": {
      const exists = state.routines.some((routine) => routine.id === action.routine.id);
      return {
        ...state,
        routines: exists
          ? state.routines.map((routine) => (routine.id === action.routine.id ? action.routine : routine))
          : [action.routine, ...state.routines],
      };
    }
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "goalsHydrated":
      return { ...state, goals: action.goals };
    case "goalPatched": {
      const exists = state.goals.some((goal) => goal.id === action.goal.id);
      return {
        ...state,
        goals: exists
          ? state.goals.map((goal) => (goal.id === action.goal.id ? action.goal : goal))
          : [action.goal, ...state.goals],
      };
    }
    case "routineRunPatched": {
      const exists = state.routineRuns.some((run) => run.id === action.run.id);
      const runs = exists
        ? state.routineRuns.map((run) => (run.id === action.run.id ? action.run : run))
        : [action.run, ...state.routineRuns];
      return { ...state, routineRuns: runs.sort((a, b) => b.scheduledFor - a.scheduledFor) };
    }
    case "webhooksHydrated":
      return { ...state, webhooks: action.webhooks, webhookAttempts: action.attempts, webhookIngress: action.ingress };
    case "webhookPatched": {
      const exists = state.webhooks.some((webhook) => webhook.id === action.webhook.id);
      return {
        ...state,
        webhooks: exists
          ? state.webhooks.map((webhook) => (webhook.id === action.webhook.id ? action.webhook : webhook))
          : [action.webhook, ...state.webhooks],
      };
    }
    case "webhookDeleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((webhook) => webhook.id !== action.webhookId),
        webhookAttempts: state.webhookAttempts.filter((attempt) => attempt.webhookId !== action.webhookId),
      };
    case "webhookAttempted": {
      const attempts = state.webhookAttempts.some((attempt) => attempt.id === action.attempt.id)
        ? state.webhookAttempts.map((attempt) => attempt.id === action.attempt.id ? action.attempt : attempt)
        : [...state.webhookAttempts, action.attempt];
      return { ...state, webhookAttempts: attempts.slice(-2_000) };
    }
    case "groupPatched": {
      const exists = state.groups.some((g) => g.id === action.group.id);
      // SAFETY: a group frame for an id the client has not yet seen carries
      // the full Group record — that is the stream's first-sight contract —
      // and the messages fallback covers frames that omit them.
      const groups = exists
        ? state.groups.map((g) => (g.id === action.group.id ? { ...g, ...action.group, messages: action.group.messages ?? g.messages } : g))
        : [{ ...(action.group as Group), messages: action.group.messages ?? [] }, ...state.groups];
      return { ...state, groups };
    }
    case "groupDeleted": {
      const groups = state.groups.filter((g) => g.id !== action.groupId);
      const selectedId = state.selectedId === action.groupId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, groups, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return { ...state, config: action.config };
    case "select": {
      if (state.groups.some((g) => g.id === action.id)) {
        return {
          ...state,
          activeView: "chat",
          selectedId: action.id,
          groups: state.groups.map((g) => (g.id === action.id && state.readSelectedMessages ? { ...g, unread: false } : g)),
        };
      }
      return updateBot(
        { ...state, activeView: "chat", selectedId: action.id },
        action.id,
        (b) => state.readSelectedMessages ? { ...b, unread: false } : b,
      );
    }
    // Live asks retain their existing behavior; seed cards settle only from a server receipt.
    case "answerCard": {
      const card = state.bots.find((bot) => bot.id === action.botId)?.messages.find((message) => message.id === action.messageId)?.card;
      if (!card?.requestId) return state;
      return patchCard(state, action.botId, action.messageId, { answered: action.answer });
    }
    case "seedCardRecorded":
      return mergeSeedCardResult(state, action.reference, action.result);
    case "dismissCard": {
      const card = state.bots.find((bot) => bot.id === action.botId)?.messages.find((message) => message.id === action.messageId)?.card;
      if (!card?.requestId) return state;
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    }
    case "decideRequest":
      return state; // the server's request.resolved patch settles the card
    case "botAdded":
      return {
        ...state,
        // An HTTP create/import response and its SSE broadcast can race. Fold
        // both paths without ever showing the same bot twice.
        bots: [action.bot, ...state.bots.filter((bot) => bot.id !== action.bot.id)],
        activeView: "chat",
        selectedId: action.bot.id,
      };
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bots, selectedId };
    }
    case "markUnread":
      return updateBot(state, action.botId, (b) => ({ ...b, unread: true }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      // Bot frames are complete except for their transcript. An unknown one
      // was created by another client (the phone, another app window, or a
      // team import), so add it now; the following message frames will fill
      // its greeting without waiting for a full-page hydration.
      if (!before) {
        return {
          ...state,
          bots: [{ ...action.bot, messages: action.bot.messages ?? [] }, ...state.bots],
        };
      }
      const next = action.bot.chiefOfStaff
        ? {
            ...state,
            bots: state.bots.map((b) =>
              b.id === action.bot.id ? b : { ...b, chiefOfStaff: false },
            ),
          }
        : state;
      const switchedThread = action.bot.threadId !== before.threadId;
      return updateBot(next, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        // Ordinary bot patches omit messages and must preserve the current
        // transcript. A task switch is different: its full bot event carries
        // the new transcript, which must replace the previous task before the
        // webhook's streamed messages begin arriving.
        messages:
          switchedThread && Array.isArray(action.bot.messages)
            ? action.bot.messages
            : b.messages,
      }));
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        // room thread — plain linear append, no branching/mascot machinery
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        if (group.messages.some((m) => m.id === action.message.id)) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id ? { ...g, messages: [...g.messages, action.message] } : g,
          ),
        };
      }
      // SSE replay and HTTP acknowledgements may repeat an older message
      // after a newer reply arrived. A duplicate is not a new append or a
      // branch selection; only threadActive may intentionally rewind it.
      if (bot.messages.some((message) => message.id === action.message.id)) return state;
      // every new server-side append chains onto (and becomes) the active leaf
      const next = updateBot(state, bot.id, (b) => {
        let messages = [...b.messages, action.message];
        // base64 screen frames are big; a long computer-use session would
        // grow memory without bound. Keep the newest few frames' pixels and
        // strip the rest (the message row survives as a placeholder).
        if (action.message.kind === "screen") {
          const withPng = messages.filter((m) => m.kind === "screen" && m.png);
          const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
          if (excess > 0) {
            const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
            messages = messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
          }
        }
        return { ...b, messages, activeLeafId: action.message.id };
      });
      return next;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? { ...g, messages: g.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : g,
          ),
        };
      }
      return updateBot(state, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "screenFrame":
      return {
        ...state,
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...state,
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...state,
        error: action.message,
      };
    // bot settings, the computer panel, and app settings share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        browserPanelOpen: open ? false : state.browserPanelOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "focusMessage":
      return {
        ...state,
        focusMessage: {
          threadId: action.threadId,
          messageId: action.messageId,
          nonce: (state.focusMessage?.nonce ?? 0) + 1,
          consumed: false,
        },
      };
    case "focusMessageConsumed":
      if (!state.focusMessage || state.focusMessage.nonce !== action.nonce) return state;
      return { ...state, focusMessage: { ...state.focusMessage, consumed: true } };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        browserPanelOpen: open ? false : state.browserPanelOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleInspector": {
      const open = action.open ?? !state.inspectorOpen;
      return {
        ...state,
        inspectorOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        browserPanelOpen: open ? false : state.browserPanelOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleBrowserPanel": {
      const open = action.open ?? !state.browserPanelOpen;
      return {
        ...state,
        browserPanelOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        appSettingsSection: action.section ?? state.appSettingsSection,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        browserPanelOpen: open ? false : state.browserPanelOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "updateBot": {
      const next = action.patch.chiefOfStaff
        ? {
            ...state,
            bots: state.bots.map((b) =>
              b.id === action.botId ? b : { ...b, chiefOfStaff: false },
            ),
          }
        : state;
      return updateBot(next, action.botId, (b) => ({ ...b, ...action.patch }));
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(state, bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    // optimistic leaf move; the server's thread frame confirms it later
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(state, action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    // optimistic room edits; the server's group frame confirms them later
    case "patchGroup":
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.patch } : g)),
      };
    case "toggleReaction": {
      const toggle = (m: Message): Message => {
        if (m.id !== action.messageId) return m;
        const reactions = m.reactions ?? [];
        const at = reactions.findIndex((r) => r.emoji === action.emoji && r.by === "user");
        const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji: action.emoji, by: "user" }];
        return { ...m, reactions: next.length ? next : undefined };
      };
      return {
        ...state,
        bots: state.bots.map((b) =>
          b.threadId === action.threadId ? { ...b, messages: b.messages.map(toggle) } : b,
        ),
        groups: state.groups.map((g) =>
          g.threadId === action.threadId ? { ...g, messages: g.messages.map(toggle) } : g,
        ),
      };
    }
    // handled entirely by the async wrapper
    case "send":
    case "editMessage":
      return state;
    case "newTask":
    case "switchTask":
    case "renameTask":
    case "deleteTask":
      return state;
    case "taskSwitched":
      return updateBot(state, action.bot.id, (bot) => ({ ...bot, ...action.bot, messages: action.bot.messages ?? [] }));
    case "newBot":
    case "hireTemplate":
    case "duplicateBot":
    case "interrupt":
    case "createGroup":
    case "sendGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "cancelRoutineRun":
    case "markRoutineRunSeen":
    case "startGoal":
    case "stopGoal":
    case "socialRefresh":
    case "setSocialProfile":
    case "sendSocialPost":
    case "reactSocialPost":
    case "loadMoreSocialPosts":
    case "sendFriendRequest":
    case "acceptFriendRequest":
    case "declineFriendRequest":
    case "withdrawFriendRequest":
    case "unfriend":
      return state;
  }
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;

export const initialState: AppState = {
  bots: [],
  groups: [],
  rosterHydrated: false,
  readSelectedMessages: true,
  instances: [],
  config: null,
  selectedId: "",
  activeView: "chat",
  routines: [],
  goals: [],
  routineRuns: [],
  social: null,
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  browserPanelOpen: false,
  inspectorOpen: false,
  appSettingsOpen: false,
  appSettingsSection: "general",
  screens: {},
  provisioning: {},
  focusMessage: null,
  connected: false,
  error: null,
};

// ── API client ─────────────────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // An expired session used to 401 every hydrate call into silent
    // .catch(() => {}) sinks — the user got a permanently EMPTY app
    // (blank transcript, no bots) instead of a login page. Bounce to
    // sign-in once, preserving where they were.
    if (res.status === 401 && !window.location.pathname.startsWith("/sign") && window.location.pathname !== "/pair") {
      window.location.href = `/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

/** Per-frame stream state lives in its OWN context: token frames update only
 * the components that read this hook (the chat's streaming tail), while every
 * useStore consumer — sidebar, mascots, pickers, the settled transcript —
 * keeps its render tree untouched during a stream. */
interface StreamState {
  /** in-flight assistant text per threadId */
  streaming: Record<string, string>;
  /** in-flight extended thinking per threadId (ephemeral) */
  reasoning: Record<string, string>;
}
const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {} };
const StreamContext = createContext<StreamState>(EMPTY_STREAM);

export function useStreaming() {
  return useContext(StreamContext);
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** Re-fetch engine availability — after an install, without a restart. */
  refreshInstances: () => Promise<void>;
  seedCards: SeedCardSession;
  stopCleanup: StopCleanupSession;
} | null>(null);

export function StoreProvider({ accountId, readSelectedMessages = true, children }: {
  accountId: string;
  readSelectedMessages?: boolean;
  children: ReactNode;
}) {
  // The authenticated wrapper keys this provider by account. Restore once:
  // later snapshots must preserve a newer live choice, not replay storage.
  const [state, rawDispatch] = useReducer(reducer, accountId, (id) => ({
    ...initialState,
    selectedId: readChatSelection(id),
    readSelectedMessages,
  }));
  useEffect(() => {
    saveChatSelection(accountId, state.selectedId);
  }, [accountId, state.selectedId]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const stopCleanup = useMemo(() => new StopCleanupSession({
    accountId,
    getAccountId: () => accountRef.current,
    getBot: (botId) => stateRef.current.rosterHydrated ? stateRef.current.bots.find((bot) => bot.id === botId) : undefined,
    request: (url, init) => fetch(url, init),
    onUnauthorized: () => {
      window.location.href = `/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    },
  }), [accountId]);
  useEffect(() => stopCleanup.attach(), [stopCleanup]);
  const [seedCards] = useState(() => new SeedCardSession({
    getState: () => stateRef.current,
    request: (url, init) => fetch(url, init),
    apply: (reference, result) => rawDispatch({ type: "seedCardRecorded", reference, result }),
  }));
  seedCards.sync(state);
  useEffect(() => seedCards.attach(), [seedCards]);
  // per-frame stream-delta batching (see the "runtime" SSE case); stream
  // state is intentionally OUTSIDE the reducer so token frames re-render
  // only StreamContext consumers
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const deltaBuffer = useRef(new Map<string, { text: string; reasoning: string }>());
  const deltaFlush = useRef<number | null>(null);
  const clearStream = (threadId: string) => {
    // Drop the thread's un-flushed deltas too: the settled message that
    // triggered this clear already contains them. Without this, the pending
    // rAF re-creates a "ghost" stream bubble holding the tail fragment —
    // it renders below any card/chip that settled next (so a permission
    // card looks glued to the top), keeps the caret blinking while the bot
    // is actually waiting, and the next block's deltas append onto the
    // duplicated tail instead of starting a fresh bubble.
    deltaBuffer.current.delete(threadId);
    setStream((prev) => {
      if (!(threadId in prev.streaming) && !(threadId in prev.reasoning)) return prev;
      const { [threadId]: _s, ...streaming } = prev.streaming;
      const { [threadId]: _r, ...reasoning } = prev.reasoning;
      return { streaming, reasoning };
    });
  };
  const flushDeltas = () => {
    if (deltaFlush.current !== null) {
      cancelAnimationFrame(deltaFlush.current);
      deltaFlush.current = null;
    }
    const buf = deltaBuffer.current;
    if (buf.size === 0) return;
    const entries = [...buf];
    buf.clear();
    setStream((prev) => {
      const streaming = { ...prev.streaming };
      const reasoning = { ...prev.reasoning };
      for (const [threadId, d] of entries) {
        if (d.text) streaming[threadId] = (streaming[threadId] ?? "") + d.text;
        if (d.reasoning) reasoning[threadId] = (reasoning[threadId] ?? "") + d.reasoning;
      }
      return { streaming, reasoning };
    });
  };

  // debounced PATCH per bot for text-field edits (name/title/description)
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: BotPatch }>());

  const dispatch = useMemo(() => {
    const showError = (e: Error) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    const wrapped: React.Dispatch<Action> = (action) => {
      if (action.type === "answerCard" || action.type === "dismissCard") {
        const card = stateRef.current.bots.find((bot) => bot.id === action.botId)?.messages.find((message) => message.id === action.messageId)?.card;
        if (!card?.requestId) {
          if (action.type === "answerCard") {
            const reference = seedCardReference(stateRef.current, action.botId, action.messageId);
            if (reference) void seedCards.answer(reference, action.answer);
          }
          return;
        }
      }
      rawDispatch(action);
      switch (action.type) {
        case "createRoutine":
          api("/api/routines", { method: "POST", body: JSON.stringify(action.input) }).catch(showError);
          break;
        case "updateRoutine":
          api(`/api/routines/${action.routineId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteRoutine":
          api(`/api/routines/${action.routineId}`, { method: "DELETE" }).catch(showError);
          break;
        case "runRoutine":
          api(`/api/routines/${action.routineId}/run`, { method: "POST" }).catch(showError);
          break;
        case "cancelRoutineRun":
          api(`/api/routine-runs/${action.runId}/cancel`, { method: "POST" }).catch(showError);
          break;
        case "markRoutineRunSeen":
          api(`/api/routine-runs/${action.runId}/seen`, { method: "POST" }).catch(showError);
          break;
        case "socialRefresh":
          api("/api/social/state")
            .then((social: SocialState) => rawDispatch({ type: "socialHydrated", social }))
            .catch(() => {});
          break;
        case "sendSocialPost":
          api("/api/social/posts", { method: "POST", body: JSON.stringify(action.input) })
            .then(() => rawDispatch({ type: "socialRefresh" }))
            .catch(showError);
          break;
        case "reactSocialPost":
          api(`/api/social/posts/${action.postId}/react`, { method: "POST", body: JSON.stringify({ botId: action.botId }) })
            .then(() => rawDispatch({ type: "socialRefresh" }))
            .catch(showError);
          break;
        case "loadMoreSocialPosts":
          api(`/api/social/feed?cursor=${encodeURIComponent(action.cursor)}`)
            .then(({ posts, nextCursor }: { posts: SocialPostView[]; nextCursor: string | null }) =>
              rawDispatch({ type: "socialFeedLoaded", posts, nextCursor }))
            .catch(showError);
          break;
        case "setSocialProfile":
          api("/api/social/profile", { method: "PUT", body: JSON.stringify(action.input) })
            .then(({ profile }: { profile: SocialProfile }) => profile && rawDispatch({ type: "socialProfilePatched", profile }))
            .catch(showError);
          break;
        case "sendFriendRequest":
          api("/api/social/friend-requests", { method: "POST", body: JSON.stringify(action.input) })
            .then(() => rawDispatch({ type: "socialRefresh" }))
            .catch(showError);
          break;
        case "acceptFriendRequest":
          api(`/api/social/friend-requests/${action.requestId}/accept`, { method: "POST" })
            .then(() => rawDispatch({ type: "socialRefresh" }))
            .catch(showError);
          break;
        case "declineFriendRequest":
          api(`/api/social/friend-requests/${action.requestId}/decline`, { method: "POST" })
            .then(() => rawDispatch({ type: "socialRefresh" }))
            .catch(showError);
          break;
        case "withdrawFriendRequest":
          api(`/api/social/friend-requests/${action.requestId}`, { method: "DELETE" })
            .then(() => rawDispatch({ type: "socialRefresh" }))
            .catch(showError);
          break;
        case "unfriend":
          api(`/api/social/friends/${action.friendshipId}`, { method: "DELETE" })
            .then(() => rawDispatch({ type: "socialRefresh" }))
            .catch(showError);
          break;
        case "startGoal":
          api(`/api/bots/${action.botId}/goal`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, maxRounds: action.maxRounds }),
          }).catch(showError);
          break;
        case "stopGoal":
          api(`/api/goals/${action.goalId}/stop`, { method: "POST" }).catch(showError);
          break;
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          })
            .then(({ message }: { message?: Message }) => {
              // Belt-and-braces echo: the SSE frame normally delivers the
              // user's bubble, but a missed or replayed frame must not hide
              // the send. messageAdded dedupes by id, so a later stream
              // copy of the same message is a no-op.
              if (!message) return;
              const bot = stateRef.current.bots.find((b) => b.id === action.botId);
              if (bot) rawDispatch({ type: "messageAdded", threadId: bot.threadId, message });
            })
            .catch(showError);
          break;
        case "editMessage":
          api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId }),
          }).catch(showError);
          break;
        case "decideRequest": {
          const respond = () =>
            api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: action.requestId,
                behavior: action.behavior,
                message: action.message,
              }),
            }).catch(showError);
          if (action.alwaysAllow) {
            const bot = stateRef.current.bots.find((b) => b.id === action.alwaysAllow!.botId);
            const next = [...new Set([...(bot?.alwaysAllow ?? []), action.alwaysAllow.key])];
            // save the grant BEFORE releasing the bot: it may ask again
            // within milliseconds, and a grant that hasn't landed yet
            // would make "always allow" ask a second time. A failed save
            // still lets this one through — losing a preference must not
            // strand the turn — but it says so.
            void api(`/api/bots/${action.alwaysAllow.botId}`, {
              method: "PATCH",
              body: JSON.stringify({ alwaysAllow: next }),
            })
              .catch(showError)
              .finally(respond);
            break;
          }
          void respond();
          break;
        }
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            const behavior =
              action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "hireTemplate": {
          // Agent Hub: create → apply the template's identity → drop the
          // persona as SOUL.md → pre-fill the first task → open the chat.
          // The identity PATCH is the load-bearing step (same two-call shape
          // as duplicateBot); a failed soul PUT leaves the PATCHed persona
          // in place — degraded, never broken.
          const t = action.template;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: t.name,
                  title: t.title,
                  description: t.role,
                  color: t.color,
                  character: t.character,
                }),
              }).then(({ bot: patched }) => {
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } });
                api(`/api/bots/${bot.id}/soul.md`, {
                  method: "PUT",
                  body: JSON.stringify({ text: soulMdFor(t) }),
                }).catch(() => {});
                seedDraft(`bot:${bot.id}`, t.firstTask);
                rawDispatch({ type: "select", id: bot.id });
              }),
            )
            .catch(showError);
          break;
        }
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          const copy: BotPatch = {
            name: `${source.name} copy`,
            title: source.title,
            description: source.description,
            notifications: source.notifications,
            modelSelection: source.modelSelection,
          };
          // a duplicate keeps the original's computer target, when one is set
          if (source.computer) copy.computer = source.computer;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify(copy),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          if (!stateRef.current.readSelectedMessages) break;
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          const group = stateRef.current.groups.find((g) => g.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          } else if (group?.unread) {
            api(`/api/groups/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({
              memberIds: action.memberIds,
              name: action.name,
              everyoneAnswers: action.everyoneAnswers,
            }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup":
          api(`/api/groups/${action.groupId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          })
            .then(({ message }: { message?: Message }) => {
              // same echo contract as the 1:1 "send" case above
              if (!message) return;
              const group = stateRef.current.groups.find((g) => g.id === action.groupId);
              if (group) rawDispatch({ type: "messageAdded", threadId: group.threadId, message });
            })
            .catch(showError);
          break;
        case "patchGroup":
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteGroup":
          api(`/api/groups/${action.groupId}`, { method: "DELETE" }).catch(showError);
          break;
        case "toggleReaction":
          api(`/api/threads/${action.threadId}/messages/${action.messageId}/reactions`, {
            method: "POST",
            body: JSON.stringify({ emoji: action.emoji, by: "user" }),
          }).catch(showError);
          break;
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          void stopCleanup.interrupt(action.botId);
          break;
        // tasks: the server answers with the bot AND the live transcript,
        // because switching changes which conversation is on screen
        case "newTask":
          api(`/api/bots/${action.botId}/tasks`, { method: "POST", body: "{}" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "switchTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "POST" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "deleteTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", bot: r.bot }))
            .catch(showError);
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) }).catch(showError);
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, [stopCleanup]);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const loadAll = () =>
      Promise.all([
        api("/api/bots")
          .then(({ bots, groups }) => alive && rawDispatch({ type: "hydrate", bots, groups: groups ?? [] }))
          .catch(() => {}),
        api("/api/instances")
          .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
          .catch(() => {}),
        api("/api/config")
          .then((config) => alive && rawDispatch({ type: "configStatus", config }))
          .catch(() => {}),
        api("/api/routines")
          .then(({ routines, runs }) => alive && rawDispatch({ type: "routinesHydrated", routines, runs }))
          .catch(() => {}),
        api("/api/goals")
          .then(({ goals }) => alive && rawDispatch({ type: "goalsHydrated", goals: goals ?? [] }))
          .catch(() => {}),
        api("/api/webhooks")
          .then(({ webhooks, attempts, ingress }) => alive && rawDispatch({ type: "webhooksHydrated", webhooks, attempts: attempts ?? [], ingress }))
          .catch(() => {}),
        api("/api/social/state")
          .then((social: SocialState) => alive && rawDispatch({ type: "socialHydrated", social }))
          .catch(() => {}),
      ]);

    // A snapshot and the live fold have to meet at a defined boundary. Start
    // hydration only after the stream says hello, queue frames that arrive
    // while the REST snapshot is in flight, then apply them on top. Otherwise
    // a late hydrate can overwrite a newer event, or an event can land between
    // an eager request and the stream opening and disappear entirely.
    let hydrated = false;
    let hydrating = false;
    let rehydrateRequested = false;
    const pendingFrames: any[] = [];
    let handleFrame: (frame: any) => void;
    // A `message` frame can outrun the announcement of its own thread when
    // a bot or room is created from another client/tab: folding it right
    // away found no carrier and dropped it silently. Park such frames
    // briefly and replay once the carrier lands, or discard after the
    // grace window (the old drop behavior, just delayed).
    const PARK_GRACE_MS = 2_000;
    const parkedMessages: { frame: any; timer: ReturnType<typeof setTimeout> }[] = [];
    const replayParked = () => {
      if (parkedMessages.length === 0) return;
      const entries = parkedMessages.splice(0);
      for (const entry of entries) {
        clearTimeout(entry.timer);
        // still-unknown threads re-park themselves inside the message case
        handleFrame(entry.frame);
      }
    };
    const hydrate = () => {
      if (hydrating) {
        // A second non-resumable hello means this snapshot may have started
        // before another connection gap. Run one more after it settles.
        rehydrateRequested = true;
        return;
      }
      hydrating = true;
      hydrated = false;
      void loadAll().finally(() => {
        if (!alive) return;
        hydrating = false;
        if (rehydrateRequested) {
          rehydrateRequested = false;
          hydrate();
          return;
        }
        hydrated = true;
        for (const frame of pendingFrames.splice(0)) handleFrame(frame);
        // a fresh snapshot may carry threads that parked frames were waiting on
        replayParked();
      });
    };
    // If SSE is unavailable, the app should still show its saved state. A
    // later first hello hydrates again because it cannot prove there was no
    // gap before that connection opened.
    const hydrationFallback = setTimeout(hydrate, 1_000);

    // Missed SSE frames used to leave ghosts: a bot shown "Working…" long
    // after its turn settled server-side (a deploy restart mid-turn was the
    // repeat offender). A tiny periodic reconciliation over /api/bots with
    // messages=0 carries no transcripts — just live busy/activity/model
    // truth — and quietly corrects whatever the stream failed to deliver.
    // Gated on !connected: while the SSE stream is healthy it is the
    // authority, and a wholesale reconcile every 30s discarded live local
    // state (e.g. an approval mid-answer) and re-rendered the whole app.
    const reconcile = () => {
      if (stateRef.current.connected) return;
      api("/api/bots?messages=0")
        .then(({ bots, groups }) => {
          if (!alive) return;
          rawDispatch({ type: "hydrate", bots, groups: groups ?? [] });
        })
        .catch(() => {});
    };
    const reconcileTimer = setInterval(reconcile, 30_000);

    const es = new EventSource("/api/events");
    // The hydrate decision belongs to the hello frame, not to onopen: the
    // server replays what we missed when it can, and re-downloading every
    // transcript on a reconnect it already covered is pure waste.
    es.onopen = () => { seedCards.connectionChanged(); rawDispatch({ type: "connected", value: true }); };
    es.onerror = () => { seedCards.connectionChanged(); rawDispatch({ type: "connected", value: false }); };
    handleFrame = (frame) => {
      switch (frame.kind) {
        case "message": {
          const threadKnown =
            stateRef.current.bots.some((b) => b.threadId === frame.threadId) ||
            stateRef.current.groups.some((g) => g.threadId === frame.threadId);
          if (!threadKnown) {
            const timer = setTimeout(() => {
              const idx = parkedMessages.findIndex((p) => p.frame === frame);
              if (idx !== -1) {
                parkedMessages.splice(idx, 1);
                // grace expired: one last try, then the reducer's unknown-
                // thread guard decides (same as pre-parking behavior)
                handleFrame(frame);
              }
            }, PARK_GRACE_MS);
            parkedMessages.push({ frame, timer });
            break;
          }
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          // a settled assistant bubble replaces the in-flight stream
          if (frame.message?.role === "bot" && frame.message?.kind === "text") {
            clearStream(frame.threadId);
            // Auto-speak lives HERE rather than in the chat view so a bot
            // you switched away from still reads its answer out — which is
            // the whole point of listening while you do something else. A
            // Auto-speak is disabled during any call. Call mode owns both the
            // singleton speaker and microphone ordering for its whole lifetime.
            const owner = stateRef.current.bots.find((b) => b.threadId === frame.threadId);
            if (owner?.speakReplies && currentCall() === null && frame.message.text?.trim()) {
              void speaker.speak(frame.message.text, {
                botId: owner.id,
                messageId: frame.message.id,
                voiceId: owner.voice,
              });
            }
          }
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          // a rewind also invalidates any half-streamed text from the old branch
          clearStream(frame.threadId);
          break;
        case "bot": {
          // SAFETY: a `bot` stream frame always carries the full announcement
          // payload — the stream's own envelope contract for kind "bot".
          const bot = frame.bot as BotAnnouncement;
          const { record: announcedBot, markRead } = prepareUnreadAnnouncement(stateRef.current, bot);
          if (markRead) {
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "botPatched", bot: announcedBot });
          // a new/updated thread may be what parked message frames await
          replayParked();
          break;
        }
        case "group": {
          // SAFETY: a `group` stream frame carries the group record with its
          // id; only the fields read below are depended on.
          const group = frame.group as Partial<Group> & { id: string };
          const { record: announcedGroup, markRead } = prepareUnreadAnnouncement(stateRef.current, group);
          if (markRead) {
            fetch(`/api/groups/${group.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "groupPatched", group: announcedGroup });
          replayParked();
          break;
        }
        // the harness decided this was worth interrupting for; the toggle
        // in each bot's settings is what gates it, server-side
        case "notify":
          // The wrapper persists read state only when this provider shows
          // conversations. Selecting a bot on the OS overview is not a read.
          showNotification(frame.notification, (botId) => dispatch({ type: "select", id: botId }));
          break;
        case "group.deleted":
          rawDispatch({ type: "groupDeleted", groupId: frame.groupId });
          break;
        case "routine":
          rawDispatch({ type: "routinePatched", routine: frame.routine });
          break;
        case "routine.deleted":
          rawDispatch({ type: "routineDeleted", routineId: frame.routineId });
          break;
        case "routine.run":
          rawDispatch({ type: "routineRunPatched", run: frame.run });
          break;
        case "goal":
          rawDispatch({ type: "goalPatched", goal: frame.goal });
          break;
        // ── agent social layer ──────────────────────────────────────────
        // Profile frames fold directly (they only ever reach their owner).
        // Request/friendship frames trigger a state re-read instead of a
        // hand-fold: the decorated names and incoming/outgoing split are
        // the server's job, and social traffic is rare enough that one GET
        // per transition is the honest, correct fold.
        case "social.profile":
          rawDispatch({ type: "socialProfilePatched", profile: frame.profile });
          break;
        case "social.profile.deleted":
          rawDispatch({ type: "socialProfileDeleted", botId: frame.botId });
          break;
        case "social.friendRequest":
        case "social.friendship":
        case "social.friendship.deleted":
        case "social.post":
        case "social.post.reaction":
        case "social.post.deleted":
          rawDispatch({ type: "socialRefresh" });
          break;
        case "webhook":
          rawDispatch({ type: "webhookPatched", webhook: frame.webhook });
          break;
        case "webhook.attempt":
          rawDispatch({ type: "webhookAttempted", attempt: frame.attempt });
          break;
        case "webhook.deleted":
          rawDispatch({ type: "webhookDeleted", webhookId: frame.webhookId });
          break;
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta") {
            // Batch token deltas per animation frame (t3code-style): a fast
            // stream dispatches once per frame instead of once per token, so
            // the app tree re-renders at most ~60x/s while streaming.
            const buf = deltaBuffer.current;
            const entry = buf.get(event.threadId) ?? { text: "", reasoning: "" };
            if (event.streamKind === "assistant_text") entry.text += event.delta;
            else if (event.streamKind === "reasoning_text") entry.reasoning += event.delta;
            buf.set(event.threadId, entry);
            if (deltaFlush.current === null) {
              deltaFlush.current = requestAnimationFrame(() => {
                deltaFlush.current = null;
                flushDeltas();
              });
            }
          } else if (event.type === "turn.completed") {
            // flush any buffered tail before clearing so no tokens are lost
            flushDeltas();
            clearStream(event.threadId);
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: {
              xai: frame.xai,
              composio: frame.composio,
              box: frame.box,
              tts: frame.tts,
              profile: frame.profile,
            },
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    es.onmessage = (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      // `hello` is the snapshot boundary. A false `resumed` means the server
      // could not fill the gap, so queue subsequent frames behind a hydrate.
      if (frame.kind === "hello") {
        clearTimeout(hydrationFallback);
        if (!frame.resumed) hydrate();
        return;
      }
      if (hydrated) handleFrame(frame);
      else pendingFrames.push(frame);
    };
    return () => {
      alive = false;
      clearTimeout(hydrationFallback);
      clearInterval(reconcileTimer);
      for (const entry of parkedMessages) clearTimeout(entry.timer);
      es.close();
    };
  }, []);

  // Re-probe the engines on demand. A CLI installed while the app is running
  // is invisible until something asks again — the setup screens expose this
  // as "Check again" so the user isn't told to restart when a refresh will do.
  const refreshInstances = useCallback(async () => {
    try {
      const { instances } = await api("/api/instances");
      rawDispatch({ type: "instances", instances });
    } catch {
      /* offline or server down — the existing list stays */
    }
  }, []);

  // Installing a CLI or signing one in happens in a terminal, outside this
  // window — so the moment the user comes back is exactly when our engine
  // snapshot is most likely stale. Re-probe on focus, throttled so that
  // ordinary alt-tabbing doesn't spawn a `--version` call per switch.
  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 3000) return;
      lastFocusProbe.current = now;
      void refreshInstances();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInstances]);

  const value = useMemo(() => ({ state, dispatch, refreshInstances, seedCards, stopCleanup }), [state, dispatch, refreshInstances, seedCards, stopCleanup]);
  return (
    <StoreContext.Provider value={value}>
      <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function useStopCleanup(botId?: string) {
  const { stopCleanup } = useStore();
  const actions = useSyncExternalStore(stopCleanup.subscribe, stopCleanup.getSnapshot, stopCleanup.getSnapshot);
  return { stopCleanup, action: botId ? actions[botId] ?? EMPTY_STOP_ACTION : EMPTY_STOP_ACTION };
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
