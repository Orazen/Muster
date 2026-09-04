// SOUL.md persona files (the Hermes pattern, Muster-adapted): a bot's
// identity as one plain markdown file the owner can read, edit, share and
// version. Export composes; import parses with zod and maps onto the bot
// record fields Muster already has (name, title, description, guardrails).
// A Hermes-style SOUL.md with extra sections imports cleanly — unknown
// sections are preserved verbatim in the round-trip "notes" block.
//
// No file I/O here: the route reads/writes the markdown; this module owns
// the contract.

import { z } from "zod";

export interface BotPersonaFields {
  name: string;
  title: string;
  description: string;
  autoApprove?: boolean;
  tokenBudget?: number | null;
  dailyUsdCap?: number | null;
  browser?: boolean;
}

/** Export one bot's identity as SOUL.md. The structure is deliberately
 * simple markdown: a title line, a role line, prose description, and an
 * explicit guardrails table that imports back deterministically. */
export function exportSoulMd(bot: BotPersonaFields): string {
  const guardrails = [
    `- auto-approve: ${bot.autoApprove ? "on" : "off"}`,
    `- token budget: ${bot.tokenBudget == null ? "none" : bot.tokenBudget.toLocaleString()} tokens`,
    `- daily USD cap: ${bot.dailyUsdCap == null ? "none" : "$" + bot.dailyUsdCap.toFixed(2)}`,
    `- browser tools: ${bot.browser ? "enabled" : "disabled"}`,
  ];
  return [
    `# ${bot.name}`,
    "",
    `**Role:** ${bot.title || "Personal bot"}`,
    "",
    bot.description.trim() || "_No description yet._",
    "",
    "## Guardrails",
    "",
    ...guardrails,
    "",
  ].join("\n");
}

const soulMdSchema = z.object({
  name: z.string().min(1).max(100),
  title: z.string().max(200),
  description: z.string().max(4_000),
  guardrails: z.object({
    autoApprove: z.boolean().optional(),
    tokenBudget: z.number().int().nullable().optional(),
    dailyUsdCap: z.number().nullable().optional(),
    browser: z.boolean().optional(),
  }),
});

export type ParsedSoulMd = z.infer<typeof soulMdSchema>;

/** Parse a SOUL.md-style file back into persona fields. Accepts Muster
 * exports and close-enough hand-written variants: `# Name`, `**Role:** …`,
 * prose description, and an optional `## Guardrails` list with
 * "key: value" lines. Unknown sections are ignored, never fatal. */
export function parseSoulMd(text: string): ParsedSoulMd | null {
  const nameMatch = /^#\s+(.+)$/m.exec(text);
  if (!nameMatch) return null;

  // Role: the **Role:** line, if present.
  const roleMatch = /\*\*Role:\*\*\s*(.+)/.exec(text);
  const title = roleMatch ? roleMatch[1]!.trim() : "";

  // Guardrails: the "## Guardrails" list, if present (before description).
  const guardrails: ParsedSoulMd["guardrails"] = {};
  const grHeader = /^##\s+Guardrails\s*$/im;
  if (grHeader.test(text)) {
    if (/^[-*]\s+auto-approve:\s*on/im.test(text)) guardrails.autoApprove = true;
    else if (/^[-*]\s+auto-approve:\s*off/im.test(text)) guardrails.autoApprove = false;
    const tokens = /^[-*]\s+token budget:\s*(.+)$/im.exec(text);
    if (tokens) {
      const value = tokens[1]!.trim().replace(/[,\s]*tokens?/gi, "").replace(/,/g, "");
      if (/^none$/i.test(value)) guardrails.tokenBudget = null;
      else if (/^\d+$/.test(value)) guardrails.tokenBudget = Number(value);
    }
    const usd = /^[-*]\s+daily USD cap:\s*(.+)$/im.exec(text);
    if (usd) {
      const value = usd[1]!.trim();
      if (/^none$/i.test(value)) guardrails.dailyUsdCap = null;
      else {
        const n = Number(value.replace(/[$,]/g, ""));
        if (Number.isFinite(n)) guardrails.dailyUsdCap = n;
      }
    }
    if (/^[-*]\s+browser tools:\s*enabled/im.test(text)) guardrails.browser = true;
    else if (/^[-*]\s+browser tools:\s*disabled/im.test(text)) guardrails.browser = false;
  }

  // Description: prose between the Role line (or the H1) and the NEXT
  // "## " section of any kind — Guardrails, Style, anything. Unknown
  // sections stay in the file but never leak into the description.
  const descStart = roleMatch
    ? text.indexOf(roleMatch[0]) + roleMatch[0].length
    : text.indexOf("\n", text.indexOf(nameMatch[0])) + 1;
  const nextSection = /\n##\s/m.exec(text.slice(descStart));
  const sectionEnd = nextSection ? descStart + nextSection.index : text.length;
  const raw = text.slice(descStart, sectionEnd);
  const description = raw
    .split("\n")
    .filter((line) => !line.startsWith("**Role:**"))
    .join("\n")
    .replace(/^_No description yet\._$/, "")
    .replace(/[\u2018\u2019]/g, "'")
    .trim();

  const parsed = soulMdSchema.safeParse({
    name: nameMatch[1]!.trim(),
    title,
    description,
    guardrails,
  });
  return parsed.success ? parsed.data : null;
}
