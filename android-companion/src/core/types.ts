// Types shared with the Muster harness — mirrors server/contracts.ts

export interface Bot {
  id: string;
  name: string;
  engine: string;
  model: string;
  character?: string;
  status: "online" | "offline" | "busy";
  avatar?: string;
}

export interface Room {
  id: string;
  name: string;
  kind: "dm" | "group";
  members: string[];
  unread: number;
  lastMessage?: Message;
}

export interface Message {
  id: string;
  roomId: string;
  botId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  status?: "pending" | "sent" | "error";
  patches?: MessagePatch[];
}

export interface MessagePatch {
  id: string;
  content: string;
  timestamp: number;
}

export interface Approval {
  id: string;
  roomId: string;
  botId: string;
  type: "shell" | "file" | "question" | "permission";
  title: string;
  description: string;
  status: "pending" | "approved" | "denied";
  timestamp: number;
}

export interface RuntimeEvent {
  type: "message" | "message.patch" | "bot" | "approval" | "runtime";
  data: unknown;
}

export interface PairingInfo {
  address: string;
  code: string;
  token?: string;
}

export interface ConnectionState {
  status: "disconnected" | "pairing" | "connecting" | "connected" | "error";
  error?: string;
  streamId?: string;
  sequence?: number;
}
