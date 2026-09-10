import { describe, expect, it } from "vitest";
import type { Bot, Message, OptionCardData } from "@/state/store";
import { buildWorkspaceSummary, operationalAvatarState } from "./workspace-state";

const user: Message = { id: "user", role: "user", kind: "text", text: "Draft a short brief", at: 10, parentId: null };
const reply: Message = { id: "reply", role: "bot", kind: "text", text: "Here is a draft for review.", at: 30, parentId: user.id };
const card: OptionCardData = { title: "Read the source?", subtitle: "Read notes.md", options: ["Allow", "Deny"], requestId: "request", tool: "Read" };
const decision: Message = { id: "decision", role: "bot", kind: "options", card, at: 20, parentId: user.id };
const bot = (patch: Partial<Bot> = {}): Bot => ({
  id: "bot", threadId: "thread", name: "Scout", title: "Research", description: "",
  color: "orange", notifications: true, unread: false, messages: [],
  modelSelection: { instanceId: "fixture", model: "default" }, ...patch,
});

describe("OS workspace status", () => {
  it("puts an active-branch permission request ahead of busy status", () => {
    const asking = bot({ busy: true, activity: "working", messages: [user, decision], activeLeafId: decision.id });
    const summary = buildWorkspaceSummary([asking], true);
    expect(summary.decisions).toEqual([{ bot: asking, title: card.title, detail: card.subtitle, at: decision.at }]);
    expect(summary.working).toEqual([]);
    expect(operationalAvatarState(asking, true)).toBe("curious");
  });

  it("includes provider questions without a permission tool", () => {
    const question: Message = { ...decision, card: { title: "Which audience?", subtitle: "Choose who will read this.", options: ["Team", "Customers"], requestId: "question" } };
    expect(buildWorkspaceSummary([bot({ messages: [user, question] })], true).decisions[0]?.title).toBe("Which audience?");
  });

  it.each<Partial<OptionCardData>>([{ answered: "allow" }, { answered: "deny" }, { dismissed: true }, { requestId: undefined }])(
    "does not invent a live decision for a settled or non-provider card: %j", (patch) => {
      const idle = bot({ messages: [user, { ...decision, card: { ...card, ...patch } }] });
      expect(buildWorkspaceSummary([idle], true).decisions).toEqual([]);
      expect(operationalAvatarState(idle, true)).toBe("idle");
    },
  );

  it("retains an explicit waiting status when request details have not loaded", () => {
    const waiting = bot({ activity: "waiting-on-you", busy: true });
    expect(buildWorkspaceSummary([waiting], true).decisions).toEqual([{
      bot: waiting, title: "Waiting for your decision", detail: "Request details are not loaded. Open chat to check.",
    }]);
    expect(operationalAvatarState(waiting, true)).toBe("curious");
  });

  it("chooses the oldest live request and orders bots by wait time without changing messages", () => {
    const later = { ...decision, id: "later", at: 25 };
    const earlyBot = bot({ id: "early", messages: [user, later, decision] });
    const lateBot = bot({ id: "late", messages: [user, { ...decision, at: 40 }] });
    const unknown = bot({ id: "unknown", activity: "waiting-on-you" });
    const bots = [unknown, lateBot, earlyBot];
    const before = JSON.stringify(bots);
    const summary = buildWorkspaceSummary(bots, true);
    expect(summary.decisions.map((item) => [item.bot.id, item.at])).toEqual([["early", 20], ["late", 40], ["unknown", undefined]]);
    expect(JSON.stringify(bots)).toBe(before);
  });

  it("ignores pending cards and replies on an abandoned branch", () => {
    const branched = bot({ unread: true, messages: [user, decision, reply], activeLeafId: user.id });
    const summary = buildWorkspaceSummary([branched], true);
    expect(summary.decisions).toEqual([]);
    expect(summary.replies).toEqual([]);
    expect(summary.available).toHaveLength(1);
  });

  it.each<Partial<Bot>>([{ activity: "working", busy: false }, { busy: true }])(
    "recognizes current work from explicit activity or legacy busy: %j", (patch) => {
      const working = bot({ messages: [user], ...patch });
      expect(buildWorkspaceSummary([working], true).working[0]).toMatchObject({ title: "Working", detail: user.text });
      expect(operationalAvatarState(working, true)).toBe("working");
    },
  );

  it("does not treat conflicting idle and busy signals as work or a settled reply", () => {
    const uncertain = bot({ activity: "idle", busy: true, unread: true, messages: [user, reply] });
    const summary = buildWorkspaceSummary([uncertain], true);
    expect(summary.working).toEqual([]);
    expect(summary.replies).toEqual([]);
    expect(summary.available[0].title).toBe("Status updating");
    expect(operationalAvatarState(uncertain, true)).toBe("idle");
  });

  it("surfaces a real unread settled reply, without calling it a successful outcome", () => {
    const ready = bot({ activity: "idle", unread: true, messages: [user, reply], activeLeafId: reply.id });
    expect(buildWorkspaceSummary([ready], true).replies).toEqual([{ bot: ready, title: "New reply", detail: reply.text, at: reply.at }]);
    expect(operationalAvatarState(ready, true)).toBe("notifying");
  });

  it.each<Partial<Bot>>([
    { unread: false, messages: [user, reply] },
    { unread: true, messages: [reply] },
    { unread: true, messages: [{ ...user, text: " " }, reply] },
    { unread: true, messages: [user, { ...reply, text: " " }] },
    { unread: true, messages: [user, reply, { ...user, id: "next", at: 40, parentId: reply.id }] },
    { unread: true, messages: [user, reply, { ...user, id: "queued", queued: true, at: 40, parentId: reply.id }] },
    { unread: true, busy: true, messages: [user, reply] },
  ])("excludes read, greeting, empty, superseded or unsettled replies: %j", (patch) => {
    expect(buildWorkspaceSummary([bot(patch)], true).replies).toEqual([]);
  });

  it("does not celebrate an error after an older reply", () => {
    const failed = bot({ unread: true, messages: [user, reply, { id: "failure", at: 40, role: "bot", kind: "activity", tool: { name: "Read", ok: false }, parentId: reply.id }] });
    const summary = buildWorkspaceSummary([failed], true);
    expect(summary.replies).toEqual([]);
    expect(summary.available[0].detail).toContain("reported an error");
    expect(operationalAvatarState(failed, true)).toBe("idle");
  });

  it("orders new replies newest first with stable ID ties", () => {
    const ready = (id: string, at: number) => bot({ id, unread: true, messages: [user, { ...reply, at }] });
    expect(buildWorkspaceSummary([ready("b", 30), ready("a", 30), ready("newest", 50)], true).replies.map((item) => item.bot.id))
      .toEqual(["newest", "a", "b"]);
  });

  it.each<Bot["activity"]>(["no-signal", "dead"])("keeps %s out of live work even if busy is stale", (activity) => {
    const offline = bot({ activity, busy: true, unread: true, messages: [user, reply] });
    const summary = buildWorkspaceSummary([offline], true);
    expect(summary.disconnected).toHaveLength(1);
    expect(summary.working).toEqual([]);
    expect(summary.replies).toEqual([]);
    expect(operationalAvatarState(offline, true)).toBe("idle");
  });

  it("turns all disconnected snapshots into last-known information", () => {
    const bots = [
      bot({ id: "asking", messages: [user, decision], busy: true }),
      bot({ id: "working", activity: "working", messages: [user] }),
      bot({ id: "reply", unread: true, messages: [user, reply] }),
    ];
    const summary = buildWorkspaceSummary(bots, false);
    expect(summary.decisions).toEqual([]);
    expect(summary.working).toEqual([]);
    expect(summary.replies).toEqual([]);
    expect(summary.disconnected).toHaveLength(3);
    expect(summary.disconnected.every((item) => item.title === "Connection lost" && item.detail.startsWith("Last known:"))).toBe(true);
    expect(summary.disconnected[0].detail).toContain(card.subtitle);
    expect(summary.disconnected[2].detail).toContain(reply.text);
    expect(bots.map((entry) => operationalAvatarState(entry, false))).toEqual(["idle", "idle", "idle"]);
  });

  it("omits hidden bots and assigns every visible bot to exactly one bucket", () => {
    const visible = bot({ id: "visible" });
    const hidden = bot({ id: "hidden", hidden: true, activity: "waiting-on-you" });
    const summary = buildWorkspaceSummary([hidden, visible], true);
    expect(Object.values(summary).flat().map((item) => item.bot.id)).toEqual(["visible"]);
    expect(summary.available[0].bot).toBe(visible);
    expect(Object.values(buildWorkspaceSummary([], true)).flat()).toEqual([]);
  });

  it("does not infer activity from a coding role or a pinned happy expression", () => {
    const idle = bot({ name: "Coding agent", title: "Software engineer", mascotExpression: "happy" });
    expect(operationalAvatarState(idle, true)).toBe("idle");
    expect(buildWorkspaceSummary([idle], true).available).toHaveLength(1);
  });
});
