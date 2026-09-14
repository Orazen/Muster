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
  | { kind: "social.friendship.deleted"; friendshipId: string; socialOwnerIds: string[] };

export const socialProfileInputSchema = z.object({
  botId: z.string().min(1),
  tagline: z.string().max(SOCIAL_TAGLINE_MAX).optional(),
  bio: z.string().max(SOCIAL_BIO_MAX).optional(),
  visibility: z.enum(["private", "public"]),
  handle: z.string().optional(),
});
export type SocialProfileInput = z.infer<typeof socialProfileInputSchema>;

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
}

export class SocialManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly emit?: (payload: SocialEvent) => void;
  private readonly botName: (botId: string) => string;
  private profiles = new Map<string, SocialProfile>();
  private requests: FriendRequest[] = [];
  private friendships: Friendship[] = [];
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
    } catch {
      this.profiles = new Map();
      this.requests = [];
      this.friendships = [];
    }
  }

  private save(): void {
    const body: SocialFile = {
      profiles: [...this.profiles.values()],
      // resolved requests age out; pending ones always survive
      requests: this.requests.filter((r) => r.status === "pending" || this.now() - r.createdAt < 30 * 24 * HOUR_MS),
      friendships: this.friendships,
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
    this.save();
    if (profile) this.emit?.({ kind: "social.profile.deleted", botId, socialOwnerIds: [profile.ownerId] });
  }
}
