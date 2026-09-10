import { decodeBot, decodeFleet, decodeFrame, decodeMessage, decodeRoom } from "./frames";
import { instancesSchema, threadPageSchema, jsonSchema } from "./contracts";
import { connectionOrigin, parseAddress, parseConnection } from "./connection";
const message = { id: "m1", role: "bot", kind: "text", at: 42, text: "hello" };
const bot = { id: "b1", threadId: "t1", name: "Noodle" };
const room = { id: "g1", threadId: "tg1", memberIds: ["b1"], defaultResponder: { kind: "member", botId: "b1" } };

describe("server wire contracts", () => {
  test("keeps valid neighbors and normalizes boolean unread plus legacy counts", () => {
    const fleet = decodeFleet({ bots: [bot, null, { ...bot, id: 4 }, { ...bot, id: "b2", unread: true }, { ...bot, id: "b3", unread: 3 }], groups: [{ ...room, unread: true }, false] });
    expect(fleet.bots.map((entry) => [entry.id, entry.unread])).toEqual([["b1", 0], ["b2", 1], ["b3", 3]]);
    expect(fleet.groups).toHaveLength(1);
    expect(fleet.groups[0].unread).toBe(1);
  });
  test("parses optional fields individually and drops malformed nested values", () => {
    expect(decodeBot({ ...bot, busy: "yes", createdAt: Infinity, alwaysAllow: ["Bash:git", 1], tasks: [{ threadId: "t1", title: "task", createdAt: 1 }, { threadId: 4 }], messages: [message, null] })).toMatchObject({ busy: undefined, createdAt: undefined, alwaysAllow: ["Bash:git"], tasks: [{ threadId: "t1", title: "task", createdAt: 1 }], messages: [message] });
    expect(decodeRoom({ ...room, bulletin: {}, memberIds: ["b1", false] })).toMatchObject({ bulletin: null, memberIds: ["b1"] });
  });
  test("retains actual approval reason and spoken activity strings", () => {
    expect(decodeMessage({ ...message, kind: "options", card: { title: "Run?", options: ["Allow", "Deny", 1], held: "Destructive command", requestId: "r1" }, tool: { name: "Bash", spoken: "running a command", ok: true } })).toMatchObject({ card: { options: ["Allow", "Deny"], held: "Destructive command", requestId: "r1" }, tool: { spoken: "running a command", ok: true } });
  });
  test("normalizes paginated messages identically to roster messages", () => {
    const wire = { ...message, kind: "future-kind", parentId: 7, reactions: [{ emoji: "ok", by: "user" }, { emoji: 7 }], card: { title: 4, options: null } };
    const page = threadPageSchema.parse({ messages: [wire, 9], hasMore: "false" });
    expect(page.messages).toEqual(decodeFleet(jsonSchema.parse({ bots: [{ ...bot, messages: [wire] }] })).bots[0].messages);
    expect(page).toMatchObject({ hasMore: undefined, messages: [{ kind: "unknown", parentId: null, reactions: [{ emoji: "ok", by: "user" }], card: { title: "", options: [] } }] });
  });
  test.each([null, {}, { bots: null }, { bots: {} }])("rejects invalid REST envelopes instead of replacing the roster %#", (wire) => {
    expect(() => decodeFleet(jsonSchema.parse(wire))).toThrow();
    expect(() => threadPageSchema.parse(wire)).toThrow();
    expect(() => instancesSchema.parse(wire)).toThrow();
  });
  test("reads actual instances wrapper and legacy array", () => {
    const instance = { instanceId: "i1", driverKind: "codex", snapshot: { state: "ready" }, models: { default: "gpt", options: [{ id: "gpt", label: "GPT" }] } };
    expect(instancesSchema.parse({ instances: [instance, { instanceId: "bad" }] })).toEqual(instancesSchema.parse([instance]));
    expect(instancesSchema.parse({ instances: [instance] })).toHaveLength(1);
  });
  test.each(["null", "[]", "{", "42"]) ("absorbs malformed frame %s", (wire) => {
    expect(decodeFrame(wire)).toEqual({ kind: "unknown", rawKind: "malformed" });
  });
  test.each([
    { kind: "hello", cursor: "s:1", resumed: false },
    { kind: "message", threadId: "t1", message }, { kind: "message.patch", threadId: "t1", message },
    { kind: "thread", threadId: "t1", activeLeafId: "m1" },
    { kind: "bot", bot }, { kind: "bot.deleted", botId: "b1" },
    { kind: "group", group: room }, { kind: "group.deleted", groupId: "g1" },
    { kind: "notify", notification: { kind: "approval", threadId: "t1" } },
    { kind: "screen", botId: "b1", png: "fixture", mime: "image/png" },
    { kind: "computer", botId: "b1", state: "running" }, { kind: "config" },
    { kind: "runtime", event: { type: "content.delta", delta: "hello" } },
  ])("decodes supported frame $kind", (wire) => { expect(decodeFrame(JSON.stringify(wire)).kind).toBe(wire.kind); });
  test.each([
    { kind: "message", threadId: "t1", message: {} }, { kind: "bot", bot: { id: "b1" } },
    { kind: "group", group: false }, { kind: "screen", botId: "b1" },
    { kind: "thread", threadId: 42 }, { kind: "new-server-feature", future: true },
  ])("does not invent entities for $kind", (wire) => { expect(decodeFrame(JSON.stringify(wire))).toEqual({ kind: "unknown", rawKind: wire.kind }); });
});

describe("connection addresses", () => {
  test.each([
    ["laptop.local", { host: "laptop.local", port: 8810, scheme: "http" }],
    ["http://laptop.local", { host: "laptop.local", port: 8810, scheme: "http" }],
    ["https://muster.example/", { host: "muster.example", port: 443, scheme: "https" }],
    ["https://muster.example:8443", { host: "muster.example", port: 8443, scheme: "https" }],
    ["http://localhost:80", { host: "localhost", port: 80, scheme: "http" }],
    ["[::1]:8810", { host: "::1", port: 8810, scheme: "http" }],
    ["https://[2001:db8::1]", { host: "2001:db8::1", port: 443, scheme: "https" }],
  ])("preserves scheme and port for %s", (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
    expect(new URL(connectionOrigin(parseAddress(input))).protocol).toBe(`${expected.scheme}:`);
  });
  test.each(["", "ftp://host", "https://user:pass@host", "https://host/path", "host?x", "host#x", "host:0", "host:65536", "host:1.5", "host:-1", "host:", "bad host", "[nonsense]", "::1", "https://host\\evil"]) ("rejects invalid address %s", (input) => { expect(() => parseAddress(input)).toThrow(); });
  test("accepts legacy saved HTTP and explicit HTTPS", () => {
    expect(parseConnection({ host: "localhost", port: 8810, token: "fixture" })).toEqual({ host: "localhost", port: 8810, token: "fixture" });
    const secure = parseConnection({ host: "::1", port: 443, token: "fixture", scheme: "https" });
    expect(secure && connectionOrigin(secure)).toBe("https://[::1]:443");
  });
  test.each([
    null, { host: "x", port: "8810", token: "x" }, { host: "https://x", port: 443, token: "x" },
    { host: "x", port: 0, token: "x" }, { host: "x", port: 8810, token: "" },
    { host: "x", port: 8810, token: "x\ny" }, { host: "x", port: 8810, token: "x", scheme: "ftp" },
  ])("rejects malformed saved connection %#", (wire) => { expect(parseConnection(jsonSchema.parse(wire))).toBeNull(); });
});
