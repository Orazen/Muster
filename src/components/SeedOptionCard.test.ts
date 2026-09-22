import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createOnboardingCard } from "../../server/seed-card";
import type { OptionCardData } from "@/state/store";
import type { SeedAnswer, SeedCardActionState } from "@/state/seed-card-session";
import { SeedOptionCardView, UnavailableSeedCard } from "./SeedOptionCard";

const empty: SeedCardActionState = { draft: "", pending: null, error: null };
function render(card: OptionCardData = createOnboardingCard(), action: SeedCardActionState = empty) {
  const onAnswer = vi.fn();
  const onStart = vi.fn();
  const onCheck = vi.fn();
  const html = renderToStaticMarkup(createElement(SeedOptionCardView, { card, action, onAnswer, onStart, onCheck, onEdit: vi.fn() }));
  return { html, onAnswer, onStart, onCheck };
}
function saved(status: SeedAnswer["status"]): OptionCardData {
  return { ...createOnboardingCard(), answered: "Life admin", seedAnswer: { messageId: "saved-user", attempt: 1, status } };
}

describe("seed card status and controls (server rendering)", () => {
  it("renders real choices and a labelled multiline answer without invoking actions", () => {
    const view = render(createOnboardingCard(), { ...empty, draft: "Prefilled draft" });
    expect(view.html).toContain("Work &amp; projects");
    expect(view.html).toContain('aria-label="Your own answer"');
    expect(view.html).toContain("Prefilled draft");
    expect(view.html).toContain("Send answer");
    expect(view.html).not.toContain("Dismiss");
    expect(view.onAnswer).not.toHaveBeenCalled();
    expect(view.onStart).not.toHaveBeenCalled();
    expect(view.onCheck).not.toHaveBeenCalled();
  });

  it.each([
    ["recorded", "The task has not started.", true],
    ["starting", "Start requested; waiting for confirmation.", false],
    ["started", "The task started; follow its progress in this conversation.", false],
    ["not-started", "The task did not start.", true],
    ["uncertain", "The start result could not be confirmed.", false],
  ] as const)("reports persisted %s state without equating record/start/completion", (status, text, startAllowed) => {
    const { html, onStart } = render(saved(status));
    expect(html).toContain("Answer recorded.");
    expect(html).toContain(text);
    expect(html).toContain("Saved answer:");
    expect(html).toContain("Check status");
    expect(html.includes("Start saved task")).toBe(startAllowed);
    expect(html).not.toContain("Your own answer");
    expect(html).not.toContain("Retry same answer");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("shows a retryable error and keeps the exact custom draft after an unconfirmed answer", () => {
    const { html } = render(createOnboardingCard(), {
      ...empty, draft: "  newer text\n  <img src=x onerror=alert(1)>  ", lastAnswer: "Original submitted answer",
      error: "Response lost. Check status before trying again.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Response lost. Check status before trying again.");
    expect(html).toContain("  newer text\n  &lt;img src=x onerror=alert(1)&gt;  ");
    expect(html).not.toContain("<img");
    expect(html).toContain("Check status");
    expect(html).toContain("Retry same answer");
  });

  it("keeps all submissions disabled while recording, while the draft remains editable", () => {
    const { html } = render(createOnboardingCard(), { ...empty, pending: "answer", draft: "Draft still visible" });
    const buttons = [...html.matchAll(/<button\b([^>]*)>/g)];
    expect(buttons).toHaveLength(5);
    expect(buttons.every((button) => /\sdisabled(?:=|\s|$)/.test(button[1]))).toBe(true);
    expect(html).toContain("Recording your answer…");
    expect(html).toContain("Draft still visible");
    expect(html.match(/<textarea\b([^>]*)>/)?.[1]).not.toContain("disabled");
  });

  it.each(["start", "check"] as const)("disables explicit recovery actions while %s is pending", (pending) => {
    const { html } = render(saved("not-started"), { ...empty, pending });
    expect([...html.matchAll(/<button\b([^>]*)>/g)].every((button) => /\sdisabled(?:=|\s|$)/.test(button[1]))).toBe(true);
    expect(html).toContain(pending === "start" ? "Requesting task start…" : "Checking saved status…");
  });

  it("renders persisted setup failure and custom answer literally, without a false success badge", () => {
    const card = saved("not-started");
    card.answered = "  indent\n<svg onload=bad()>  ";
    card.seedAnswer!.error = "Choose an engine <first>";
    const { html } = render(card);
    expect(html).toContain("  indent\n&lt;svg onload=bad()&gt;  ");
    expect(html).toContain("Choose an engine &lt;first&gt;");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("task completed");
  });

  it("keeps unrecognized historical questions readable without unsupported answer/dismiss controls", () => {
    const html = renderToStaticMarkup(createElement(UnavailableSeedCard, { card: {
      title: "A saved historical question", subtitle: "From another workflow", options: ["Allow", "Deny"],
    } }));
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).toContain("Saved — this question continues in the conversation.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  it("preserves a legacy saved answer without claiming a receipt or offering status recovery", () => {
    const html = renderToStaticMarkup(createElement(UnavailableSeedCard, { card: {
      ...createOnboardingCard(), purpose: undefined, answered: "  Old answer\n<script>literal</script>  ",
    } }));
    expect(html).toContain("Saved answer: ");
    expect(html).toContain("  Old answer\n&lt;script&gt;literal&lt;/script&gt;  ");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Answer recorded.");
    expect(html).not.toContain("Check status");
    expect(html).not.toContain("Start saved task");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<textarea");
  });

  it.each([false, true])("explains later work and retains Check status while hiding obsolete writes (saved=%s)", (hasReceipt) => {
    const html = renderToStaticMarkup(createElement(SeedOptionCardView, {
      card: hasReceipt ? saved("not-started") : createOnboardingCard(), action: empty,
      writeBlocked: "This conversation already contains newer work.",
      onEdit: vi.fn(), onAnswer: vi.fn(), onStart: vi.fn(), onCheck: vi.fn(),
    }));
    expect(html).toContain("This conversation already contains newer work.");
    expect(html).toContain("Check status");
    expect(html).not.toContain("Send answer");
    expect(html).not.toContain("Start saved task");
    expect(html).not.toContain("Retry same answer");
    expect(html).not.toContain("<textarea");
    const enabled = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].filter((button) => !/\sdisabled(?:=|\s|$)/.test(button[1]));
    expect(enabled).toHaveLength(1);
    expect(enabled[0][2]).toBe("Check status");
  });
});
