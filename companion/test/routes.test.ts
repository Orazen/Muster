// The allowlist.
//
// The proxy tests prove the app's own calls reach a real harness. These prove
// the other half, which no end-to-end test can: that everything else does
// not. The case worth caring about is the last one — a route nobody here has
// heard of is denied, because that is the property the whole file exists for
// and the one that quietly stopped being true once before.
import { describe, expect, it } from "vitest";

import { denyReason } from "../src/routes.ts";

const ask = (
  method: string,
  path: string,
  authenticated = true,
  access?: "full" | "approvals",
) => denyReason({ method, path, authenticated, access });

const allowed = (method: string, path: string) => ask(method, path) === null;

describe("credentials", () => {
  it("lets an unpaired device pair, and do nothing else", () => {
    expect(ask("POST", "/api/pair", false)).toBeNull();
    expect(ask("GET", "/api/bots", false)?.status).toBe(401);
    expect(ask("GET", "/api/health", false)?.status).toBe(401);
  });
});

describe("what the app may do", () => {
  // Every request in ios/Sources/CompanionCore/Client.swift. If one of these
  // fails, a screen on the phone is broken.
  const calls: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/config"],
    ["GET", "/api/workspace/google/status"],
    ["GET", "/api/workspace/snapshots/policy"],
    ["GET", "/api/workspace/companion/status"],
    ["GET", "/api/events"],
    ["GET", "/api/instances"],
    ["GET", "/api/bots"],
    ["POST", "/api/bots"],
    ["POST", "/api/bots/bot_123/messages"],
    ["POST", "/api/bots/bot_123/cards/card_456/answer"],
    ["GET", "/api/bots/bot_123/cards/card_456/answer"],
    ["POST", "/api/bots/bot_123/cards/card_456/answer/start"],
    ["POST", "/api/bots/bot_123/interrupt"],
    ["POST", "/api/bots/bot_123/read"],
    ["POST", "/api/bots/bot_123/always-allow"],
    ["POST", "/api/bots/bot_123/messages/msg_2/edit"],
    ["POST", "/api/bots/bot_123/active-branch"],
    ["POST", "/api/bots/bot_123/tasks"],
    ["POST", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/tasks/th_1"],
    ["DELETE", "/api/bots/bot_123/tasks/th_1"],
    ["POST", "/api/bots/bot_123/computer/join"],
    ["POST", "/api/groups/room-1/messages"],
    ["POST", "/api/groups/room-1/read"],
    ["GET", "/api/threads/th_1/messages"],
    ["GET", "/api/threads/th_1/messages/msg_2/image"],
    ["POST", "/api/threads/th_1/messages/msg_2/reactions"],
    ["GET", "/api/threads/th_1/export"],
    ["POST", "/api/threads/th_1/respond"],
    ["GET", "/api/search"],
  ];

  for (const [method, path] of calls) {
    it(`allows ${method} ${path}`, () => expect(ask(method, path)).toBeNull());
  }

  // The scope is a second gate over the same list, so full access must keep
  // reaching everything — a regression here would look like a working phone
  // that suddenly cannot send a message.
  for (const [method, path] of calls) {
    it(`still allows ${method} ${path} with full access`, () =>
      expect(ask(method, path, true, "full")).toBeNull());
  }
});

describe("the chats-and-approvals scope", () => {
  // Answering a card, reading, reacting, and marking read are how a phone
  // unblocks work already in flight. None of them costs a turn, so none of
  // them may be gated — a restricted phone that cannot approve anything is
  // the opposite of what the setting is for.
  const responsive: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/workspace/google/status"],
    ["GET", "/api/workspace/snapshots/policy"],
    ["GET", "/api/workspace/companion/status"],
    ["GET", "/api/events"],
    ["GET", "/api/bots"],
    ["POST", "/api/bots/bot_123/cards/card_456/answer"],
    ["GET", "/api/bots/bot_123/cards/card_456/answer"],
    ["POST", "/api/bots/bot_123/read"],
    ["POST", "/api/bots/bot_123/always-allow"],
    ["POST", "/api/groups/room-1/read"],
    ["GET", "/api/threads/th_1/messages"],
    ["POST", "/api/threads/th_1/messages/msg_2/reactions"],
    ["POST", "/api/threads/th_1/respond"],
    ["GET", "/api/search"],
  ];

  for (const [method, path] of responsive) {
    it(`allows ${method} ${path}`, () =>
      expect(ask(method, path, true, "approvals")).toBeNull());
  }

  // Everything that originates work, or reshapes the task list it lives in.
  const originating: Array<[string, string]> = [
    ["POST", "/api/bots"],
    ["POST", "/api/bots/bot_123/messages"],
    ["POST", "/api/bots/bot_123/interrupt"],
    ["POST", "/api/bots/bot_123/cards/card_456/answer/start"],
    ["POST", "/api/bots/bot_123/messages/msg_2/edit"],
    ["POST", "/api/bots/bot_123/active-branch"],
    ["POST", "/api/bots/bot_123/tasks"],
    ["POST", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/tasks/th_1"],
    ["DELETE", "/api/bots/bot_123/tasks/th_1"],
    ["POST", "/api/groups/room-1/messages"],
    ["POST", "/api/bots/bot_123/computer/join"],
  ];

  for (const [method, path] of originating) {
    it(`refuses ${method} ${path}`, () => {
      const denial = ask(method, path, true, "approvals");
      expect(denial?.status).toBe(403);
      expect(denial?.error).toContain("chats and approvals only");
    });
  }

  it("does not leak the refusal to an unauthenticated caller", () => {
    // 401 for a missing credential, not the scope message — the scope is a
    // fact about a paired device and must not be readable without one.
    expect(ask("POST", "/api/bots", false, "approvals")?.status).toBe(401);
  });
});

describe("seed answer route boundary", () => {
  it.each([
    ["POST", "/api/bots/bot_123/cards/card_456/answer"],
    ["GET", "/api/bots/bot_123/cards/card_456/answer"],
    ["POST", "/api/bots/bot_123/cards/card_456/answer/start"],
  ])("requires pairing for %s %s", (method, path) => {
    expect(ask(method, path, false)?.status).toBe(401);
  });

  it.each([
    ["PATCH", "/api/bots/bot_123/cards/card_456"],
    ["POST", "/api/bots/bot_123/cards/card_456"],
    ["PATCH", "/api/bots/bot_123/cards/card_456/answer"],
    ["DELETE", "/api/bots/bot_123/cards/card_456/answer"],
    ["PUT", "/api/bots/bot_123/cards/card_456/answer"],
    ["GET", "/api/bots/bot_123/cards/card_456/answer/start"],
    ["PATCH", "/api/bots/bot_123/cards/card_456/answer/start"],
    ["POST", "/api/bots/bot_123/cards/card_456/answer/start/again"],
    ["POST", "/api/bots/bot_123/cards/card_456/answer/"],
    ["POST", "/api/bots/bot_123/cards/card_456/answers"],
    ["POST", "/api/groups/room_123/cards/card_456/answer"],
    ["POST", "/api/threads/thread_123/cards/card_456/answer"],
    ["POST", "/api/bots/bot_123/cards/card%2f..%2fother/answer"],
    ["POST", "/api/bots/bot%2fother/cards/card_456/answer"],
    ["POST", "/api/bots//cards/card_456/answer"],
    ["POST", "/api/bots/bot_123/cards//answer"],
  ])("does not widen the surface to %s %s", (method, path) => {
    expect(ask(method, path)?.status).toBe(404);
  });
});

describe("what it may not", () => {
  it("refuses host configuration, and says where it happens", () => {
    for (const [method, path] of [
      ["PUT", "/api/config"],
      ["PATCH", "/api/config"],
      ["GET", "/api/devices"],
      ["GET", "/api/companion"],
      ["POST", "/api/local-computer/start"],
      ["POST", "/api/webhooks"],
      ["POST", "/api/webhooks/wh_1/rotate"],
      ["GET", "/api/connectors"],
      ["DELETE", "/api/connectors/gmail"],
      ["GET", "/api/routines"],
      ["POST", "/api/teams/import"],
    ]) {
      const denial = ask(method, path);
      expect(denial?.status, `${method} ${path}`).toBe(403);
      expect(denial?.error, `${method} ${path}`).toMatch(/on your computer/);
    }
  });

  it("keeps every workspace-storage verb on the computer except two GETs", () => {
    expect(allowed("GET", "/api/workspace/google/status")).toBe(true);
    expect(allowed("GET", "/api/workspace/snapshots/policy")).toBe(true);

    for (const [method, path] of [
      ["POST", "/api/workspace/google/status"],
      ["PUT", "/api/workspace/google/status"],
      ["POST", "/api/workspace/snapshots/policy"],
      ["POST", "/api/workspace/snapshots/run"],
      ["POST", "/api/workspace/snapshots/passphrase"],
      ["DELETE", "/api/workspace/snapshots/passphrase"],
      ["POST", "/api/workspace/v2/export"],
      ["POST", "/api/workspace/google/push"],
    ]) {
      expect(allowed(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("denies the peer-agent endpoints exist at all", () => {
    expect(ask("GET", "/api/internal/peers")?.status).toBe(404);
    expect(ask("POST", "/api/internal/ask-bot")?.status).toBe(404);
  });

  it("does not serve the desktop UI", () => {
    expect(ask("GET", "/")?.status).toBe(404);
    expect(ask("GET", "/index.html")?.status).toBe(404);
  });

  it("opens only a fresh cloud viewer, not the cloud computer control API", () => {
    expect(allowed("POST", "/api/bots/bot_123/computer/join")).toBe(true);
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/provision")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/sleep")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/exec")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/screenshot")).toBe(false);
  });

  // The method is part of the allowance, not decoration: reading the fleet
  // and deleting a bot are the same path.
  it("allows a path only for the methods it was allowed for", () => {
    expect(allowed("GET", "/api/bots")).toBe(true);
    expect(allowed("DELETE", "/api/bots/bot_123")).toBe(false);
    expect(allowed("POST", "/api/threads/th_1/messages")).toBe(false);
    expect(allowed("GET", "/api/groups/room-1")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123")).toBe(false);
    expect(allowed("PATCH", "/api/groups/room-1")).toBe(false);
  });

  // Patterns are anchored, so a path that merely starts right is still a
  // path nobody allowed.
  it("is not fooled by a prefix", () => {
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("GET", "/api/botsandthensome")).toBe(false);
    expect(allowed("GET", "/api/events/all")).toBe(false);
    expect(allowed("GET", "/api/threads/th_1/messages/msg_2/image/../../../config")).toBe(false);
    expect(allowed("GET", "/api/bots%2f..%2fwebhooks")).toBe(false);
  });

  // The one that matters. Upstream adds routes on its own schedule, and the
  // sidecar must not carry them to a phone because nobody wrote a rule
  // against a thing that did not exist yet.
  it("denies a route it has never heard of", () => {
    for (const path of [
      "/api/whatever-ships-next",
      "/api/bots/bot_123/some-new-verb",
      "/api/secrets",
    ]) {
      expect(allowed("GET", path), path).toBe(false);
      expect(allowed("POST", path), path).toBe(false);
      expect(allowed("DELETE", path), path).toBe(false);
    }
  });
});

describe("explicit foreground call surface", () => {
  const call = "/api/bots/bot_123/calls/00000000-0000-4000-8000-000000000001";
  it.each(["calendar-enrollment", "calendar-enrollment-status", "calendar-enrollment-cancel"])("restricts %s to exact full-access POST", action => {
    const path = `${call}/${action}`;
    expect(ask("POST", path, true, "full")).toBeNull();
    expect(ask("POST", path, true, "approvals")?.status).toBe(403);
    expect(ask("POST", path, false, "full")?.status).toBe(401);
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect(ask(method, path, true, "full")?.status).toBe(404);
    }
    for (const suffix of ["/extra", "/", "-extra"]) {
      expect(ask("POST", path + suffix, true, "full")?.status).toBe(404);
    }
  });
  it.each([
    ["POST", "/api/bots/bot_123/calls"], ["GET", call],
    ["POST", `${call}/accept`], ["POST", `${call}/messages`], ["POST", `${call}/end`], ["POST", `${call}/prepare-calendar`],
  ])("permits only full paired devices for %s %s", (method, path) => {
    expect(ask(method, path, true, "full")).toBeNull();
    expect(ask(method, path, true, "approvals")?.status).toBe(403);
    expect(ask(method, path, false, "full")?.status).toBe(401);
  });
  it.each([
    ["GET", "/api/bots/bot_123/calls"], ["DELETE", call], ["PATCH", call],
    ["GET", `${call}/messages`], ["POST", `${call}/end/again`],
    ["GET", `${call}/prepare-calendar`], ["POST", `${call}/prepare-calendar/extra`],
    ["POST", "/api/calendar/plan"], ["GET", "/api/calendar/day"],
    ["POST", "/api/bots/bot%2F123/calls"], ["GET", "/api/bots/bot_123/calls/not-uuid"],
  ])("refuses unlisted call operation %s %s", (method, path) => {
    expect(ask(method, path, true, "full")?.status).toBe(404);
  });
});
