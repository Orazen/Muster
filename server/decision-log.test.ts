// The decision log is the trust gateway's source of truth, so its tests pin
// the properties the audit surface silently depends on: one bot never sees
// another's verdicts, pages come back newest-first with a working cursor,
// the public shape carries no botId, and everything round-trips through the
// persisted file a restart would read back.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { AUDIT_MAX_LIMIT, DEFAULT_AUDIT_LIMIT, DecisionLog, queryAudit } from "./decision-log.ts";

afterEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const FILE = () => join(DATA_DIR, "decisions.json");

/** Deterministic clock + ids so page cursors and ordering are exact.
 * Ids stay strings — the same type production newId() emits. */
const tick = (start = 10_000) => {
  let n = start;
  return () => ++n;
};
const idTick = (start = 1_000) => {
  let n = start;
  return () => String(++n);
};

describe("DecisionLog", () => {
  it("records entries newest-last and pages them newest-first", () => {
    const nextId = idTick();
    const at = tick(10_000);
    const log = new DecisionLog({ file: FILE(), now: at, makeId: nextId });
    log.record("bot-1", { action: "Bash", decision: "approved", summary: "git status" });
    log.record("bot-1", { action: "WebFetch", decision: "denied", summary: "https://example.com" });

    const page = log.page("bot-1", { limit: 50 });
    expect(page.entries.map((e) => e.action)).toEqual(["WebFetch", "Bash"]);
    expect(page.nextBefore).toBeUndefined();
  });

  it("keeps the public shape exactly: no botId leaks into an entry", () => {
    const log = new DecisionLog({ file: FILE(), now: tick(), makeId: idTick() });
    log.record("bot-1", { action: "Bash", decision: "auto", rule: "auto-approved Bash:git (always allowed)", summary: "git status" });
    const [entry] = log.page("bot-1", { limit: 1 }).entries;
    // SAFETY: page just returned at least the one entry recorded above.
    const first = entry!;
    expect(Object.keys(first).sort()).toEqual(["action", "at", "decision", "id", "rule", "summary"].sort());
    expect(first.decision).toBe("auto");
    expect(first.rule).toBe("auto-approved Bash:git (always allowed)");
  });

  it("scopes every page to one bot", () => {
    const log = new DecisionLog({ file: FILE(), now: tick(), makeId: idTick() });
    log.record("bot-1", { action: "Bash", decision: "approved", summary: "mine" });
    log.record("bot-2", { action: "Bash", decision: "denied", summary: "theirs" });
    expect(log.page("bot-1", { limit: 50 }).entries.map((e) => e.summary)).toEqual(["mine"]);
    expect(log.page("bot-2", { limit: 50 }).entries.map((e) => e.summary)).toEqual(["theirs"]);
  });

  it("walks backwards with ?before= and refuses dead cursors", () => {
    const makeId = idTick();
    const log = new DecisionLog({ file: FILE(), now: tick(), makeId });
    for (let i = 0; i < 5; i += 1) log.record("bot-1", { action: `tool-${i}`, decision: "approved", summary: `${i}` });

    const firstPage = log.page("bot-1", { limit: 2 });
    expect(firstPage.entries.map((e) => e.action)).toEqual(["tool-4", "tool-3"]);
    expect(firstPage.nextBefore).toBe("1004"); // ids are the deterministic tick() sequence, newest = 1005

    const secondPage = log.page("bot-1", { limit: 2, before: firstPage.nextBefore ?? "" });
    expect(secondPage.entries.map((e) => e.action)).toEqual(["tool-2", "tool-1"]);

    expect(log.page("bot-1", { limit: 2, before: "no-such-id" }).entries).toEqual([]);
  });

  it("round-trips through the file so a restart keeps the ledger", () => {
    const log = new DecisionLog({ file: FILE(), now: tick(), makeId: idTick() });
    log.record("bot-1", { action: "ask_bot", decision: "denied", rule: "no answer within 15 minutes", summary: "@peer" });
    const revived = new DecisionLog({ file: FILE() });
    expect(revived.page("bot-1", { limit: 50 }).entries[0]?.rule).toBe("no answer within 15 minutes");
  });

  it("caps the ledger by dropping oldest entries first", () => {
    const log = new DecisionLog({ file: FILE(), now: tick(), makeId: idTick(), maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) log.record("bot-1", { action: `tool-${i}`, decision: "auto", summary: "" });
    expect(log.page("bot-1", { limit: 50 }).entries.map((e) => e.action)).toEqual(["tool-4", "tool-3", "tool-2"]);
  });
});

describe("queryAudit (the endpoint's factored logic)", () => {
  it("defaults to 50 and clamps garbage and out-of-range limits", () => {
    const params = (limit?: string) => {
      const p = new URLSearchParams();
      if (limit !== undefined) p.set("limit", limit);
      return p;
    };
    const log = new DecisionLog({ file: FILE(), now: tick(), makeId: idTick() });
    expect(queryAudit(log, "bot-1", params()).entries).toEqual([]);
    // clamping is observable through a bot that HAS more than the cap:
    const fat = new DecisionLog({ file: FILE(), now: tick(), makeId: idTick(), maxEntries: AUDIT_MAX_LIMIT + 10 });
    for (let i = 0; i < AUDIT_MAX_LIMIT + 10; i += 1) fat.record("bot-1", { action: "t", decision: "auto", summary: "" });
    expect(queryAudit(fat, "bot-1", params("9999")).entries.length).toBe(AUDIT_MAX_LIMIT);
    expect(queryAudit(fat, "bot-1", params("not-a-number")).entries.length).toBe(Math.min(DEFAULT_AUDIT_LIMIT, AUDIT_MAX_LIMIT));
    expect(queryAudit(fat, "bot-1", params("0")).entries.length).toBe(1);
  });

  it("threads the before cursor straight through to the page walk", () => {
    const log = new DecisionLog({ file: FILE(), now: tick(), makeId: idTick() });
    for (let i = 0; i < 3; i += 1) log.record("bot-1", { action: `t${i}`, decision: "approved", summary: "" });
    const first = queryAudit(log, "bot-1", new URLSearchParams("limit=1"));
    const second = queryAudit(log, "bot-1", new URLSearchParams(`limit=1&before=${first.nextBefore}`));
    expect(second.entries.map((e) => e.action)).toEqual(["t1"]);
  });
});
