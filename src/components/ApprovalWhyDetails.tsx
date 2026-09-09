import type { ApprovalWhy } from "@/state/store";

export function ApprovalWhyDetails({ why }: { why: ApprovalWhy }) {
  if (why.source !== "previous-run") return null;
  return (
    <details className="mt-2 text-[12px] text-ink-secondary">
      <summary className="cursor-pointer">Previous run · {why.outcome} · {new Date(why.at).toLocaleString()}</summary>
      <p className="mt-1">{why.intent}</p>
      {why.decisions.map((decision, index) => <p className="mt-1" key={index}>{decision}</p>)}
      {why.hypothesis && <p className="mt-1">Hypothesis: {why.hypothesis}</p>}
      {why.findings && <p className="mt-1">Findings: {why.findings}</p>}
    </details>
  );
}
