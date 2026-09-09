// Wire types mirroring ios/Sources/CompanionCore/Models.swift.
// Every field is lossy: unknown JSON keys are dropped, missing keys stay
// undefined, so new server fields never break the phone.

export type Role = "bot" | "user";
export type MessageKind = "text" | "options" | "activity" | "screen" | "unknown";

export interface OptionCard {
  title: string;
  subtitle?: string;
  options: string[];
  answered?: string | null;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: boolean;
  allowKey?: string;
}

export interface ToolActivity {
  name: string;
  ok?: boolean;
  spoken?: boolean;
  setup?: boolean;
}

export interface Sender {
  botId?: string;
  name?: string;
  color?: string;
}

export interface Reaction {
  emoji: string;
  by: string;
}

export interface CommChip {
  groupId: string;
  withBotId?: string;
  withName?: string;
  withColor?: string;
}

export interface Message {
  id: string;
  role: Role;
  kind: MessageKind;
  at: number;
  text?: string;
  card?: OptionCard | null;
  tool?: ToolActivity | null;
  parentId?: string | null;
  from?: Sender | null;
  reactions?: Reaction[] | null;
  comm?: CommChip | null;
  hasImage?: boolean;
  png?: string | null;
  mime?: string | null;
}

export function isCardPending(card: OptionCard): boolean {
  return card.answered == null && card.dismissed !== true;
}

export function isPermissionCard(card: OptionCard): boolean {
  return card.tool != null;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface BotTask {
  threadId: string;
  title: string;
  createdAt: number;
}

export interface Bot {
  id: string;
  threadId: string;
  name: string;
  title?: string;
  description?: string;
  notifications?: boolean;
  color?: string;
  unread?: number;
  modelSelection?: ModelSelection | null;
  createdAt?: number;
  busy?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  computer?: string | null;
  speakReplies?: boolean;
  voice?: string | null;
  mascotExpression?: string | null;
  tasks?: BotTask[];
  messages?: Message[];
  activeLeafId?: string | null;
  hasMore?: boolean;
}

export interface GroupResponder {
  kind: string;
  botId?: string;
}

export interface Room {
  id: string;
  threadId: string;
  name?: string;
  memberIds: string[];
  defaultResponder: GroupResponder;
  bulletin?: string | null;
  unread?: number;
  createdAt?: number;
  dm?: boolean;
  busyBotId?: string | null;
  messages?: Message[];
  hasMore?: boolean;
}

export interface Fleet {
  bots: Bot[];
  groups: Room[];
}

export interface ThreadPage {
  messages: Message[];
  hasMore?: boolean;
}

export interface InstanceModelOption {
  id: string;
  label: string;
}

export interface ModelCatalog {
  default: string;
  options: InstanceModelOption[];
}

export interface ProviderSnapshot {
  state: string;
  reason?: string | null;
  authenticated?: boolean;
  version?: string | null;
}

export interface Instance {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
}

export interface PairedDevice {
  id: string;
  name: string;
  createdAt?: number;
  lastSeenAt?: number;
}

export interface PairResponse {
  token: string;
  device: PairedDevice;
  serverName?: string;
}

export type NotifyKind = string;

export interface NotificationFrame {
  kind: NotifyKind;
  botId?: string;
  botName?: string;
  threadId?: string;
  title?: string;
  body?: string;
}

export interface RuntimeEvent {
  type: string;
  threadId?: string;
  delta?: string;
  streamKind?: string;
}

export interface ConfigFlag {
  enabled?: boolean;
}

export interface ConfigStatus {
  composio?: ConfigFlag | null;
  box?: ConfigFlag | null;
  tts?: ConfigFlag | null;
}

export interface ScreenFrame {
  botId: string;
  png: string;
  mime?: string;
}
