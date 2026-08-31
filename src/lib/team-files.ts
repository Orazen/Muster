import { api } from "@/state/store";

interface ExportedTeam {
  team: {
    name: string;
    members: unknown[];
  };
}

/** What a completed team export reports back to the caller. */
interface TeamExportSummary {
  name: string;
  members: number;
}

function downloadManifest(manifest: ExportedTeam): TeamExportSummary {
  const slug =
    manifest.team.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "muster-team";
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.musterteam.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // There is no browser event for "download has consumed this URL". Keep it
  // alive long enough for slower engines to start reading, then clean it up.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: manifest.team.name, members: manifest.team.members.length };
}

/** Export every active sidebar bot in one click. The server excludes hidden bots. */
export async function downloadAllBots(): Promise<TeamExportSummary> {
  // SAFETY: /api/teams/export returns this server's team manifest shape;
  // only team.name and team.members.length are read below.
  const manifest = (await api("/api/teams/export", {
    method: "POST",
    body: "{}",
  })) as ExportedTeam;
  return downloadManifest(manifest);
}
