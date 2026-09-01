// Doctor repair executor (TinyFish's doctor pattern, execution half). The
// doctor report at GET /api/engines/doctor names an ordered repair per
// unhealthy engine but never mutates anything — repairs were human-only.
// This module classifies which of those repairs an unattended auto-repair
// may run (only re-registering instances from the vault: it refreshes PATH
// and model lists without installing or touching credentials) and runs
// them through injected hooks, so policy and execution are both testable.

export type RepairAction = "reload-instances" | "rescan-path";

/** Local mirror of the doctor report's engine row (GET /api/engines/doctor). */
export interface DoctorEngineReport {
  schemaVersion: 1;
  instanceId: string;
  engine: string;
  access: string;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  repair: string | null;
}

export interface DoctorReport {
  schemaVersion: number;
  engines: DoctorEngineReport[];
}

/** One classification outcome per unhealthy engine row. */
export interface RepairCandidate {
  action: RepairAction;
  /** true → unattended auto-repair may run it; false → human decision. */
  safe: boolean;
  /** What the repair would do, or why it needs a human. */
  requiresApproval: boolean;
  detail: string;
}

/** Classify the doctor report: which repairs may an unattended auto-repair
 * run? Policy: only "reload-instances" (re-register provider instances from
 * the vault, refreshing PATH and model lists) is auto-safe. Anything that
 * smells like an install or a credential fix stays a human decision. */
export function safeRepairs(report: DoctorReport): RepairCandidate[] {
  const out: RepairCandidate[] = [];
  for (const engine of report.engines ?? []) {
    if (engine.ok) continue;
    const failed = engine.checks.filter((c) => !c.ok);
    const modelsFailed = failed.some((c) => c.name === "models-loaded");
    const binaryFailed = failed.some((c) => c.name === "binary-reachable");
    const installish = /\b(install|credential|login|auth|api[- ]?key|token)\b/i.test(engine.repair ?? "");
    if (binaryFailed && installish) {
      // The binary is gone and the doctor is suggesting an install: that
      // downloads software or rebinds credentials — never unattended. The
      // best an auto-repair could offer is a PATH rescan, behind approval.
      out.push({
        action: "rescan-path",
        safe: false,
        requiresApproval: true,
        detail: engine.repair ?? `reinstall the ${engine.engine} CLI first`,
      });
      continue;
    }
    if (modelsFailed || binaryFailed) {
      // A PATH refresh + re-register can genuinely fix this: the CLI may
      // have landed on disk since the registry snapshotted its candidates.
      out.push({
        action: "reload-instances",
        safe: true,
        requiresApproval: false,
        detail: "re-register provider instances from the vault to refresh PATH and model lists",
      });
      continue;
    }
    // No fixable check failed (e.g. only bots-assigned): nothing to do.
  }
  return out;
}

/** Per-action execution outcome, as the repair route echoes to the client. */
export interface RepairOutcome {
  action: RepairAction;
  ok: boolean;
  detail: string;
}

export interface RepairHooks {
  /** Re-register provider instances from the vault (refreshes PATH + models). */
  reloadInstances: () => Promise<void>;
}

/** Run only the safe actions from `candidates` via the injected hooks.
 * Pure-ish: no I/O of its own; a hook failure becomes that action's
 * unsuccessful outcome instead of throwing. */
export async function runRepairs(candidates: RepairCandidate[], hooks: RepairHooks): Promise<RepairOutcome[]> {
  const outcomes: RepairOutcome[] = [];
  const safe = candidates.filter((c) => c.safe && !c.requiresApproval);
  if (safe.some((c) => c.action === "reload-instances")) {
    try {
      await hooks.reloadInstances();
      outcomes.push({ action: "reload-instances", ok: true, detail: "provider instances re-registered from the vault" });
    } catch (e) {
      outcomes.push({
        action: "reload-instances",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return outcomes;
}
