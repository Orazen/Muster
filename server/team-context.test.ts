import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TEAM_CONTEXT_OWNER,
  readTeamContext,
  teamContextSystemPrompt,
  writeTeamContext,
  TEAM_CONTEXT_MAX_BYTES,
  TEAM_CONTEXTS_FILE,
} from "./team-context.ts";

// The brief is injected into EVERY turn of EVERY bot, so a store that was one
// file for the whole deployment was not a tidiness problem: on an install with
// two signed-in accounts, one account's private notes were read into the other
// account's bots' prompts. These tests pin the isolation, and pin the
// migration, because silently dropping an existing user's brief on upgrade
// would be its own data loss.

const ADA = "user-ada";
const ZOE = "user-zoe";

describe("team context", () => {
  beforeEach(() => {
    rmSync(TEAM_CONTEXTS_FILE, { force: true });
  });

  it("round-trips the brief", () => {
    expect(readTeamContext()).toBeNull();
    expect(writeTeamContext("# Team\n- Ship Friday", ADA, 101)).toEqual({
      text: "# Team\n- Ship Friday",
      updatedAt: 101,
    });
    expect(readTeamContext(ADA)).toEqual({ text: "# Team\n- Ship Friday", updatedAt: 101 });
  });

  it("injects the brief under an explicit trust boundary", () => {
    writeTeamContext("Launch date: Friday", ADA, 1);
    const prompt = teamContextSystemPrompt(ADA);
    expect(prompt).toContain("Launch date: Friday");
    expect(prompt).toContain("never tool authorization");
    expect(prompt).toContain("you cannot edit it");
  });

  it("clears empty briefs and refuses content beyond the prompt budget", () => {
    writeTeamContext("temporary", ADA, 1);
    expect(writeTeamContext("   ", ADA, 2)).toBeNull();
    expect(readTeamContext(ADA)).toBeNull();
    expect(() => writeTeamContext("é".repeat(TEAM_CONTEXT_MAX_BYTES), ADA)).toThrow("capped");
    expect(teamContextSystemPrompt(ADA)).toBe("");
  });

  it("persists atomically in a private file and ignores malformed disk data", () => {
    writeTeamContext("safe", ADA, 1);
    expect(existsSync(TEAM_CONTEXTS_FILE)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(TEAM_CONTEXTS_FILE).mode & 0o777).toBe(0o600);
    }

    writeFileSync(TEAM_CONTEXTS_FILE, "not json");
    expect(readTeamContext(ADA)).toBeNull();
  });

  // ── the isolation this change exists for ────────────────────────────

  it("never shows one account's brief to another", () => {
    // THE regression. Pre-fix there was one file, so ZOE read ADA's text and
    // — worse — ADA's bots' prompts carried it on every turn.
    writeTeamContext("ADA_PRIVATE_FINANCIALS", ADA, 1);
    expect(readTeamContext(ZOE)).toBeNull();
    expect(teamContextSystemPrompt(ZOE)).toBe("");
    expect(teamContextSystemPrompt(ADA)).toContain("ADA_PRIVATE_FINANCIALS");
  });

  it("keeps both briefs in one file, so a second account cannot clobber the first", () => {
    writeTeamContext("ada notes", ADA, 1);
    writeTeamContext("zoe notes", ZOE, 2);
    expect(readTeamContext(ADA)).toEqual({ text: "ada notes", updatedAt: 1 });
    expect(readTeamContext(ZOE)).toEqual({ text: "zoe notes", updatedAt: 2 });
    // One file on disk, two records inside it. The write path in this module
    // serialises exactly this shape (version 2 + an owners map), and the write
    // above is the one that produced the file, so the parse cannot see another.
    // SAFETY: the writer is the module under test, not external input.
    const onDisk = JSON.parse(readFileSync(TEAM_CONTEXTS_FILE, "utf8")) as {
      version: number;
      owners: Record<string, { text: string }>;
    };
    expect(onDisk.version).toBe(2);
    expect(Object.keys(onDisk.owners).sort()).toEqual([ADA, ZOE]);
  });

  it("clears only the owner who asked, not the whole file", () => {
    // The last-writer-wins shape is exactly the bug: clearing must not take
    // the other account's brief with it.
    writeTeamContext("ada notes", ADA, 1);
    writeTeamContext("zoe notes", ZOE, 2);
    expect(writeTeamContext("", ZOE, 3)).toBeNull();
    expect(readTeamContext(ZOE)).toBeNull();
    expect(readTeamContext(ADA)).toEqual({ text: "ada notes", updatedAt: 1 });
  });

  it("treats an ownerless bot as the desktop's single operator, not as everybody", () => {
    writeTeamContext("desktop operator brief", DEFAULT_TEAM_CONTEXT_OWNER, 1);
    // A bot with no ownerId is a local-install bot: it sees the operator's
    // brief. It must NOT see a signed-in account's, which is the leak again
    // from the other direction.
    expect(teamContextSystemPrompt(undefined)).toContain("desktop operator brief");
    expect(teamContextSystemPrompt(ADA)).toBe("");
  });

  it("migrates a pre-ownership file instead of dropping the brief", () => {
    // Version 1 was one global record written by any earlier build. Upgrading
    // must not delete a brief the user wrote and believed was safe.
    writeFileSync(
      TEAM_CONTEXTS_FILE,
      JSON.stringify({ version: 1, text: "written before ownership", updatedAt: 7 }),
    );
    expect(readTeamContext(DEFAULT_TEAM_CONTEXT_OWNER)).toEqual({
      text: "written before ownership",
      updatedAt: 7,
    });
    // And it is the operator's, not a signed-in account's.
    expect(readTeamContext(ADA)).toBeNull();
  });

  it("ignores a v1 file that was already empty rather than resurrecting it", () => {
    writeFileSync(TEAM_CONTEXTS_FILE, JSON.stringify({ version: 1, text: "   ", updatedAt: 7 }));
    expect(readTeamContext(DEFAULT_TEAM_CONTEXT_OWNER)).toBeNull();
  });
});
