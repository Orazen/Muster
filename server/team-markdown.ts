// Portable Markdown team files — the OpenMausBot-parity format. A team is one
// ordinary Markdown document with a YAML frontmatter block: people can read
// and edit the playbook in any editor, GitHub renders it, and Muster installs
// the exact same file. This module is the single place that speaks the format
// on the server: renderTeamMarkdown (export) and parseTeamMarkdown (import),
// both delegating to server/team-manifest.ts for the schema contract so a
// Markdown file and its JSON twin are interchangeable by construction.
import { parse as parseYaml } from "yaml";
import { memberKey, parseTeamManifest, type ParsedTeamManifest, type TeamManifestV2 } from "./team-manifest.ts";

export const TEAM_MARKDOWN_SUFFIX = ".musterteam.md";

/** Quote a YAML scalar. Whitelist approach: plain style only for values a
 * YAML parser provably reads back as the same string; everything else gets
 * JSON's double-quoted style (a strict subset of YAML double-quoted). */
function yamlScalar(value: string): string {
  const plain = /^[A-Za-z0-9_.\\/'() -]+$/.test(value) && value === value.trim() && !/^[\s-]|\s$/.test(value);
  const ambiguous = /^(true|false|yes|no|on|off|null|~)$/i.test(value) || /^-?\d+(\.\d+)?$/.test(value);
  return plain && !ambiguous ? value : JSON.stringify(value);
}

/** Render a v2 manifest as a portable Markdown playbook. The frontmatter
 * carries the structured install data; the body is a plain-language playbook
 * that survives without Muster (and round-trips: the body is regenerated on
 * export and never parsed on import). */
export function renderTeamMarkdown(manifest: TeamManifestV2): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("format: muster.team");
  lines.push("version: 2");
  lines.push("team:");
  lines.push(`  name: ${yamlScalar(manifest.team.name)}`);
  if (manifest.team.description) lines.push(`  description: ${yamlScalar(manifest.team.description)}`);
  lines.push("  members:");
  for (const member of manifest.team.members) {
    lines.push(`    - name: ${yamlScalar(member.name)}`);
    if (member.title) lines.push(`      title: ${yamlScalar(member.title)}`);
    if (member.description) lines.push(`      description: ${yamlScalar(member.description)}`);
    // Green is the default, so it is the one color omitted from the file.
    if (member.appearance.color !== "green") {
      lines.push(`      color: ${yamlScalar(member.appearance.color)}`);
    }
    if (member.appearance.mascotExpression) {
      lines.push(`      mascot: ${yamlScalar(member.appearance.mascotExpression)}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${manifest.team.name}`);
  lines.push("");
  if (manifest.team.description) {
    lines.push(manifest.team.description);
    lines.push("");
  }
  lines.push("## Members");
  lines.push("");
  for (const member of manifest.team.members) {
    lines.push(`### ${member.name}${member.title ? ` — ${member.title}` : ""}`);
    lines.push("");
    if (member.description) {
      lines.push(member.description);
      lines.push("");
    }
    lines.push(`Appearance: ${member.appearance.color}${member.appearance.mascotExpression ? ` · mascot: ${member.appearance.mascotExpression}` : ""}.`);
    lines.push("");
  }
  lines.push("---");
  lines.push("This file installs a Muster team. Connections stay off, nothing runs until you approve it, and the Markdown body is the human-readable playbook.");
  lines.push("");
  return lines.join("\n");
}

/** Parse a portable Markdown team file into the exact JSON manifest the
 * import route already trusts. Only the frontmatter is read; the playbook
 * body is for people. Errors name the problem like any other team file. */
export function parseTeamMarkdown(raw: string): ParsedTeamManifest {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("This Markdown file has no YAML frontmatter block — start the file with ---");
  const [, frontmatter] = match;
  let value: unknown;
  try {
    value = parseYaml(frontmatter);
  } catch {
    throw new Error("This team file's frontmatter is not valid YAML.");
  }
  // SAFETY: the YAML document just decoded; this narrowing only routes
  // empty/scalar frontmatter to its error before the schema sees anything.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- YAML boundary: this check IS the parser routing scalars to the error
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("This team file's frontmatter is empty.");
  }
  // SAFETY: the value passed the mapping check immediately above.
  applyMarkdownDialectDefaults(value as { team?: { members?: unknown } });
  // The schema is the shared team manifest schema: format literal, version
  // literal, member bounds, appearance enum — all of it applies unchanged.
  // SAFETY: defaults applied; the schema is the real boundary from here.
  return parseTeamManifest(value as TeamManifestV2);
}

/** Humans write names and colors, not schema plumbing. Two normalizations:
 * a member without a `key` gets the same derived key export uses, and the
 * dialect's flat color/mascot keys are lifted into the appearance object
 * the shared schema expects (green when omitted). Runs before the shared
 * schema so hand-written playbooks validate like exported files. */
function applyMarkdownDialectDefaults(document: { team?: { members?: unknown } }): void {
  // SAFETY: the only input is YAML just decoded from the frontmatter; these
  // narrowings establish which records need defaults before the shared
  // schema renders its own verdicts on everything else.
  const members = document?.team?.members;
  if (!Array.isArray(members)) return;
  const used = new Set<string>();
  members.forEach((member, index) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- YAML boundary: distinguishing mapping entries from scalars
    if (!member || typeof member !== "object" || Array.isArray(member)) return;
    // SAFETY: the member passed the mapping check directly above; these
    // optional fields are the defaults this function exists to apply.
    const record = member as {
      key?: unknown;
      name?: unknown;
      color?: unknown;
      mascot?: unknown;
      appearance?: { color?: unknown; mascotExpression?: unknown } | undefined;
    };
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- YAML boundary: a hand-written key is a string or absent
    const written = typeof record.key === "string" ? record.key.trim() : "";
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- YAML boundary: the name feeds key derivation
    const name = typeof record.name === "string" ? record.name : "";
    const key = written || memberKey(name, index, used);
    record.key = key;
    used.add(key);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- YAML boundary: flat dialect keys arrive as strings or are absent
    if (typeof record.color === "string" && record.appearance?.color === undefined) record.appearance = { ...record.appearance, color: record.color };
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- YAML boundary: same, for the mascot expression
    if (typeof record.mascot === "string" && record.appearance?.mascotExpression === undefined) record.appearance = { ...record.appearance, mascotExpression: record.mascot };
    delete record.color;
    delete record.mascot;
    if (record.appearance?.color === undefined) record.appearance = { ...record.appearance, color: "green" };
  });
}
