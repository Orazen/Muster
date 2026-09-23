import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalWhy, Message, OptionCardData } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";

const why: ApprovalWhy = {
  source: "previous-run", runId: "previous-run", botId: "owner", threadId: "task",
  at: 1_783_296_000_000, outcome: "done", intent: "Inspect the project before changing it.",
  decisions: ["Read the configuration first."],
  hypothesis: "The previous configuration explains the failure.",
  findings: "The requested setting was absent.",
};
const history: NonNullable<OptionCardData["history"]> = {
  total: 3, approved: 2, denied: 1, auto: 0, lastDecision: "denied",
  summary: "2 approved and 1 denied for this tool.",
};
const rehearsal: NonNullable<OptionCardData["rehearsal"]> = {
  plannedSteps: 2, matchedSteps: 2, matchedRuns: 1, reviewedRuns: 1,
  summary: "Plan rehearsal: 2/2 tool steps matched in order; 1 completed run matched. Tool names and order only; arguments and screen states were not checked.",
};

function approval(overrides: Partial<OptionCardData> = {}): Message {
  return {
    id: "approval-message", at: 0, role: "bot", kind: "options",
    card: { title: "Approval needed", subtitle: "echo fixture-command", tool: "Bash", requestId: "exact-ask", options: ["Allow", "Deny"], ...overrides },
  };
}
const render = (message: Message) => renderToStaticMarkup(createElement(ApprovalCard, { message }));
const evidenceSection = /<section[^>]*aria-label="Approval evidence"/;

describe("persisted evidence on the permission transcript card", () => {
  it.each([
    { answered: undefined, status: "Waiting for your answer below" },
    { answered: "allow", status: "Allowed" },
    { answered: "deny", status: "Denied" },
  ])("retains all evidence and the exact action when status is $status", ({ answered, status }) => {
    const markup = render(approval({ answered, why, history, rehearsal, held: "Auto mode stopped to ask." }));
    expect(markup).toMatch(evidenceSection);
    expect(markup).toContain(history.summary);
    expect(markup).toContain(rehearsal.summary);
    expect(markup).toContain("Previous run · done");
    for (const detail of [why.intent, ...why.decisions, why.hypothesis!, why.findings!]) expect(markup).toContain(detail);
    expect(markup).toMatch(/<pre[^>]*>echo fixture-command<\/pre>/);
    expect(markup).toContain("Wants to run a command");
    expect(markup).toContain("Auto mode stopped to ask.");
    expect(markup).toContain(status);
    // Decisions remain in the composer; the transcript must not introduce a
    // second set of actionable buttons when its evidence becomes visible.
    expect(markup).not.toContain("<button");
    for (const other of ["Waiting for your answer below", "Allowed", "Denied"].filter((value) => value !== status)) {
      expect(markup).not.toContain(other);
    }
  });

  it.each([
    { label: "history", card: { history }, expected: history.summary! },
    { label: "previous-run why", card: { why }, expected: why.intent },
    { label: "rehearsal", card: { rehearsal }, expected: rehearsal.summary },
  ])("shows the evidence section when only $label is available", ({ card, expected }) => {
    const markup = render(approval(card));
    expect(markup).toMatch(evidenceSection);
    expect(markup).toContain(expected);
  });

  it("does not create an empty evidence section when evidence is absent", () => {
    const markup = render(approval());
    expect(markup).not.toMatch(evidenceSection);
    expect(markup).toContain("Waiting for your answer below");
    expect(markup).toMatch(/<pre[^>]*>echo fixture-command<\/pre>/);
  });

  it("does not claim tool history when there are zero recorded decisions", () => {
    const markup = render(approval({ history: { ...history, total: 0, approved: 0, denied: 0, lastDecision: null, summary: "No prior decisions." } }));
    expect(markup).not.toMatch(evidenceSection);
    expect(markup).not.toContain("No prior decisions.");
  });

  it("does not display a current-turn explanation as previous-run evidence", () => {
    const unexpectedSource: string = "current-turn";
    // SAFETY: deliberately malformed wire input exercises the runtime source
    // guard; the supported ApprovalWhy contract permits previous-run only.
    const currentWhy = { ...why, source: unexpectedSource } as ApprovalWhy;
    const markup = render(approval({ why: currentWhy }));
    expect(markup).not.toMatch(evidenceSection);
    expect(markup).not.toContain(why.intent);
    expect(markup).not.toContain("Previous run");
  });

  it("preserves long evidence as escaped literal text without interpreting its markup", () => {
    const longToken = "long-evidence-".repeat(100);
    const markup = render(approval({
      history: { ...history, summary: '<img src="bad" onerror="alert(1)">' },
      why: {
        ...why,
        intent: "<script>alert(2)</script>",
        decisions: ['<a href="javascript:alert(3)">click</a>'],
        hypothesis: "<iframe src=bad></iframe>",
        findings: "<style>body{display:none}</style>",
      },
      rehearsal: { ...rehearsal, summary: `${longToken}<svg onload=alert(4)> & evidence` },
    }));
    expect(markup).toMatch(evidenceSection);
    expect(markup).toContain("&lt;img src=&quot;bad&quot; onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(markup).toContain("&lt;a href=&quot;javascript:alert(3)&quot;&gt;click&lt;/a&gt;");
    expect(markup).toContain("&lt;iframe src=bad&gt;&lt;/iframe&gt;");
    expect(markup).toContain("&lt;style&gt;body{display:none}&lt;/style&gt;");
    expect(markup).toContain(`${longToken}&lt;svg onload=alert(4)&gt; &amp; evidence`);
    for (const tag of ["<img", "<script", "<a ", "<iframe", "<style", "<svg onload"]) expect(markup).not.toContain(tag);
  });

  it("renders nothing for a message without a card", () => {
    expect(render({ id: "text-message", at: 0, role: "bot", kind: "text", text: "A normal reply" })).toBe("");
  });

  it("shows grounded controls as evidence without ever adding a button", () => {
    const markup = render(approval({
      suggestions: [
        { id: "b1", label: "Save", source: "browser", actionKind: "click" },
        { id: "b3", label: "<Save drafts>", source: "browser", actionKind: "click" },
      ],
    }));
    expect(markup).toContain("Grounded controls");
    expect(markup).toContain("Save (browser · click)");
    expect(markup).toContain("&lt;Save drafts&gt;");
    expect(markup).toContain("must not fall back to a nearby label");
    // the transcript stays a record: the choice list is the composer's
    expect(markup).not.toContain("<button");
  });

  it("omits the grounded block entirely when there is nothing grounded", () => {
    const markup = render(approval());
    expect(markup).not.toContain("Grounded controls");
  });
});
