// Daily briefing — Muster's proactivity layer, step one.
//
// A pure composer: given workspace state, produce the morning-brief text
// a chosen bot delivers. Deliberately has no I/O so the format is pinned
// by tests and every caller (API, scheduler, bot prompt) sees identical
// output. Vellum ships an hourly sweep; ours leads with what Sintra's
// reviews say users actually want: "what needs me today" in one message.

export interface BriefingBot {
  name: string;
  activity: string;
  unread: boolean;
}

export interface BriefingVault {
  fileCount: number;
  lastSnapshot: string | null;
  /** Days since the last snapshot; null when never backed up. */
  daysStale: number | null;
}

export interface BriefingInput {
  bots: Array<BriefingBot>;
  vault?: BriefingVault;
  /** ISO date for "today" — injectable so tests are deterministic. */
  today?: string;
}

const STALE_DAYS = 7;

export function buildBriefing(input: BriefingInput): string {
  const lines: Array<string> = [];
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  lines.push(`Daily brief — ${today}`);

  const working = input.bots.filter((b) => b.activity === "working");
  const unread = input.bots.filter((b) => b.unread);

  if (input.bots.length === 0) {
    lines.push("Roster is empty — install a team from Settings → Team Library to get started.");
  } else {
    if (unread.length > 0) {
      lines.push(`Needs your read: ${unread.map((b) => b.name).join(", ")}.`);
    }
    if (working.length > 0) {
      lines.push(`Still working: ${working.map((b) => b.name).join(", ")}.`);
    }
    const idle = input.bots.filter((b) => b.activity !== "working" && !b.unread);
    if (idle.length > 0 && unread.length === 0 && working.length === 0) {
      lines.push(`All quiet: ${idle.map((b) => b.name).join(", ")} idle, nothing waiting on you.`);
    }
  }

  if (input.vault) {
    if (input.vault.fileCount === 0) {
      lines.push("Vault is empty — nothing is backed up yet.");
    } else if (input.vault.daysStale !== null && input.vault.daysStale >= STALE_DAYS) {
      lines.push(
        `Backup is ${input.vault.daysStale} days old (${input.vault.lastSnapshot}) — run Sync Drive or Import Takeout.`,
      );
    } else {
      lines.push(`Vault current: ${input.vault.fileCount} file(s), last snapshot ${input.vault.lastSnapshot}.`);
    }
  }

  return lines.join("\n");
}
