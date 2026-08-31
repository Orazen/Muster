// Unit tests for the portable-context rebuild: sizing, boundary rules,
// compaction caching, chained summaries, and honest degradation when the
// engine cannot summarize.
import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  buildModelContext,
  estimateTokens,
  latestCompaction,
  messageTokens,
  renderForModel,
  reserveForReply,
} from "./model-context.ts";

let seq = 0;
function mk(partial: Partial<Message> & Pick<Message, "role" | "kind">): Message {
  seq += 1;
  return { id: `m${seq}`, at: seq, ...partial };
}

const convo = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) =>
    mk({ role: i % 2 === 0 ? "user" : "bot", kind: "text", text: `message ${i} `.repeat(20) }),
  );

describe("token estimation", () => {
  it("estimates ~4 chars per token and scales the reserve with the window", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
    expect(reserveForReply(8_000)).toBeGreaterThanOrEqual(2_048);
    expect(reserveForReply(200_000)).toBeLessThanOrEqual(32_768);
    // pi's flat 16384 problem: the reserve must not eat an 8k window whole
    expect(reserveForReply(8_000)).toBeLessThan(4_000);
  });

  it("prices text by content and activity as compact fixed lines", () => {
    const text = mk({ role: "bot", kind: "text", text: "y".repeat(400) });
    expect(messageTokens(text)).toBeGreaterThan(90);
    const tool = mk({ role: "bot", kind: "activity", tool: { name: "screenshot", ok: true } });
    expect(messageTokens(tool)).toBeLessThan(30);
    // UI affordances cost nothing
    expect(messageTokens(mk({ role: "bot", kind: "options" }))).toBe(0);
  });
});

describe("renderForModel", () => {
  it("carries work, not just talk", () => {
    expect(renderForModel(mk({ role: "user", kind: "text", text: "hi" }))).toEqual({
      role: "user",
      text: "hi",
    });
    const failed = renderForModel(
      mk({ role: "bot", kind: "activity", tool: { name: "click", ok: false } }),
    );
    expect(failed?.text).toContain("click");
    expect(failed?.text).toContain("failed");
    const shot = renderForModel(mk({ role: "bot", kind: "screen" }));
    expect(shot?.text).toContain("screenshot");
    expect(renderForModel(mk({ role: "bot", kind: "options" }))).toBeNull();
  });
});

describe("buildModelContext", () => {
  it("keeps a short thread whole with no summary", async () => {
    const messages = convo(6);
    const built = await buildModelContext({ messages, targetWindow: 100_000 });
    expect(built.transcript).toHaveLength(6);
    expect(built.summary).toBeNull();
    expect(built.pending).toBeNull();
  });

  it("cuts before a user turn, summarizes the overflow, and reports a pending record", async () => {
    const messages = convo(40); // ~40 * 125 tokens ≈ 5k
    let prompted = "";
    const built = await buildModelContext({
      messages,
      targetWindow: 3_000, // budget = 2250 tokens ≈ 18 messages
      summarize: async (p) => {
        prompted = p;
        return "SUMMARY";
      },
    });
    expect(built.summary).toBe("SUMMARY");
    expect(built.transcript.length).toBeGreaterThan(0);
    expect(built.transcript.length).toBeLessThan(messages.length);
    // the cut never splits an exchange: the first kept message is the user's
    expect(built.transcript[0].role).toBe("user");
    // pending record anchors at the first kept message
    expect(built.pending?.firstKeptId).toBe(messages[messages.length - built.transcript.length].id);
    // the prompt actually contained the overflow text
    expect(prompted).toContain("message 0");
  });

  it("treats an existing compaction record as a cache hit without re-summarizing", async () => {
    const messages = convo(10);
    const anchor = messages[4]; // kept range starts after this
    const record = mk({
      role: "bot",
      kind: "compaction",
      compaction: { summary: "OLD SUMMARY", firstKeptId: anchor.id, tokensBefore: 500, at: 1 },
    });
    messages.push(record);
    let calls = 0;
    const built = await buildModelContext({
      messages,
      targetWindow: 3_000,
      summarize: async () => {
        calls += 1;
        return "NEW";
      },
    });
    expect(calls).toBe(0);
    expect(built.summary).toBe("OLD SUMMARY");
    expect(built.pending).toBeNull();
    // kept range starts right after the anchor
    expect(built.transcript[0].text).toContain(messages[5].text!.trim());
  });

  it("chains: an older summary inside the overflow is fed into the new prompt", async () => {
    const messages = convo(10);
    const oldAnchor = messages[1];
    messages.unshift(
      mk({
        role: "bot",
        kind: "compaction",
        compaction: { summary: "PRIOR SUMMARY", firstKeptId: oldAnchor.id, tokensBefore: 10, at: 1 },
      }),
    );
    const prompts: string[] = [];
    // tiny window forces a fresh cut far past the old record's coverage
    await buildModelContext({
      messages,
      targetWindow: 900,
      summarize: async (p) => {
        prompts.push(p);
        return "MERGED";
      },
    });
    expect(prompts[0]).toContain("PRIOR SUMMARY");
  });

  it("chunks oversized overflow into multiple merged summaries", async () => {
    // one enormous exchange: way over the chunk budget on its own
    const huge = mk({ role: "user", kind: "text", text: "w".repeat(80_000) });
    const reply = mk({ role: "bot", kind: "text", text: "z".repeat(80_000) });
    let calls = 0;
    const built = await buildModelContext({
      messages: [huge, reply],
      targetWindow: 4_000,
      summarize: async (p) => {
        calls += 1;
        return `part(${p.length})`;
      },
    });
    expect(calls).toBeGreaterThan(1);
    expect(built.summary).toContain("part(");
  });

  it("stays bounded without a summarizer, and says history was omitted", async () => {
    const messages = convo(60);
    const built = await buildModelContext({ messages, targetWindow: 2_000 });
    expect(built.transcript.length).toBeLessThan(messages.length);
    expect(built.summary).toContain("omitted");
    expect(built.pending).toBeNull();
  });

  it("falls back to the conservative default window when the catalog does not declare one", async () => {
    const messages = convo(6);
    const built = await buildModelContext({ messages, targetWindow: null });
    expect(built.windowTokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(built.transcript).toHaveLength(6);
  });

  it("finds the newest compaction record only", () => {
    const a = mk({ role: "bot", kind: "compaction", compaction: { summary: "a", firstKeptId: "x", tokensBefore: 1, at: 1 } });
    const b = mk({ role: "bot", kind: "compaction", compaction: { summary: "b", firstKeptId: "y", tokensBefore: 2, at: 2 } });
    expect(latestCompaction([a, b])?.data.summary).toBe("b");
    expect(latestCompaction(convo(3))).toBeNull();
  });
});
