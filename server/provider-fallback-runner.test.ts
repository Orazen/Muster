import { describe, expect, it, vi } from "vitest";
import { ProviderFallbackRunner, matchesActiveProvider, type FallbackCandidate, type FallbackSnapshot } from "./provider-fallback-runner.ts";
let sequence = 0;
function fixture() {
  const threadId = `fallback-runner-${++sequence}`;
  let snapshot: FallbackSnapshot | null = { ownerId: "alice", threadId, instanceId: "source:alice", model: "original", latestUserId: "message-1" };
  let consent = { enabled: true, generation: 1 };
  const describeInstances = vi.fn(async () => [{ instanceId: "target:alice", state: "available" }]);
  const retry = vi.fn(async (_candidate: FallbackCandidate) => {});
  const runner = new ProviderFallbackRunner({ snapshot: () => snapshot, consent: () => consent, describe: describeInstances, retry });
  const input = { ...snapshot, botId: "bot", text: "original request" };
  const event = { providerInstanceId: "source:alice", turnId: "turn-1" };
  runner.begin(input);
  runner.bindTurn("bot", threadId, event.providerInstanceId, event.turnId);
  return { runner, input, event, retry, describeInstances, error: () => runner.error("bot", threadId, "HTTP 429", event), complete: (ok = false) => runner.complete("bot", threadId, ok, event), change: (patch: Partial<FallbackSnapshot>) => { snapshot = { ...snapshot!, ...patch }; }, consent: (enabled: boolean, generation = 1) => { consent = { enabled, generation }; } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; }

describe("consented provider fallback coordinator", () => {
  it("defaults to no lookup or retry without consent at error time", async () => {
    const f = fixture(); f.consent(false); f.error(); f.consent(true); await f.complete();
    expect(f.describeInstances).not.toHaveBeenCalled(); expect(f.retry).not.toHaveBeenCalled();
  });
  it("retries the captured request once without changing the preferred model", async () => {
    const f = fixture();
    f.retry.mockImplementation(async (candidate) => {
      expect(candidate.text).toBe("original request"); expect(candidate.guard()).toBe(true);
      expect(candidate.targetInstanceId).toBe("target:alice"); expect(candidate.guard()).toBe(true);
      f.change({ model: "user changed model" }); expect(candidate.guard()).toBe(false);
    });
    f.error(); await Promise.all([f.complete(), f.complete()]);
    expect(f.describeInstances).toHaveBeenCalledTimes(1); expect(f.retry).toHaveBeenCalledTimes(1);
  });
  it.each(["revoked", "reenabled", "new turn", "stop", "owner", "model", "message", "instance", "progress"])("invalidates lookup after %s", async (change) => {
    const f = fixture(); const wait = deferred();
    f.describeInstances.mockImplementation(async () => { await wait.promise; return [{ instanceId: "target:alice", state: "available" }]; });
    f.error(); const completion = f.complete();
    if (change === "revoked") f.consent(false, 2);
    if (change === "reenabled") f.consent(true, 3);
    if (change === "new turn") f.runner.begin(f.input);
    if (change === "stop") f.runner.cancel("bot");
    if (change === "owner") f.change({ ownerId: "bob" });
    if (change === "model") f.change({ model: "changed" });
    if (change === "message") f.change({ latestUserId: "message-2" });
    if (change === "instance") f.change({ instanceId: "target:alice", model: "" });
    if (change === "progress") f.runner.markProgress("bot", f.input.threadId, f.event);
    wait.resolve(); await completion; expect(f.retry).not.toHaveBeenCalled();
  });
  it("never chooses a global or another account's engine", async () => {
    const f = fixture(); f.describeInstances.mockResolvedValue([{ instanceId: "global", state: "available" }, { instanceId: "target:bob", state: "available" }]);
    f.error(); await f.complete(); expect(f.retry).not.toHaveBeenCalled();
  });
  it.each([true, false])("does not replay progress before error (completion ok=%s)", async (ok) => {
    const f = fixture(); f.runner.markProgress("bot", f.input.threadId, f.event); f.error(); await f.complete(ok);
    expect(f.describeInstances).not.toHaveBeenCalled();
  });
  it("does not retry a successful turn even if an error was observed", async () => {
    const f = fixture(); f.error(); await f.complete(true); expect(f.retry).not.toHaveBeenCalled();
  });
  it("rejects stale same-provider errors and completions after a new turn", async () => {
    const f = fixture(); f.runner.begin(f.input); f.runner.bindTurn("bot", f.input.threadId, "source:alice", "turn-2");
    f.error(); await f.complete(); expect(f.describeInstances).not.toHaveBeenCalled();
    const current = { providerInstanceId: "source:alice", turnId: "turn-2" };
    f.runner.error("bot", f.input.threadId, "quota", current); await f.runner.complete("bot", f.input.threadId, false, current);
    expect(f.retry).toHaveBeenCalledTimes(1);
  });
  it("fails closed for missing or mismatched event identity", async () => {
    const f = fixture();
    for (const event of [{}, { turnId: "turn-1" }, { ...f.event, providerInstanceId: "other" }]) {
      f.runner.error("bot", f.input.threadId, "quota", event); await f.runner.complete("bot", f.input.threadId, false, event);
    }
    expect(f.describeInstances).not.toHaveBeenCalled();
  });
  it("revalidates consent in the asynchronous retry callback", async () => {
    const f = fixture(); f.retry.mockImplementation(async (candidate) => { f.consent(false, 2); expect(candidate.guard()).toBe(false); });
    f.error(); await f.complete(); expect(f.retry).toHaveBeenCalledTimes(1);
  });
  it("does not consume cooldown when no alternate exists", async () => {
    const f = fixture(); f.describeInstances.mockResolvedValue([]); f.error(); await f.complete();
    f.describeInstances.mockResolvedValue([{ instanceId: "target:alice", state: "available" }]);
    f.runner.begin(f.input); f.runner.bindTurn("bot", f.input.threadId, f.event.providerInstanceId, f.event.turnId);
    f.error(); await f.complete(); expect(f.retry).toHaveBeenCalledTimes(1);
  });
  it("enforces the shared cooldown on a subsequent turn", async () => {
    const f = fixture(); f.error(); await f.complete();
    f.runner.begin(f.input); f.runner.bindTurn("bot", f.input.threadId, f.event.providerInstanceId, f.event.turnId);
    f.error(); await f.complete(); expect(f.retry).toHaveBeenCalledTimes(1);
  });
  it("rejects missing account ownership without selecting global engines", async () => {
    const f = fixture(); f.runner.begin({ ...f.input, ownerId: "" }); f.runner.bindTurn("bot", f.input.threadId, f.event.providerInstanceId, f.event.turnId);
    f.error(); await f.complete(); expect(f.describeInstances).not.toHaveBeenCalled();
  });
  it("invalidates an in-progress retry guard when Stop cancels the ticket", async () => {
    const f = fixture(); f.retry.mockImplementation(async (candidate) => {
      expect(candidate.guard()).toBe(true); f.runner.cancel("bot"); expect(candidate.guard()).toBe(false);
    });
    f.error(); await f.complete(); expect(f.retry).toHaveBeenCalledTimes(1);
  });

});

describe("active retry provider event fence", () => {
  it("rejects late or unattributed predecessor events while the alternate is active", () => {
    expect(matchesActiveProvider({ providerInstanceId: "source:alice", turnId: "old" }, { instanceId: "target:alice" })).toBe(false);
    expect(matchesActiveProvider({}, { instanceId: "target:alice" })).toBe(false);
    expect(matchesActiveProvider({ providerInstanceId: "target:alice", turnId: "new" }, { instanceId: "target:alice" })).toBe(true);
  });
  it("does not block events when no replacement turn is active", () => {
    expect(matchesActiveProvider({ providerInstanceId: "source:alice" })).toBe(true);
  });
});
