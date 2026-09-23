import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SteerQueueSnapshot } from "../../server/contracts";
import { QueuedSendStrip } from "./Composer";

// The 1:1 follow-up queue strip, server-rendered like the other component
// contract tests (see SeedOptionCard.test.ts): markup only — actions are
// asserted to be WIRED, never invoked, without a store or a fetch.

function renderStrip(queue: SteerQueueSnapshot | null, busyName = "Astra") {
  const onRemove = vi.fn();
  const onSetPaused = vi.fn();
  const html = renderToStaticMarkup(
    createElement(QueuedSendStrip, { queue, busyName, onRemove, onSetPaused }),
  );
  return { html, onRemove, onSetPaused };
}

const item = (messageId: string, text: string) => ({ messageId, threadId: "thread-1", text });

describe("1:1 follow-up queue strip (server rendering)", () => {
  it("lists every waiting send with a per-item remove and the busy promise", () => {
    const { html, onRemove, onSetPaused } = renderStrip({
      botId: "bot-1",
      paused: false,
      items: [item("m1", "first steering note"), item("m2", "second steering note")],
    });
    expect(html).toContain("first steering note");
    expect(html).toContain("second steering note");
    expect(html).toContain("Queued — sends when Astra finishes");
    expect(html.match(/aria-label="Remove queued message"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Hold the queue"');
    // markup only: a server render never acts
    expect(onRemove).not.toHaveBeenCalled();
    expect(onSetPaused).not.toHaveBeenCalled();
  });

  it("offers the explicit resume while the queue is held", () => {
    const { html } = renderStrip({ botId: "bot-1", paused: true, items: [item("m1", "held note")] });
    expect(html).toContain('aria-label="Resume queued messages"');
    expect(html).toContain("Resume queued messages");
    expect(html).toContain("Queue paused");
    expect(html).toContain("held note");
    expect(html).not.toContain('aria-label="Hold the queue"');
  });

  it("renders nothing for a missing or empty queue — no false promise", () => {
    expect(renderStrip(null).html).toBe("");
    expect(renderStrip({ botId: "bot-1", paused: false, items: [] }).html).toBe("");
  });
});
