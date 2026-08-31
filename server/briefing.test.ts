import { describe, expect, it } from "vitest";
import { buildBriefing } from "./briefing.js";

describe("buildBriefing", () => {
  it("empty roster points at the team library", () => {
    const text = buildBriefing({ bots: [], today: "2026-08-26" });
    expect(text).toContain("Daily brief — 2026-08-26");
    expect(text).toContain("Team Library");
  });

  it("surfaces unread and working bots", () => {
    const text = buildBriefing({
      bots: [
        { name: "Scout", activity: "idle", unread: true },
        { name: "Forge", activity: "working", unread: false },
        { name: "Quill", activity: "idle", unread: false },
      ],
      today: "2026-08-26",
    });
    expect(text).toContain("Needs your read: Scout");
    expect(text).toContain("Still working: Forge");
    expect(text).not.toContain("All quiet");
  });

  it("all-quiet line when nothing waits", () => {
    const text = buildBriefing({
      bots: [{ name: "Quill", activity: "idle", unread: false }],
      today: "2026-08-26",
    });
    expect(text).toContain("All quiet: Quill idle");
  });

  it("flags a stale backup at 7+ days", () => {
    const stale = buildBriefing({
      bots: [],
      vault: { fileCount: 12, lastSnapshot: "2026-08-10", daysStale: 16 },
      today: "2026-08-26",
    });
    expect(stale).toContain("Backup is 16 days old");
    expect(stale).toContain("Sync Drive");

    const fresh = buildBriefing({
      bots: [],
      vault: { fileCount: 12, lastSnapshot: "2026-08-25", daysStale: 1 },
      today: "2026-08-26",
    });
    expect(fresh).toContain("Vault current: 12 file(s)");
  });

  it("calls out an empty vault", () => {
    expect(buildBriefing({ bots: [], vault: { fileCount: 0, lastSnapshot: null, daysStale: null } })).toContain(
      "Vault is empty",
    );
  });
});
