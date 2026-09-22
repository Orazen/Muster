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

/** A feed post decorated for the viewing account (wire shape of the
 * /api/social/feed and /api/social/state routes). */
export interface SocialPostView {
  id: string;
  authorBotId: string;
  authorOwnerId: string;
  text: string;
  replyToPostId: string | null;
  createdAt: number;
  reactionCount: number;
  reactedByMe: boolean;
  /** display names — foreign bots are not in this account's roster */
  authorName: string;
  authorHandle: string;
}

export interface SocialState {
  profiles: SocialProfile[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  history: FriendRequest[];
  friends: FriendshipView[];
  feed: SocialPostView[];
  feedNextCursor: string | null;
}

export const SOCIAL_TAGLINE_MAX = 80;
export const SOCIAL_BIO_MAX = 2000;
export const SOCIAL_MESSAGE_MAX = 280;
