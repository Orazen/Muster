// One place that knows how a mounted MCP tool name is spelled.
//
// A driver mounts a user-registered MCP server as `mcp__<name>` and its
// tools arrive as `mcp__<name>__<tool>` (server/drivers/claude.ts, the
// `allowed.push(\`mcp__${s.name}\`)` arm). The server segment is NOT
// underscore-free: server/custom-mcp.ts validates the name against
// /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/ and its error text says so —
// "letters, digits, dash, underscore". So the mount prefix can only be cut
// from the LAST `__`, never pattern-matched from the first.
//
// This matters because the failure is silent. A reader that expects
// `mcp__[^_]+__` leaves `mcp__my_server__click` un-stripped, and every
// caller asking "is this a screen action?" / "is this a command tool?"
// quietly answers "no" for the whole family of servers a user named with
// an underscore — the screen-action budget then stops applying. Both
// server/auto-approve.ts (approvalKey) and server/desktop-guardrails.ts
// (isDesktopActionTool) read tool names, so they read them through here.
//
// Pure module: no I/O and no imports — the leaf both of them can take
// without an import cycle (auto-approve.ts imports nothing today, and
// desktop-guardrails.ts's only import is a type-only one).

/** The prefix every mounted MCP server gets (`mcp__<name>`). */
const MOUNT_PREFIX = "mcp__";
/** What separates the server segment from the tool segment. */
const SEGMENT_SEPARATOR = "__";

/** Cut the `mcp__<server>__` mount prefix off a tool name, leaving the tool
 * segment — the same answer for a bare `click` and for `mcp__cua__click`.
 *
 * Splits on the LAST separator so an underscore (or dash, or digit) inside
 * a user-chosen server name survives intact: `mcp__my_server__click` and
 * `mcp__a__b__click` both reduce to the tool alone. Case is preserved —
 * folding is a per-caller decision, and the only thing this answers is
 * "where does the mount prefix end".
 *
 * A name that is not a mounted name comes back untouched: no prefix at all,
 * a bare `mcp__` with nothing after it, or a prefix with no tool segment
 * behind it. The helper never throws and never invents a tool name, so a
 * malformed name degrades to "not a screen action / not a command tool"
 * rather than to garbage. */
export function stripMcpToolPrefix(tool: string): string {
  if (!tool.startsWith(MOUNT_PREFIX)) return tool;
  const cut = tool.lastIndexOf(SEGMENT_SEPARATOR);
  // a mounted name needs a server segment AND a tool segment; anything
  // shorter is not a mounted name and is left exactly as it arrived
  if (cut < MOUNT_PREFIX.length) return tool;
  return tool.slice(cut + SEGMENT_SEPARATOR.length);
}
