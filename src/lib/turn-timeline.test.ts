import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { elapsedSince, timelineActions } from "./turn-timeline";

let seq = 0;
const activity = (name: string, ok?: boolean, extra: Partial<Message> = {}): Message => ({
  id: `m${++seq}`,
  role: "bot",
  kind: "activity",
  tool: { name, ok },
  at: 1_700_000_000_000 + seq * 1000,
  ...extra,
});
const text = (t: string): Message => ({ id: `m${++seq}`, role: "user", kind: "text", text: t, at: 1_700_000_000_000 });

describe("timelineActions", () => {
  it("returns recent tool runs, latest first", () => {
    const a = activity("read_file");
    const b = activity("bash");
    const out = timelineActions([a, b]);
    expect(out.map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it("marks unsettled runs as running and ok:false as failed", () => {
    const running = activity("edit_file");
    const failed = activity("bash", false);
    const done = activity("grep", true);
    const out = timelineActions([running, failed, done]);
    expect(out.find((x) => x.id === running.id)?.running).toBe(true);
    expect(out.find((x) => x.id === failed.id)?.failed).toBe(true);
    expect(out.find((x) => x.id === done.id)?.running).toBe(false);
    expect(out.find((x) => x.id === done.id)?.failed).toBe(false);
  });

  it("skips errors, comm chips, and non-activity messages", () => {
    const err = activity("error: the turn died", false);
    const comm = activity("Messaged @ops", undefined, {
      comm: { groupId: "g1", withBotId: "b2", withName: "Ops", withColor: "blue" },
    });
    const real = activity("read_file", true);
    const out = timelineActions([err, comm, text("hello"), real]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(real.id);
  });

  it("caps at max entries, keeping the newest", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => activity(`tool_${i}`, true));
    const out = timelineActions(msgs, 5);
    expect(out).toHaveLength(5);
    expect(out[0].name).toBe("tool_7");
    expect(out.at(-1)?.name).toBe("tool_3");
  });

  it("is empty for an empty transcript", () => {
    expect(timelineActions([])).toEqual([]);
  });
});

describe("elapsedSince", () => {
  const at = 1_700_000_000_000;
  it("shows seconds under a minute", () => {
    expect(elapsedSince(at - 12_345, at)).toBe("12s");
  });
  it("never goes negative on clock skew", () => {
    expect(elapsedSince(at + 5000, at)).toBe("0s");
  });
  it("shows minutes and padded seconds past a minute", () => {
    expect(elapsedSince(at - 243_000, at)).toBe("4m 03s");
  });
});
