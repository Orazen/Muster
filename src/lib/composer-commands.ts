/**
 * Composer /commands (U4) — type `/` to reach the composer's own actions
 * from the keyboard, the way the @ picker reaches bots.
 *
 * Parsing mirrors `mentionQueryAt` in Composer.tsx on purpose: a slash
 * only opens the menu when it STARTS a word (so `https://…`, `a/b` and
 * `rate/limit` stay literal text), the query is what sits between that
 * slash and the caret, and over-long or newline-broken queries refuse.
 *
 * The command list is deliberately the composer's EXISTING actions —
 * voice mode, goal mode, new task, stop, settings — each with the same
 * availability rule its button uses; nothing here invents a new behavior,
 * it only gives the old ones a typed door.
 */

/** The closed set of command ids — a new command must join this union,
 *  the table below, and the composer's availability map (checked by
 *  `satisfies Record<ComposerCommandId, boolean>`), so they cannot drift. */
export type ComposerCommandId = "voice" | "goal" | "new" | "stop" | "settings";

export interface ComposerCommand {
  /** Typed without the leading slash. */
  id: ComposerCommandId;
  label: string;
  hint: string;
}

export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  { id: "voice", label: "Voice mode", hint: "Talk out loud — opens the call room" },
  { id: "goal", label: "Goal mode", hint: "The next send becomes a self-driving loop" },
  { id: "new", label: "New task", hint: "A fresh task context on this bot" },
  { id: "stop", label: "Stop this turn", hint: "Interrupt the running turn" },
  { id: "settings", label: "Bot settings", hint: "Open this bot's settings" },
];

/** The active /command query at the caret: the text between a `/` that
 *  starts a word and the caret. null = no command being typed. */
export function commandQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("/");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // URL / path / mid-word slash
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("/") || query.includes("\n")) return null;
  return { start: at, query };
}

/** Case-insensitive id/label prefix-ish match, capped like the mention
 *  picker's six rows. Trimmed so "/voice " still finds voice. */
export function matchCommands(query: string): ComposerCommand[] {
  const q = query.trim().toLowerCase();
  return COMPOSER_COMMANDS.filter(
    (command) => !q || command.id.includes(q) || command.label.toLowerCase().includes(q),
  ).slice(0, 6);
}
