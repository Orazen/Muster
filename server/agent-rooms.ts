// Agent rooms — a shared real computer (Box cloud computer, Local VM, or
// OpenSandbox) that multiple bots and humans work in with live presence.
//
// This is the presence/coordination layer on top of Muster's existing
// computers and group chats: a room points at one computer and tracks who
// is in it. The registry persists to DATA_DIR/agent-rooms.json (atomic,
// 0600 — rooms name real machines, so the file is treated like other
// sensitive state) and is reloaded at boot. The module is deliberately
// pure: it imports no store and knows nothing about bots' threads —
// callers pass member identity in, and clock values come from the caller
// (`now` is injected on every mutating call) so tests can drive time.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export type ComputerKind = "box" | "localvm" | "opensandbox";

export type MemberKind = "bot" | "human";

export interface RoomMember {
  kind: MemberKind;
  id: string;
  name: string;
  joinedAt: number;
}

/** Member identity handed to joinRoom; `joinedAt` is stamped from the
 * injected clock, never trusted from the caller. */
export type RoomMemberSpec = Pick<RoomMember, "kind" | "id" | "name">;

export interface AgentRoom {
  id: string;
  name: string;
  computerKind: ComputerKind;
  /** Which concrete computer backs this room (Box instance id, VM id, …). */
  computerRef: string;
  members: RoomMember[];
  createdAt: number;
  updatedAt: number;
}

export type JoinResult = "ok" | "no_room" | "full" | "bad_member";

/** How many rooms may exist at once. Small on purpose: rooms reference
 * real computers, and an unbounded registry lets stale rooms accumulate
 * forever on a long-lived install. */
export const MAX_ROOMS = 200;

/** How many members (bots + humans) one room may hold. */
export const MAX_MEMBERS = 12;

const ROOMS_FILE = join(DATA_DIR, "agent-rooms.json");

/** Stable key tying a member to a room — what a presence feed dedupes on. */
export function presenceKey(roomId: string, memberId: string): string {
  return `${roomId}:${memberId}`;
}

/** Decoding for the on-disk file. Every unpersisted value crosses this
 * schema exactly once at load; anything short of a whole valid room drops,
 * and a file that fails entirely (missing, corrupt, wrong version) leaves
 * the registry empty rather than crashing the boot. */
const memberSchema = z.object({
  kind: z.enum(["bot", "human"]),
  id: z.string().min(1),
  name: z.string().min(1),
  joinedAt: z.number().finite().nonnegative(),
});

const roomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  computerKind: z.enum(["box", "localvm", "opensandbox"]),
  computerRef: z.string(),
  members: z.array(memberSchema).max(MAX_MEMBERS),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
}) satisfies z.ZodType<AgentRoom>;

/** The envelope is validated as a whole; rooms are decoded one by one so a
 * single invalid row drops alone instead of blanking the whole registry. */
const roomsFileSchema = z.object({
  version: z.literal(1),
  rooms: z.array(z.unknown()).max(MAX_ROOMS),
});

const rooms = new Map<string, AgentRoom>();
let hydrated = false;

function ensureLoaded(): void {
  if (hydrated) return;
  hydrated = true;
  let raw: string;
  try {
    raw = readFileSync(ROOMS_FILE, "utf8");
  } catch {
    return; // fresh install, or unreadable — start empty
  }
  let parsed: JsonValue;
  try {
    parsed = parseJson(raw);
  } catch {
    return; // corrupt — start empty rather than crash the boot
  }
  const decoded = roomsFileSchema.safeParse(parsed);
  if (!decoded.success) return; // wrong shape or version — start empty
  for (const entry of decoded.data.rooms) {
    const room = roomSchema.safeParse(entry);
    if (room.success) rooms.set(room.data.id, room.data);
  }
}

interface RoomsFile {
  version: 1;
  rooms: AgentRoom[];
}

function saveRooms(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const state: RoomsFile = { version: 1, rooms: [...rooms.values()] };
    writeFileAtomic(ROOMS_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("agent-rooms: could not persist rooms", error);
  }
}

/** All rooms, most recently active first — what a panel listing reads. */
export function listRooms(): AgentRoom[] {
  ensureLoaded();
  return [...rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One room by id, or undefined. */
export function getRoom(roomId: string): AgentRoom | undefined {
  ensureLoaded();
  return rooms.get(roomId);
}

/** Create a room. At the cap the least-recently-active room is evicted to
 * make room; a blank name is rejected. Returns the new room, or null when
 * nothing usable was given. */
export function createRoom(
  name: string,
  computerKind: ComputerKind,
  computerRef: string,
  now: number,
): AgentRoom | null {
  ensureLoaded();
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (rooms.size >= MAX_ROOMS && !evictStalest()) return null;
  const room: AgentRoom = {
    id: randomUUID(),
    name: trimmed,
    computerKind,
    computerRef,
    members: [],
    createdAt: now,
    updatedAt: now,
  };
  rooms.set(room.id, room);
  saveRooms();
  return room;
}

/** Drop the least-recently-active room. Returns whether one was evicted. */
function evictStalest(): boolean {
  let stalest: AgentRoom | undefined;
  for (const room of rooms.values()) {
    if (!stalest || room.updatedAt < stalest.updatedAt) stalest = room;
  }
  if (!stalest) return false;
  rooms.delete(stalest.id);
  return true;
}

/** Add a member to a room. Duplicate joins are idempotent: an id already
 * in the room is a no-op that reports "ok" (the original joinedAt stands).
 * Mutations stamp `updatedAt` from the injected clock. */
export function joinRoom(roomId: string, member: RoomMemberSpec, now: number): JoinResult {
  ensureLoaded();
  const id = member.id.trim();
  if (!id) return "bad_member";
  const room = rooms.get(roomId);
  if (!room) return "no_room";
  if (room.members.some((existing) => existing.id === id)) return "ok";
  if (room.members.length >= MAX_MEMBERS) return "full";
  const stamped: RoomMember = { kind: member.kind, id, name: member.name, joinedAt: now };
  room.members.push(stamped);
  room.updatedAt = now;
  saveRooms();
  return "ok";
}

/** Remove a member from a room. True when the room existed and the member
 * was in it; a missing member of an existing room is a no-op that still
 * reports false so callers can tell "left" from "was not there". */
export function leaveRoom(roomId: string, memberId: string, now: number): boolean {
  ensureLoaded();
  const room = rooms.get(roomId);
  if (!room) return false;
  const remaining = room.members.filter((existing) => existing.id !== memberId);
  if (remaining.length === room.members.length) return false;
  room.members = remaining;
  room.updatedAt = now;
  saveRooms();
  return true;
}

/** Delete a room outright (the owner closed it). True when it existed. */
export function closeRoom(roomId: string): boolean {
  ensureLoaded();
  if (!rooms.delete(roomId)) return false;
  saveRooms();
  return true;
}

/** Test helper: forget the in-memory registry (a simulated restart). */
export function _resetRooms(): void {
  rooms.clear();
  hydrated = false;
}

/** Test helper: reload from disk (the boot path). */
export function _loadRooms(): void {
  _resetRooms();
  ensureLoaded();
}
