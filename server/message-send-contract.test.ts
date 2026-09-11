import { describe, expect, it } from "vitest";
import { MessageThreadError, requireMessageThread } from "./message-send-contract.ts";

describe("ordinary message thread guard", () => {
  it("allows legacy requests to target the freshly resolved thread", () => {
    expect(requireMessageThread({ text: "hello" }, "current-thread")).toBe("current-thread");
  });

  it("accepts an exact displayed thread and captures its immutable identifier", () => {
    const bot = { threadId: "thread_123-abc" };
    const captured = requireMessageThread({ expectedThreadId: bot.threadId }, bot.threadId);
    bot.threadId = "another-task";
    expect(captured).toBe("thread_123-abc");
  });

  it.each([null, undefined, true, 1, "", " ", "thread/id", "thread.id", " café", "a".repeat(129), [], {}])(
    "rejects malformed explicitly supplied thread %j with 400",
    (expectedThreadId) => {
      expect(() => requireMessageThread({ expectedThreadId }, "current-thread"))
        .toThrow(expect.objectContaining({ name: "MessageThreadError", status: 400 }));
    },
  );

  it("rejects a stale displayed thread with a recoverable conflict", () => {
    expect(() => requireMessageThread({ expectedThreadId: "previous-thread" }, "current-thread"))
      .toThrow(new MessageThreadError(409, "This conversation has changed. Reopen it and review your draft before sending."));
  });

  it("compares thread identifiers without case folding or whitespace normalization", () => {
    expect(() => requireMessageThread({ expectedThreadId: "Thread-A" }, "thread-a"))
      .toThrow(expect.objectContaining({ status: 409 }));
    expect(() => requireMessageThread({ expectedThreadId: "thread-a " }, "thread-a"))
      .toThrow(expect.objectContaining({ status: 400 }));
  });
});
