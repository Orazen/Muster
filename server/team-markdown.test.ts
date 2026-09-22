// Round-trip and rejection tests for the portable Markdown team format: the
// renderer's output must parse back to the identical manifest, and malformed
// documents must fail with the same error discipline as JSON team files.
import { describe, expect, it } from "vitest";

import type { AgentColor } from "./store.ts";
import { parseTeamMarkdown, renderTeamMarkdown, TEAM_MARKDOWN_SUFFIX } from "./team-markdown.ts";
import { createTeamManifest } from "./team-manifest.ts";

// The fixture type mirrors ExportableBot's fields so the objects pass
// straight into createTeamManifest with no assertion chains.
interface FixtureBot {
  id: string;
  name: string;
  title: string;
  description: string;
  color: AgentColor;
  mascotExpression?: string | null;
}

const bots: FixtureBot[] = [
  {
    id: "bot-1",
    name: "Scout",
    title: "Researcher",
    description: "Finds sources and summarizes them.",
    color: "cyan",
    mascotExpression: "curious",
  },
  {
    id: "bot-2",
    name: "Quill",
    title: "Writer",
    description: "Drafts the deliverable.",
    color: "green",
  },
];

const manifest = createTeamManifest({ name: "Research Desk", memberIds: ["bot-1", "bot-2"] }, bots);

describe("renderTeamMarkdown", () => {
  it("emits frontmatter plus a human playbook", () => {
    const md = renderTeamMarkdown(manifest);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("format: muster.team");
    expect(md).toContain("version: 2");
    expect(md).toContain("team:");
    expect(md).toContain("  name: Research Desk");
    expect(md).toContain("    - name: Scout");
    expect(md).toContain("      title: Researcher");
    expect(md).toContain("## Members");
    expect(md).toContain("### Scout — Researcher");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("quotes YAML-unsafe names instead of emitting broken frontmatter", () => {
    const tricky = createTeamManifest({ name: 'Team: #1 "quoted"', memberIds: ["bot-1"] }, [bots[0]!]);
    const md = renderTeamMarkdown(tricky);
    expect(md).toContain('name: "Team: #1 \\"quoted\\""');
    expect(parseTeamMarkdown(md)).toEqual(tricky);
  });
});

describe("parseTeamMarkdown", () => {
  it("round-trips a rendered file to the identical manifest", () => {
    expect(parseTeamMarkdown(renderTeamMarkdown(manifest))).toEqual(manifest);
  });

  it("parses an edited playbook body without losing the install data", () => {
    const md = renderTeamMarkdown(manifest).replace(
      "## Members",
      "## How we work\n\nScout gathers, Quill drafts, the user ships.\n\n## Members",
    );
    expect(parseTeamMarkdown(md)).toEqual(manifest);
  });

  it("fills derived keys and the default color for hand-written members", () => {
    // Dropping the color line installs green — the roster default — proving
    // the parser applies the dialect defaults, not just the exported shape.
    const stripped = renderTeamMarkdown(manifest).replace(/^      color: cyan\n/m, "");
    expect(parseTeamMarkdown(stripped).team.members[0]?.appearance.color).toBe("green");
    const handWritten = parseTeamMarkdown(
      ["---", "format: muster.team", "version: 2", "team:", "  name: Solo", "  members:", "    - name: Ada Lovelace", "---", "", "# Solo", ""].join("\n"),
    );
    expect(handWritten.team.members[0]).toMatchObject({ key: "ada-lovelace", appearance: { color: "green" } });
  });

  it("rejects a Markdown file with no frontmatter", () => {
    expect(() => parseTeamMarkdown("# Just a playbook\n\nNo frontmatter here.")).toThrow(/frontmatter/);
  });

  it("rejects broken YAML with the file-format error", () => {
    expect(() => parseTeamMarkdown("---\nformat: [unclosed\n---\n\nbody\n")).toThrow(/YAML/);
  });

  it("rejects a non-team YAML document through the shared schema", () => {
    expect(() => parseTeamMarkdown("---\nformat: muster.team\nversion: 2\nname: \"\"\nmembers: []\n---\n\nbody\n")).toThrow();
    expect(() => parseTeamMarkdown("---\nformat: someone.else\nversion: 2\n---\n")).toThrow(/not an Muster team file/);
  });

  it("carries the documented file suffix", () => {
    expect(TEAM_MARKDOWN_SUFFIX).toBe(".musterteam.md");
  });
});
