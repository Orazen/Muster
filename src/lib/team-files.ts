import { api } from "@/state/store";

/** What a completed team export reports back to the caller. */
interface TeamExportSummary {
  name: string;
  members: number;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "muster-team"
  );
}

function downloadBlob(content: string, type: string, filename: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // There is no browser event for "download has consumed this URL". Keep it
  // alive long enough for slower engines to start reading, then clean it up.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadMarkdown(name: string, markdown: string): TeamExportSummary {
  downloadBlob(`${markdown}\n`, "text/markdown", `${slugify(name)}.musterteam.md`);
  // Members are the `    - name:` entries in the frontmatter list.
  return { name, members: (markdown.match(/^    - name:/gm) ?? []).length };
}

/** Export every active sidebar bot in one click as the portable Markdown
 * playbook (.musterteam.md, OpenMausBot parity): readable and editable by
 * people, and installs exactly like the JSON form. */
export async function downloadAllBots(): Promise<TeamExportSummary> {
  // SAFETY: /api/teams/export (default format) returns this server's Markdown
  // envelope: { markdown, name }, both strings, produced by renderTeamMarkdown.
  const exported = (await api("/api/teams/export", {
    method: "POST",
    body: "{}",
  })) as { markdown: string; name: string };
  return downloadMarkdown(exported.name, exported.markdown);
}
