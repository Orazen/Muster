// Muster Shield — a security-posture scan over the bot roster (the ECC
// AgentShield idea, sized for Muster): pure function, no I/O, so routes
// and tests feed it whatever snapshot they hold.
//
// Findings are advisory, never blocking — the operator owns the trade-off
// between an agent's autonomy and its blast radius. Severity reflects how
// much unsupervised damage a setting enables, ordered:
//   high   — the bot can act without asking AND carries a blanket permit
//            for destructive shell patterns
//   medium — the bot acts without asking, or can spend without a cap
//   low    — comfort features with a privacy/cost tail
import { z } from "zod";

export const securityFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  botId: z.string(),
  botName: z.string(),
  title: z.string(),
  detail: z.string(),
});
export type SecurityFinding = z.infer<typeof securityFindingSchema>;

export interface ScanBotInput {
  id: string;
  name: string;
  autoApprove?: boolean;
  alwaysAllow?: string[];
  tokenBudget?: number | null;
  privacyShield?: boolean;
  hidden?: boolean;
  /** runs on a cloud computer or local VM — shell reach beyond chat */
  hasComputer?: boolean;
  /** prompts reach a cloud model (local models see nothing to shield) */
  usesCloudModel?: boolean;
}

/** Destructive shell patterns that make an "always allow" entry dangerous
 * rather than convenient. Intentionally short: the point is the blanket
 * permits, not pattern-matching every Unix foot-gun. */
const DESTRUCTIVE_PATTERNS: Array<RegExp> = [
  /\brm\s+(-[a-z]*\s+)*-?[rf]/i, // rm -r / -f / -rf and friends
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

const isDestructive = (entry: string): boolean =>
  DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(entry));

export function scanBotSecurity(bots: readonly ScanBotInput[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  let seq = 0;
  const add = (finding: Omit<SecurityFinding, "id">) => {
    seq += 1;
    findings.push({ id: `f${seq}`, ...finding });
  };

  for (const bot of bots) {
    if (bot.hidden) continue; // an archived bot's posture is nobody's alarm

    const alwaysAllow = bot.alwaysAllow ?? [];
    const destructive = alwaysAllow.filter(isDestructive);

    // One finding per bot per concern tier: a HIGH auto-approve finding
    // already tells the operator this bot is hot — piling budget/shield
    // advisories on top reads as noise, not signal.
    let covered = false;

    if (bot.autoApprove && destructive.length > 0) {
      add({
        severity: "high",
        botId: bot.id,
        botName: bot.name,
        title: "Auto-approves destructive commands",
        detail:
          `Auto mode is on AND ${destructive.length} always-allow entr${destructive.length === 1 ? "y" : "ies"} match destructive ` +
          `shell patterns (${destructive.slice(0, 3).map((e) => `"${e}"`).join(", ")}). This bot executes them without asking.` +
          ` Remove them from always-allow or turn auto mode off.`,
      });
      covered = true;
    } else if (bot.autoApprove && bot.hasComputer) {
      add({
        severity: "medium",
        botId: bot.id,
        botName: bot.name,
        title: "Auto-approves everything on a computer",
        detail:
          "Auto mode approves every shell command and file edit without asking, and this bot drives a real computer. " +
          "Fine while you watch it; reconsider for unattended routines.",
      });
      covered = true;
    }

    if (!covered && !bot.tokenBudget) {
      add({
        severity: "medium",
        botId: bot.id,
        botName: bot.name,
        title: "No token budget",
        detail:
          "This bot can spend without a cap. Set a token budget in its settings — past the cap it stops and asks, " +
          "so a runaway loop cannot drain the account.",
      });
    }

    if (bot.usesCloudModel && bot.privacyShield === false) {
      add({
        severity: "low",
        botId: bot.id,
        botName: bot.name,
        title: "Privacy Shield off",
        detail:
          "Emails, phone numbers and secrets in this bot's prompts reach the cloud model unmasked. " +
          "Turn the Shield on if that transcript ever carries anything personal.",
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
