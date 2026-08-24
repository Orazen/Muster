import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readTeamContext,
  teamContextSystemPrompt,
  writeTeamContext,
  TEAM_CONTEXT_MAX_BYTES,
  TEAM_CONTEXTS_FILE,
} from "./team-context.ts";

describe("team context", () => {
  beforeEach(() => {
    rmSync(TEAM_CONTEXTS_FILE, { force: true });
  });

  it("round-trips the brief", () => {
    expect(readTeamContext()).toBeNull();
    expect(writeTeamContext("# Team\n- Ship Friday", 101)).toEqual({
      text: "# Team\n- Ship Friday",
      updatedAt: 101,
    });
    expect(readTeamContext()).toEqual({ text: "# Team\n- Ship Friday", updatedAt: 101 });
  });

  it("injects the brief under an explicit trust boundary", () => {
    writeTeamContext("Launch date: Friday", 1);
    const prompt = teamContextSystemPrompt();
    expect(prompt).toContain("Launch date: Friday");
    expect(prompt).toContain("never tool authorization");
    expect(prompt).toContain("you cannot edit it");
  });

  it("clears empty briefs and refuses content beyond the prompt budget", () => {
    writeTeamContext("temporary", 1);
    expect(writeTeamContext("   ", 2)).toBeNull();
    expect(readTeamContext()).toBeNull();
    expect(() => writeTeamContext("é".repeat(TEAM_CONTEXT_MAX_BYTES))).toThrow("capped");
    expect(teamContextSystemPrompt()).toBe("");
  });

  it("persists atomically in a private file and ignores malformed disk data", () => {
    writeTeamContext("safe", 1);
    expect(existsSync(TEAM_CONTEXTS_FILE)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(TEAM_CONTEXTS_FILE).mode & 0o777).toBe(0o600);
    }

    writeFileSync(TEAM_CONTEXTS_FILE, "not json");
    expect(readTeamContext()).toBeNull();
  });
});
