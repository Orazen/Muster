// Agent rooms — pure registry logic. Each test points the module at its
// throwaway DATA_DIR (the vitest setup already redirects HOME) and drives
// the injected clock directly, so nothing here waits on real time or on
// the store: rooms know nothing about bots' threads.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  MAX_MEMBERS,
  MAX_ROOMS,
  _loadRooms,
  _resetRooms,
  closeRoom,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  listRooms,
  presenceKey,
} from "./agent-rooms.ts";

const ROOMS_FILE = () => join(DATA_DIR, "agent-rooms.json");

const BOT = (id: string) => ({ kind: "bot" as const, id, name: `Bot ${id}` });
const HUMAN = (id: string) => ({ kind: "human" as const, id, name: `Human ${id}` });

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  _resetRooms();
});

afterEach(() => {
  _resetRooms();
});

describe("createRoom", () => {
  it("creates a room with the injected clock and empty membership", () => {
    const room = createRoom("Deploy rig", "box", "box-123", 1_000);
    expect(room).not.toBeNull();
    expect(room!.name).toBe("Deploy rig");
    expect(room!.computerKind).toBe("box");
    expect(room!.computerRef).toBe("box-123");
    expect(room!.createdAt).toBe(1_000);
    expect(room!.updatedAt).toBe(1_000);
    expect(room!.members).toEqual([]);
  });

  it("rejects a blank name without creating anything", () => {
    expect(createRoom("   ", "localvm", "vm-1", 1)).toBeNull();
    expect(listRooms()).toEqual([]);
  });

  it("keeps the room list bounded by evicting the least-recently-active room", () => {
    for (let i = 0; i < MAX_ROOMS; i += 1) {
      expect(createRoom(`room-${i}`, "box", "box", i + 1)).not.toBeNull();
    }
    expect(listRooms()).toHaveLength(MAX_ROOMS);

    // One more creation must succeed and evict room-0 (oldest updatedAt).
    const overflow = createRoom("overflow", "box", "box", MAX_ROOMS + 1);
    expect(overflow).not.toBeNull();
    expect(listRooms()).toHaveLength(MAX_ROOMS);
    expect(getRoom(overflow!.id)).not.toBeUndefined();
    expect(getRoom("room-0")).toBeUndefined();
  });
});

describe("joinRoom", () => {
  it("stamps joinedAt from the injected clock and bumps updatedAt", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    expect(joinRoom(room.id, BOT("b1"), 250)).toBe("ok");
    const joined = getRoom(room.id)!;
    expect(joined.members).toEqual([{ kind: "bot", id: "b1", name: "Bot b1", joinedAt: 250 }]);
    expect(joined.updatedAt).toBe(250);
  });

  it("is idempotent for a duplicate join — no second member, no clock churn", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    expect(joinRoom(room.id, BOT("b1"), 150)).toBe("ok");
    expect(joinRoom(room.id, BOT("b1"), 999)).toBe("ok");
    const joined = getRoom(room.id)!;
    expect(joined.members).toHaveLength(1);
    expect(joined.members[0]!.joinedAt).toBe(150);
    expect(joined.updatedAt).toBe(150);
  });

  it("rejects a join into a room that does not exist", () => {
    expect(joinRoom("ghost", BOT("b1"), 1)).toBe("no_room");
  });

  it("rejects a member with an empty id", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    expect(joinRoom(room.id, { kind: "bot", id: "  ", name: "x" }, 1)).toBe("bad_member");
  });

  it("caps membership and still lets an existing member re-join at the cap", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    for (let i = 0; i < MAX_MEMBERS; i += 1) {
      expect(joinRoom(room.id, BOT(`b${i}`), 100 + i)).toBe("ok");
    }
    expect(joinRoom(room.id, HUMAN("late"), 999)).toBe("full");
    expect(getRoom(room.id)!.members).toHaveLength(MAX_MEMBERS);

    // A duplicate join at the cap is still the idempotent "ok", not "full".
    expect(joinRoom(room.id, BOT("b0"), 999)).toBe("ok");
    expect(getRoom(room.id)!.members).toHaveLength(MAX_MEMBERS);
  });
});

describe("leaveRoom and closeRoom", () => {
  it("removes only the leaving member and bumps updatedAt", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    joinRoom(room.id, BOT("b1"), 110);
    joinRoom(room.id, HUMAN("h1"), 120);
    expect(leaveRoom(room.id, "b1", 300)).toBe(true);
    const after = getRoom(room.id)!;
    expect(after.members.map((m) => m.id)).toEqual(["h1"]);
    expect(after.updatedAt).toBe(300);
  });

  it("reports false for a missing room, or a member who was never in it", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    expect(leaveRoom("ghost", "b1", 1)).toBe(false);
    expect(leaveRoom(room.id, "stranger", 1)).toBe(false);
  });

  it("deletes the room on close and reports false on a second close", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    joinRoom(room.id, BOT("b1"), 110);
    expect(closeRoom(room.id)).toBe(true);
    expect(getRoom(room.id)).toBeUndefined();
    expect(closeRoom(room.id)).toBe(false);
  });
});

describe("presenceKey", () => {
  it("keys a member to its room", () => {
    expect(presenceKey("room-1", "bot-7")).toBe("room-1:bot-7");
    expect(presenceKey("room-1", "bot-7")).not.toBe(presenceKey("room-2", "bot-7"));
  });
});

describe("persistence", () => {
  it("writes the registry to disk atomically with 0600 permissions on change", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    expect(existsSync(ROOMS_FILE())).toBe(true);
    // SAFETY: agent-rooms.json is createRoom's own on-disk envelope; the
    // expects below pin its documented shape.
    const onDisk = JSON.parse(readFileSync(ROOMS_FILE(), "utf8")) as { version: number; rooms: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.rooms).toHaveLength(1);
    const stat = statSync(ROOMS_FILE());    expect(stat.mode & 0o777).toBe(0o600);
    void room;
  });

  it("a fresh process loads what the last one saved, including members", () => {
    const room = createRoom("ops", "box", "box", 100)!;
    joinRoom(room.id, BOT("b1"), 150);
    // "restart": forget memory (and what was lazily re-read from disk),
    // then run the boot path against the file the last process saved.
    _resetRooms();
    _loadRooms();
    const reloaded = getRoom(room.id);
    expect(reloaded?.members.map((m) => m.id)).toEqual(["b1"]);
    expect(reloaded?.createdAt).toBe(100);
  });

  it("tolerates a missing file", () => {
    _loadRooms();
    expect(listRooms()).toEqual([]);
  });

  it("starts empty on a corrupt file and recovers on the next save", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ROOMS_FILE(), "{not json");
    _loadRooms();
    expect(listRooms()).toEqual([]);

    const room = createRoom("recovered", "box", "box", 5)!;
    expect(getRoom(room.id)?.name).toBe("recovered");
  });

  it("starts empty on a wrong-shape file instead of trusting it", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ROOMS_FILE(), JSON.stringify({ version: 99, rooms: [{ id: "bogus" }] }));
    _loadRooms();
    expect(listRooms()).toEqual([]);
  });

  it("drops individually invalid rooms but keeps valid ones", () => {
    const good = createRoom("good", "box", "box", 10)!;
    // SAFETY: the map is the module's own decoded on-disk registry; the
    // test corrupts one row on purpose to exercise per-room decoding.
    const onDisk = JSON.parse(readFileSync(ROOMS_FILE(), "utf8")) as {
      version: number;
      rooms: Array<{
        id: string;
        name: string;
        computerKind: string;
        computerRef: string;
        members: unknown[];
        createdAt: number;
        updatedAt: number;
      }>;
    };
    onDisk.rooms.push({
      id: "broken",
      name: "broken",
      computerKind: "typewriter",
      computerRef: "",
      members: [],
      createdAt: 1,
      updatedAt: 1,
    });
    writeFileSync(ROOMS_FILE(), JSON.stringify(onDisk));
    _loadRooms();
    expect(getRoom(good.id)?.name).toBe("good");
    expect(getRoom("broken")).toBeUndefined();
  });
});
