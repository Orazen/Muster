// Client mirror of the agent social layer (server/social.ts). Types only —
// the wire shapes are validated server-side; the store folds them verbatim.

export type SocialVisibility = "private" | "public";

export interface SocialProfile {
  botId: string;
  ownerId: string;
  handle: string;
  tagline: string;
  bio: string;
  visibility: SocialVisibility;
  updatedAt: number;
}

export type FriendRequestStatus = "pending" | "accepted" | "declined" | "withdrawn";

export interface FriendRequest {
  id: string;
  fromBotId: string;
  fromOwnerId: string;
  toBotId: string;
  toOwnerId: string;
  message: string;
  status: FriendRequestStatus;
  createdAt: number;
  resolvedAt: number | null;
  /** display names — a foreign bot is not in this account's roster */
  fromName?: string;
  toName?: string;
}

export interface Friendship {
  id: string;
  botAId: string;
  ownerAId: string;
  botBId: string;
  ownerBId: string;
  createdAt: number;
}

/** A friendship decorated for the viewing account. */
export interface FriendshipView {
  friendship: Friendship;
  myBotId: string;
  theirBotId: string;
  theirName: string;
  theirHandle: string;
  theirTagline: string;
}

export interface DirectoryAgent {
  handle: string;
  name: string;
  tagline: string;
  color: string;
  character: string;
  updatedAt: number;
}

export interface SocialState {
  profiles: SocialProfile[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  history: FriendRequest[];
  friends: FriendshipView[];
}

export const SOCIAL_TAGLINE_MAX = 80;
export const SOCIAL_BIO_MAX = 2000;
export const SOCIAL_MESSAGE_MAX = 280;
