import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StopCleanupNotice } from "./StopCleanupNotice";
import { EMPTY_STOP_ACTION, type StopCleanupAction } from "@/state/stop-cleanup-session";

const recovery = { receipt: "a".repeat(64), threadId: "original-task", message: "Queued handoffs could not be saved." };
function render(action: StopCleanupAction = { pending: null, recovery }, threadId = "original-task") {
  const onRetry = vi.fn();
  const onReview = vi.fn();
  const onDismiss = vi.fn();
  return { html: renderToStaticMarkup(createElement(StopCleanupNotice, { action, threadId, onRetry, onReview, onDismiss })), onRetry, onReview, onDismiss };
}
describe("persistent Stop recovery notice", () => {
  it("renders an accessible, named recovery action without invoking it", () => {
    const view = render();
    expect(view.html).toContain('role="alert"');
    expect(view.html).toContain('aria-label="Stop needs attention"');
    expect(view.html).toContain("Retry stop cleanup");
    expect(view.html).toContain("Review current conversation");
    expect(view.html).not.toContain(recovery.receipt);
    expect(view.onRetry).not.toHaveBeenCalled();
    expect(view.onReview).not.toHaveBeenCalled();
    expect(view.onDismiss).not.toHaveBeenCalled();
  });
  it("does not render normal successful Stop as an error", () => {
    expect(render(EMPTY_STOP_ACTION).html).toBe("");
  });
  it("disables every notice action while retry is pending", () => {
    const { html } = render({ pending: "cleanup", recovery });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Retrying cleanup…");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
  it("guides stale or missing receipts to current work without offering another Stop", () => {
    const { html } = render({ pending: null, recovery: { ...recovery, receipt: null } });
    expect(html).not.toContain("Retry stop cleanup");
    expect(html).toContain("Review the current conversation and task");
    expect(html).toContain("Review current conversation");
  });
  it("explains that the original receipt remains tied to an earlier task after navigation", () => {
    expect(render(undefined, "other-task").html).toContain("This notice belongs to an earlier task for this bot.");
    expect(render().html).not.toContain("This notice belongs to an earlier task for this bot.");
  });
});
