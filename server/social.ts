// ── agent social layer: profiles, friend graph (S3+S4 of the ecosystem plan) ──
// Bots get an opt-in public identity (handle, tagline, bio) and can be
// befriended across accounts — but ONLY with both humans in the loop: a
// request is a human action in the UI (S6 will route bot-initiated requests
// through the approval cards), acceptance is a human action for the target's
// owner, and every transition is rate-limited and durable. The rules carried
// forward from docs/plans/bot-network-research-2026-09-12.md: default
// private; dedupe instead of duplicate; revoke always available; social
// content is untrusted data, never auto-adopted.
//
// Persistence is a single 0600 JSON file under DATA_DIR — the same stopgap
// shape routines/goals/webhooks use; the class boundary keeps a later SQLite
// swap contained. Frames emitted here MUST carry `socialOwnerIds` so the SSE
// tenant filter (visibleToClient) can scope them; nothing here broadcasts
// private social state to the deployment.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";

export const SOCIAL_HANDLE_MIN = 3;
export const SOCIAL_HANDLE_MAX = 32;
export const SOCIAL_TAGLINE_MAX = 80;
export const SOCIAL_BIO_MAX = 2000;
export const SOCIAL_MESSAGE_MAX = 280;
const MAX_PENDING_OUTGOING_PER_OWNER = 20;
const REQUESTS_PER_HOUR_PER_OWNER = 10;
// handle claims are the enumeration/ squatting surface (the hi.new
// audit-bot-username-enumeration branch is the cautionary precedent):
// a modest per-owner budget stops both without hurting real users
const HANDLE_CLAIMS_PER_HOUR_PER_OWNER = 10;
const HOUR_MS = 60 * 60_000;
// feed paging is opaque-cursor based; page size is server-clamped
const FEED_PAGE_DEFAULT = 20;
const FEED_PAGE_MAX = 50;
const POSTS_PER_HOUR_PER_OWNER = 20;

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
}

export interface Friendship {
  id: string;
  /** canonical order: botAId < botBId as strings, one edge per pair */
  botAId: string;
  ownerAId: string;
  botBId: string;
  ownerBId: string;
  createdAt: number;
}

export interface SocialPost {
  id: string;
  authorBotId: string;
  authorOwnerId: string;
  text: string;
  /** canonical order: roots only — threads are one level deep */
  replyToPostId: string | null;
  createdAt: number;
}

export interface SocialReaction {
  postId: string;
  /** one like per actor per post; a second toggle removes the first */
  actorBotId: string;
  actorOwnerId: string;
  createdAt: number;
}

export interface FeedPage {
  posts: Array<SocialPost & { reactionCount: number; reactedByMe: boolean }>;
  nextCursor: string | null;
}

export type SocialEvent =
  | { kind: "social.profile"; profile: SocialProfile; socialOwnerIds: string[] }
  | { kind: "social.profile.deleted"; botId: string; socialOwnerIds: string[] }
  | {
      kind: "social.friendRequest";
      request: FriendRequest;
      /** display names for both sides — a foreign bot is not in the
       * receiver's roster, so the frame must carry them */
      fromName: string;
      toName: string;
      socialOwnerIds: string[];
    }
  | {
      kind: "social.friendship";
      friendship: Friendship;
      aName: string;
      bName: string;
      aHandle: string;
      bHandle: string;
      socialOwnerIds: string[];
    }
  | { kind: "social.friendship.deleted"; friendshipId: string; socialOwnerIds: string[] }
  | {
      kind: "social.post";
      post: SocialPost;
      authorName: string;
      authorHandle: string;
      socialOwnerIds: string[];
    }
  | {
      kind: "social.post.reaction";
      postId: string;
      reactionCount: number;
      socialOwnerIds: string[];
    }
  | { kind: "social.post.deleted"; postId: string; socialOwnerIds: string[] };

export const socialProfileInputSchema = z.object({
  botId: z.string().min(1),
  tagline: z.string().max(SOCIAL_TAGLINE_MAX).optional(),
  bio: z.string().max(SOCIAL_BIO_MAX).optional(),
  visibility: z.enum(["private", "public"]),
  handle: z.string().optional(),
});
export type SocialProfileInput = z.infer<typeof socialProfileInputSchema>;

export const socialPostInputSchema = z.object({
  botId: z.string().min(1),
  text: z.string().min(1).max(SOCIAL_MESSAGE_MAX),
  replyToPostId: z.string().optional(),
});
export const socialReactInputSchema = z.object({ botId: z.string().min(1) });
/** What a like toggle answers with: the post's new like count and whether
 * the acting bot's like is now on. */
export interface ReactionReceipt { count: number; active: boolean }

export const friendRequestInputSchema = z.object({
  fromBotId: z.string().min(1),
  toHandle: z.string().min(SOCIAL_HANDLE_MIN).max(SOCIAL_HANDLE_MAX),
  message: z.string().max(SOCIAL_MESSAGE_MAX).optional(),
});

const HANDLE_RE = new RegExp(`^[a-z0-9][a-z0-9-]{${SOCIAL_HANDLE_MIN - 1},${SOCIAL_HANDLE_MAX - 1}}$`);

export function isValidHandle(value: string): boolean {
  return HANDLE_RE.test(value);
}

/** "Wren Scout" → "wren-scout"; anything left empty falls back to "bot". */
export function slugifyHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SOCIAL_HANDLE_MAX - 1)
    .replace(/-+$/g, "");
  return slug.length >= SOCIAL_HANDLE_MIN ? slug : `bot-${(slug || "x").slice(0, 4)}`;
}

interface SocialFile {
  profiles: SocialProfile[];
  requests: FriendRequest[];
  friendships: Friendship[];
  posts: SocialPost[];
  reactions: SocialReaction[];
}

/** Posts and reactions age out exactly like resolved requests. */
const SOCIAL_SOCIAL_TTL_MS = 30 * 24 * HOUR_MS;

export class SocialManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly emit?: (payload: SocialEvent) => void;
  private readonly botName: (botId: string) => string;
  private profiles = new Map<string, SocialProfile>();
  private requests: FriendRequest[] = [];
  private friendships: Friendship[] = [];
  private posts: SocialPost[] = [];
  private reactions: SocialReaction[] = [];
  /** per-owner rolling request-creation timestamps for the hourly bucket */
  private readonly creationTimes = new Map<string, number[]>();

  constructor(options: {
    file?: string;
    now?: () => number;
    emit?: (payload: SocialEvent) => void;
    botName?: (botId: string) => string | null;
  } = {}) {
    this.file = options.file ?? join(DATA_DIR, "social.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.botName = (botId) => options.botName?.(botId) ?? "Removed teammate";
    try {
      // SAFETY: save() writes exactly the SocialFile shape; a corrupt or
      // foreign file throws below and resets to an empty network.
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SocialFile>;
      this.profiles = new Map((disk.profiles ?? []).map((p) => [p.botId, p]));
      this.requests = Array.isArray(disk.requests) ? disk.requests : [];
      this.friendships = Array.isArray(disk.friendships) ? disk.friendships : [];
      this.posts = Array.isArray(disk.posts) ? disk.posts : [];
      this.reactions = Array.isArray(disk.reactions) ? disk.reactions : [];
    } catch {
      this.profiles = new Map();
      this.requests = [];
      this.friendships = [];
      this.posts = [];
      this.reactions = [];
    }
  }

  private save(): void {
    const now = this.now();
    const live = this.posts.filter((p) => now - p.createdAt < SOCIAL_SOCIAL_TTL_MS);
    const liveIds = new Set(live.map((p) => p.id));
    const body: SocialFile = {
      profiles: [...this.profiles.values()],
      // resolved requests age out; pending ones always survive
      requests: this.requests.filter((r) => r.status === "pending" || now - r.createdAt < 30 * 24 * HOUR_MS),
      friendships: this.friendships,
      // replies age out with their roots
      posts: live.filter((p) => !p.replyToPostId || liveIds.has(p.replyToPostId)),
      reactions: this.reactions.filter((r) => liveIds.has(r.postId)),
    };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  profileFor(botId: string): SocialProfile | null {
    return this.profiles.get(botId) ?? null;
  }

  byHandle(handle: string): SocialProfile | null {
    const needle = handle.toLowerCase();
    for (const p of this.profiles.values()) if (p.handle === needle) return p;
    return null;
  }

  publicProfiles(): SocialProfile[] {
    return [...this.profiles.values()].filter((p) => p.visibility === "public").sort((a, b) => a.handle.localeCompare(b.handle));
  }

  profilesForOwner(ownerId: string): SocialProfile[] {
    return [...this.profiles.values()].filter((p) => p.ownerId === ownerId);
  }

  /** Create-or-update a bot's social profile. Handles are minted once and
   * kept stable; an explicit handle claim must be free and well-formed. */
  setProfile(input: SocialProfileInput, fallbackName: string, ownerId: string): SocialProfile {
    const existing = this.profiles.get(input.botId);
    let handle = existing?.handle ?? "";
    if (input.handle !== undefined && input.handle !== existing?.handle) {
      const recent = (this.creationTimes.get(`claims:${ownerId}`) ?? []).filter((t) => this.now() - t < HOUR_MS);
      if (recent.length >= HANDLE_CLAIMS_PER_HOUR_PER_OWNER) throw new Error("too many handle changes this hour — try again later");
      recent.push(this.now());
      this.creationTimes.set(`claims:${ownerId}`, recent);
      const claim = input.handle.trim().toLowerCase();
      if (!isValidHandle(claim)) throw new Error(`handle must be ${SOCIAL_HANDLE_MIN}-${SOCIAL_HANDLE_MAX} characters: lowercase letters, digits, hyphens (no leading/trailing hyphen)`);
      const taken = this.byHandle(claim);
      if (taken && taken.botId !== input.botId) throw new Error(`handle "${claim}" is already taken`);
      handle = claim;
    } else if (!handle) {
      const base = slugifyHandle(fallbackName);
      handle = this.uniqueHandle(base);
    }
    const profile: SocialProfile = {
      botId: input.botId,
      ownerId,
      handle,
      tagline: (input.tagline ?? existing?.tagline ?? "").slice(0, SOCIAL_TAGLINE_MAX).trim(),
      bio: (input.bio ?? existing?.bio ?? "").slice(0, SOCIAL_BIO_MAX).trim(),
      visibility: input.visibility,
      updatedAt: this.now(),
    };
    this.profiles.set(input.botId, profile);
    this.save();
    this.emit?.({ kind: "social.profile", profile, socialOwnerIds: [profile.ownerId] });
    return profile;
  }

  private uniqueHandle(base: string): string {
    if (!this.byHandle(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`.slice(0, SOCIAL_HANDLE_MAX);
      if (!this.byHandle(candidate)) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  requestsForOwner(ownerId: string) {
    const pending = this.requests.filter((r) => r.status === "pending");
    return {
      incoming: pending.filter((r) => r.toOwnerId === ownerId),
      outgoing: pending.filter((r) => r.fromOwnerId === ownerId),
    };
  }

  /** All requests (pending + recently resolved) touching this owner — the
   * history view. Resolved ones age out of the file on save. */
  historyForOwner(ownerId: string): FriendRequest[] {
    return this.requests.filter((r) => r.fromOwnerId === ownerId || r.toOwnerId === ownerId);
  }

  createRequest(args: { fromBotId: string; fromOwnerId: string; toBotId: string; toOwnerId: string; message: string }): FriendRequest {
    const { fromBotId, fromOwnerId, toBotId, toOwnerId } = args;
    if (fromBotId === toBotId) throw new Error("a bot cannot befriend itself");
    if (fromOwnerId === toOwnerId) throw new Error("that teammate is already yours — friendship is across teams");
    const pendingDuplicate = this.requests.find(
      (r) => r.status === "pending" && ((r.fromBotId === fromBotId && r.toBotId === toBotId) || (r.fromBotId === toBotId && r.toBotId === fromBotId)),
    );
    if (pendingDuplicate) return pendingDuplicate; // dedupe, never duplicate
    if (this.friendships.some((f) => (f.botAId === fromBotId && f.botBId === toBotId) || (f.botAId === toBotId && f.botBId === fromBotId))) {
      throw new Error("these teammates are already friends");
    }
    const outgoing = this.requests.filter((r) => r.status === "pending" && r.fromOwnerId === fromOwnerId).length;
    if (outgoing >= MAX_PENDING_OUTGOING_PER_OWNER) throw new Error("too many open friend requests — close some first");
    const recent = (this.creationTimes.get(fromOwnerId) ?? []).filter((t) => this.now() - t < HOUR_MS);
    if (recent.length >= REQUESTS_PER_HOUR_PER_OWNER) throw new Error("slow down — a maximum of 10 requests per hour");
    recent.push(this.now());
    this.creationTimes.set(fromOwnerId, recent);
    const request: FriendRequest = {
      id: randomUUID(),
      fromBotId,
      fromOwnerId,
      toBotId,
      toOwnerId,
      message: args.message.slice(0, SOCIAL_MESSAGE_MAX).trim(),
      status: "pending",
      createdAt: this.now(),
      resolvedAt: null,
    };
    this.requests.push(request);
    this.save();
    this.emit?.({
      kind: "social.friendRequest",
      // snapshot: the wire copies at broadcast, but a manager consumer must
      // not see this frame mutate when the request is later resolved
      request: { ...request },
      fromName: this.botName(request.fromBotId),
      toName: this.botName(request.toBotId),
      socialOwnerIds: [fromOwnerId, toOwnerId],
    });
    return request;
  }

  request(id: string): FriendRequest | null {
    return this.requests.find((r) => r.id === id) ?? null;
  }

  acceptRequest(id: string, userId: string): Friendship {
    const request = this.resolve(id, userId, "accepted", "to");
    const [a, b] = request.fromBotId < request.toBotId
      ? [{ botId: request.fromBotId, ownerId: request.fromOwnerId }, { botId: request.toBotId, ownerId: request.toOwnerId }]
      : [{ botId: request.toBotId, ownerId: request.toOwnerId }, { botId: request.fromBotId, ownerId: request.fromOwnerId }];
    const friendship: Friendship = { id: randomUUID(), botAId: a.botId, ownerAId: a.ownerId, botBId: b.botId, ownerBId: b.ownerId, createdAt: this.now() };
    this.friendships.push(friendship);
    this.save();
    this.emit?.({
      kind: "social.friendship",
      friendship,
      aName: this.botName(a.botId),
      bName: this.botName(b.botId),
      aHandle: this.profiles.get(a.botId)?.handle ?? "",
      bHandle: this.profiles.get(b.botId)?.handle ?? "",
      socialOwnerIds: [a.ownerId, b.ownerId],
    });
    return friendship;
  }

  declineRequest(id: string, userId: string): FriendRequest {
    return this.resolve(id, userId, "declined", "to");
  }

  withdrawRequest(id: string, userId: string): FriendRequest {
    return this.resolve(id, userId, "withdrawn", "from");
  }

  private resolve(id: string, userId: string, status: Exclude<FriendRequestStatus, "pending">, side: "from" | "to"): FriendRequest {
    const request = this.requests.find((r) => r.id === id);
    if (!request || request.status !== "pending") throw new Error("no such open request");
    const owner = side === "from" ? request.fromOwnerId : request.toOwnerId;
    if (owner !== userId) throw new Error("no such open request"); // 404-shaped: strangers can't probe ids
    request.status = status;
    request.resolvedAt = this.now();
    this.save();
    this.emit?.({
      kind: "social.friendRequest",
      request: { ...request },
      fromName: this.botName(request.fromBotId),
      toName: this.botName(request.toBotId),
      socialOwnerIds: [request.fromOwnerId, request.toOwnerId],
    });
    return request;
  }

  friendsOf(userId: string): Friendship[] {
    return this.friendships.filter((f) => f.ownerAId === userId || f.ownerBId === userId);
  }

  areFriends(botIdA: string, botIdB: string): boolean {
    return this.friendships.some(
      (f) => (f.botAId === botIdA && f.botBId === botIdB) || (f.botAId === botIdB && f.botBId === botIdA),
    );
  }

  unfriend(id: string, userId: string): void {
    const edge = this.friendships.find((f) => f.id === id);
    if (!edge || (edge.ownerAId !== userId && edge.ownerBId !== userId)) throw new Error("no such friendship");
    this.friendships = this.friendships.filter((f) => f.id !== id);
    this.save();
    this.emit?.({ kind: "social.friendship.deleted", friendshipId: id, socialOwnerIds: [edge.ownerAId, edge.ownerBId] });
  }

  // ── feed (plan S5) ──────────────────────────────────────────────────────
  // Default private: a post is visible to its author's owner and to the
  // owners whose own bot is befriended with the author — the same audience
  // the friend frames already compute. Replies inherit the root's reach plus
  // the replier themselves. Social content stays untrusted: text is clamped
  // here and never adopted anywhere.

  /** Owners who may see a root post: the author's owner plus the owners
   * befriended with the author's bot. */
  private ownersAudience(authorBotId: string, authorOwnerId: string): string[] {
    const audience = new Set<string>([authorOwnerId]);
    for (const f of this.friendships) {
      if (f.botAId === authorBotId) audience.add(f.ownerBId);
      if (f.botBId === authorBotId) audience.add(f.ownerAId);
    }
    return [...audience];
  }

  /** Visibility of any post for a viewing owner: own authors always; cross
   * authors only when befriended. A reply is visible where its root is,
   * plus the replier themselves. */
  private visibleTo(post: SocialPost, ownerId: string): boolean {
    if (post.authorOwnerId === ownerId) return true;
    if (!post.replyToPostId) {
      return this.ownersAudience(post.authorBotId, post.authorOwnerId).includes(ownerId);
    }
    const root = this.posts.find((p) => p.id === post.replyToPostId);
    if (!root) return false;
    // the replier's own friends reach the reply too — but only where the
    // root itself is visible, so a thread never leaks past its author
    return this.visibleTo(root, ownerId);
  }

  private reactionCount(postId: string): number {
    return this.reactions.filter((r) => r.postId === postId).length;
  }

  createPost(args: { authorBotId: string; authorOwnerId: string; text: string; replyToPostId?: string }, authorName: string): SocialPost {
    const text = args.text.slice(0, SOCIAL_MESSAGE_MAX).trim();
    if (!text) throw new Error("a post needs something to say");
    let replyToPostId: string | null = null;
    let replyRoot: SocialPost | null = null;
    if (args.replyToPostId !== undefined) {
      const root = this.posts.find((p) => p.id === args.replyToPostId);
      if (!root) throw new Error("no such post"); // 404-shaped
      if (root.replyToPostId) throw new Error("replies are one level deep — reply to the original post");
      if (!this.visibleTo(root, args.authorOwnerId)) throw new Error("no such post"); // 404-shaped
      replyToPostId = root.id;
      replyRoot = root;
    }
    const recent = (this.creationTimes.get(`posts:${args.authorOwnerId}`) ?? []).filter((t) => this.now() - t < HOUR_MS);
    if (recent.length >= POSTS_PER_HOUR_PER_OWNER) throw new Error("slow down — a maximum of 20 posts per hour");
    recent.push(this.now());
    this.creationTimes.set(`posts:${args.authorOwnerId}`, recent);
    const post: SocialPost = {
      id: randomUUID(),
      authorBotId: args.authorBotId,
      authorOwnerId: args.authorOwnerId,
      text,
      replyToPostId,
      createdAt: this.now(),
    };
    this.posts.push(post);
    this.save();
    this.emit?.({
      kind: "social.post",
      post: { ...post },
      authorName,
      authorHandle: this.profiles.get(post.authorBotId)?.handle ?? "",
      socialOwnerIds: replyRoot
        ? [...new Set([...this.ownersAudience(replyRoot.authorBotId, replyRoot.authorOwnerId), post.authorOwnerId])]
        : this.ownersAudience(post.authorBotId, post.authorOwnerId),
    });
    return post;
  }

  /** The reaction receipt: the new count and whether the actor's like is on. */
  toggleReaction(postId: string, actorBotId: string, actorOwnerId: string): ReactionReceipt {
    const post = this.posts.find((p) => p.id === postId);
    if (!post) throw new Error("no such post"); // 404-shaped
    if (!this.visibleTo(post, actorOwnerId)) throw new Error("no such post"); // strangers can't probe or like
    const existing = this.reactions.find((r) => r.postId === postId && r.actorBotId === actorBotId);
    let active: boolean;
    if (existing) {
      this.reactions = this.reactions.filter((r) => r !== existing);
      active = false;
    } else {
      this.reactions.push({ postId, actorBotId, actorOwnerId, createdAt: this.now() });
      active = true;
    }
    this.save();
    this.emit?.({
      kind: "social.post.reaction",
      postId: post.id,
      reactionCount: this.reactionCount(post.id),
      socialOwnerIds: [...new Set([...this.ownersAudience(post.authorBotId, post.authorOwnerId), actorOwnerId])],
    });
    return { count: this.reactionCount(post.id), active };
  }

  /** Newest-first page of visible posts. The cursor is opaque: it carries the
   * boundary item's key so re-reads never skip or repeat on a tie. */
  feedForOwner(ownerId: string, options: { cursor?: string; limit?: number } = {}): FeedPage {
    const limit = Math.min(Math.max(1, options.limit ?? FEED_PAGE_DEFAULT), FEED_PAGE_MAX);
    const boundary = options.cursor ? options.cursor.split(":") : null;
    const boundaryAt = boundary ? Number(boundary[0]) : null;
    const ordered = this.posts
      .filter((p) => this.visibleTo(p, ownerId))
      .filter((p) => {
        if (boundaryAt === null || boundary === null) return true;
        if (p.createdAt < boundaryAt) return true;
        if (p.createdAt > boundaryAt) return false;
        return p.id > (boundary[1] ?? "");
      })
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const page = ordered.slice(0, limit);
    const last = page[page.length - 1];
    return {
      posts: page.map((p) => ({ ...p, reactionCount: this.reactionCount(p.id), reactedByMe: this.reactions.some((r) => r.postId === p.id && r.actorOwnerId === ownerId) })),
      nextCursor: ordered.length > page.length && last ? `${last.createdAt}:${last.id}` : null,
    };
  }

  /** A deleted bot leaves the network entirely: profile, edges, open requests. */
  forgetBot(botId: string): void {
    const profile = this.profiles.get(botId);
    if (!profile) {
      const hadEdges = this.friendships.some((f) => f.botAId === botId || f.botBId === botId);
      const hadRequests = this.requests.some((r) => r.status === "pending" && (r.fromBotId === botId || r.toBotId === botId));
      if (!hadEdges && !hadRequests) return;
    }
    this.profiles.delete(botId);
    this.friendships = this.friendships.filter((f) => f.botAId !== botId && f.botBId !== botId);
    for (const r of this.requests) {
      if (r.status === "pending" && (r.fromBotId === botId || r.toBotId === botId)) {
        r.status = "withdrawn";
        r.resolvedAt = this.now();
      }
    }
    // their posts leave the feed; replies to them age out with the roots
    const goneIds = new Set(this.posts.filter((p) => p.authorBotId === botId).map((p) => p.id));
    this.posts = this.posts.filter((p) => p.authorBotId !== botId && !(p.replyToPostId && goneIds.has(p.replyToPostId)));
    const liveIds = new Set(this.posts.map((p) => p.id));
    this.reactions = this.reactions.filter((r) => r.actorBotId !== botId && liveIds.has(r.postId));
    this.save();
    if (profile) this.emit?.({ kind: "social.profile.deleted", botId, socialOwnerIds: [profile.ownerId] });
  }
}
