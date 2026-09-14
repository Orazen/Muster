// Unit tests for the social manager (server/social.ts): the friend-graph
// consent rules, handle lifecycle, rate caps and deletion cleanup — the
// pure logic that the HTTP routes in index.ts only forward to.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SocialManager, slugifyHandle, isValidHandle, type SocialEvent } from "./social.ts";

let clock = 1_700_000_000_000;
const events: SocialEvent[] = [];

function freshManager() {
  const dir = mkdtempSync(join(tmpdir(), "muster-social-"));
  const file = join(dir, "social.json");
  const manager = new SocialManager({
    file,
    now: () => clock,
    emit: (event) => events.push(event),
    botName: (id) => (id.startsWith("bot-") ? `Name-${id}` : null),
  });
  return { manager, dir, file };
}

const profileInput = (botId: string, visibility: "private" | "public" = "private") => ({
  botId,
  visibility,
});

describe("handles", () => {
  it("slugifies names and keeps handles unique with numeric suffixes", () => {
    expect(slugifyHandle("Wren Scout")).toBe("wren-scout");
    expect(slugifyHandle("  --- ")).toMatch(/^bot-/);
    expect(isValidHandle("wren-scout")).toBe(true);
    expect(isValidHandle("-bad")).toBe(false);
    expect(isValidHandle("ab")).toBe(false);
    expect(isValidHandle("UPPER")).toBe(false);
    const { manager, dir } = freshManager();
    try {
      const a = manager.setProfile(profileInput("bot-a"), "Wren", "user-1");
      const b = manager.setProfile(profileInput("bot-b"), "Wren", "user-2");
      expect(a.handle).toBe("wren");
      expect(b.handle).toBe("wren-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims explicit handles only when free and well-formed", () => {
    const { manager, dir } = freshManager();
    try {
      manager.setProfile({ ...profileInput("bot-a"), handle: "mine-first" }, "A", "user-1");
      expect(() => manager.setProfile({ ...profileInput("bot-b"), handle: "mine-first" }, "B", "user-2")).toThrow(/already taken/);
      expect(() => manager.setProfile({ ...profileInput("bot-b"), handle: "no good!" }, "B", "user-2")).toThrow(/characters/);
      const claimed = manager.setProfile({ ...profileInput("bot-b"), handle: "  Free-Form  " }, "B", "user-2");
      expect(claimed.handle).toBe("free-form");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("budgets handle claims per owner (enumeration/squatting guard)", () => {
    const { manager, dir } = freshManager();
    try {
      manager.setProfile(profileInput("bot-a"), "A", "user-1");
      for (let i = 0; i < 10; i++) {
        manager.setProfile({ ...profileInput("bot-a"), handle: `hop-${i}` }, "A", "user-1");
      }
      expect(() => manager.setProfile({ ...profileInput("bot-a"), handle: "squat-more" }, "A", "user-1")).toThrow(/too many handle changes/);
      // keeping the current handle is not a claim — saving tagline/bio stays free
      expect(manager.setProfile({ ...profileInput("bot-a"), handle: "hop-9", tagline: "fine" }, "A", "user-1").tagline).toBe("fine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("friend graph consent", () => {
  it("accept only by the target owner; decline only by the receiver; withdraw only by the sender", () => {
    const { manager, dir } = freshManager();
    try {
      manager.setProfile(profileInput("bot-a", "public"), "A", "user-1");
      manager.setProfile(profileInput("bot-b", "public"), "B", "user-2");
      const request = manager.createRequest({ fromBotId: "bot-a", fromOwnerId: "user-1", toBotId: "bot-b", toOwnerId: "user-2", message: "hi" });
      // wrong party on every transition
      expect(() => manager.acceptRequest(request.id, "user-1")).toThrow(/no such open request/);
      expect(() => manager.declineRequest(request.id, "user-1")).toThrow(/no such open request/);
      expect(() => manager.withdrawRequest(request.id, "user-2")).toThrow(/no such open request/);
      expect(() => manager.acceptRequest(request.id, "user-3")).toThrow(/no such open request/);
      const friendship = manager.acceptRequest(request.id, "user-2");
      // canonical edge order: botAId < botBId
      expect(friendship.botAId < friendship.botBId).toBe(true);
      expect(manager.areFriends("bot-a", "bot-b")).toBe(true);
      expect(manager.friendsOf("user-1").map((f) => f.id)).toEqual([friendship.id]);
      expect(manager.friendsOf("user-2").map((f) => f.id)).toEqual([friendship.id]);
      // a stranger cannot unfriend
      expect(() => manager.unfriend(friendship.id, "user-3")).toThrow(/no such friendship/);
      // either owner may
      manager.unfriend(friendship.id, "user-1");
      expect(manager.areFriends("bot-a", "bot-b")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes pending requests and refuses self, same-owner, and already-friends", () => {
    const { manager, dir } = freshManager();
    try {
      manager.setProfile(profileInput("bot-a", "public"), "A", "user-1");
      manager.setProfile(profileInput("bot-b", "public"), "B", "user-2");
      const base = { fromBotId: "bot-a", fromOwnerId: "user-1", toBotId: "bot-b", toOwnerId: "user-2", message: "" };
      const first = manager.createRequest(base);
      expect(manager.createRequest(base).id).toBe(first.id); // dedupe, never duplicate
      // reverse direction while pending: also deduped (one open conversation)
      expect(manager.createRequest({ ...base, fromBotId: "bot-b", fromOwnerId: "user-2", toBotId: "bot-a", toOwnerId: "user-1" }).id).toBe(first.id);
      expect(() => manager.createRequest({ ...base, toBotId: "bot-a", toOwnerId: "user-1" })).toThrow(/itself/);
      manager.acceptRequest(first.id, "user-2");
      expect(() => manager.createRequest(base)).toThrow(/already friends/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rate-limits request creation per owner", () => {
    const { manager, dir } = freshManager();
    try {
      manager.setProfile(profileInput("bot-sender", "public"), "S", "user-1");
      for (let i = 0; i < 10; i++) {
        const target = `bot-t${i}`;
        manager.setProfile(profileInput(target, "public"), `T${i}`, `other-${i}`);
        manager.createRequest({ fromBotId: "bot-sender", fromOwnerId: "user-1", toBotId: target, toOwnerId: `other-${i}`, message: "" });
      }
      manager.setProfile(profileInput("bot-t10", "public"), "T10", "other-10");
      expect(() =>
        manager.createRequest({ fromBotId: "bot-sender", fromOwnerId: "user-1", toBotId: "bot-t10", toOwnerId: "other-10", message: "" }),
      ).toThrow(/per hour/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("visibility and cleanup", () => {
  it("only public profiles are listed and resolvable as public", () => {
    const { manager, dir } = freshManager();
    try {
      const a = manager.setProfile(profileInput("bot-a", "private"), "A", "user-1");
      expect(manager.publicProfiles()).toEqual([]);
      const pub = manager.setProfile({ ...a, visibility: "public", botId: "bot-a" }, "A", "user-1");
      expect(pub.visibility).toBe("public");
      expect(manager.publicProfiles().map((p) => p.botId)).toEqual(["bot-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forgetBot removes the profile, edges and open requests", () => {
    const { manager, dir } = freshManager();
    try {
      manager.setProfile(profileInput("bot-a", "public"), "A", "user-1");
      manager.setProfile(profileInput("bot-b", "public"), "B", "user-2");
      manager.createRequest({ fromBotId: "bot-a", fromOwnerId: "user-1", toBotId: "bot-b", toOwnerId: "user-2", message: "" });
      manager.forgetBot("bot-a");
      expect(manager.profileFor("bot-a")).toBeNull();
      expect(manager.requestsForOwner("user-2").incoming).toEqual([]);
      manager.setProfile(profileInput("bot-c", "public"), "C", "user-3");
      manager.setProfile(profileInput("bot-d", "public"), "D", "user-4");
      const r = manager.createRequest({ fromBotId: "bot-c", fromOwnerId: "user-3", toBotId: "bot-d", toOwnerId: "user-4", message: "" });
      manager.acceptRequest(r.id, "user-4");
      manager.forgetBot("bot-c");
      expect(manager.friendsOf("user-4")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists across manager instances", () => {
    const { manager, dir, file } = freshManager();
    try {
      manager.setProfile(profileInput("bot-a", "public"), "A", "user-1");
      const reloaded = new SocialManager({ file, now: () => clock });
      expect(reloaded.byHandle(manager.profileFor("bot-a")!.handle)?.visibility).toBe("public");
      // the file is owner-readable only — 0600
      expect(readFileSync(file).length).toBeGreaterThan(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every emitted frame carries the owners allowed to see it", () => {
    const { manager, dir } = freshManager();
    const before = events.length;
    try {
      manager.setProfile(profileInput("bot-a", "public"), "A", "user-1");
      manager.setProfile(profileInput("bot-b", "public"), "B", "user-2");
      const request = manager.createRequest({ fromBotId: "bot-a", fromOwnerId: "user-1", toBotId: "bot-b", toOwnerId: "user-2", message: "hello there" });
      const friendship = manager.acceptRequest(request.id, "user-2");
      const emitted = events.slice(before);
      const requestFrame = emitted.find((e) => e.kind === "social.friendRequest" && e.request.status === "pending");
      expect(requestFrame).toBeDefined();
      if (requestFrame?.kind === "social.friendRequest") {
        expect(requestFrame.socialOwnerIds).toEqual(["user-1", "user-2"]);
        expect(requestFrame.fromName).toBe("Name-bot-a");
      }
      const friendshipFrame = emitted.find((e) => e.kind === "social.friendship");
      if (friendshipFrame?.kind === "social.friendship") {
        expect(friendshipFrame.socialOwnerIds).toEqual([friendship.ownerAId, friendship.ownerBId].sort());
        expect(friendshipFrame.aHandle.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
