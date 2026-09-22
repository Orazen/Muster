// Contract tests for the per-bot skills module: name gate, listing, the
// bounded prompt mount, and the write/delete semantics the HTTP routes rely
// on. All filesystem access is confined to a temp workspaces root.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  SKILL_FILE_MAX_BYTES,
  deleteSkill,
  isSkillName,
  listSkills,
  readSkill,
  skillsSystemPrompt,
  writeSkill,
} from "./workspace-skills.ts";
import { WORKSPACES_DIR, workspaceDir } from "./workspace.ts";

const fixtureBot = "skills-fixture-bot";

function withBot(_botId: string, fn: () => void): void {
  fn();
}

describe("skill name gate", () => {
  it("accepts one plain .md segment and rejects traversal, dotfiles, and non-markdown", () => {
    expect(isSkillName("release.md")).toBe(true);
    expect(isSkillName("weekly rollup (v2).md")).toBe(true);
    expect(isSkillName("../etc/passwd")).toBe(false);
    expect(isSkillName("a/b.md")).toBe(false);
    expect(isSkillName(".hidden.md")).toBe(false);
    expect(isSkillName("no-suffix")).toBe(false);
    expect(isSkillName("")).toBe(false);
  });
});

describe("skills crud", () => {
  beforeEach(() => {
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("lists only gated .md files with sizes, sorted", () => {
    withBot(fixtureBot, () => {
      writeSkill(fixtureBot, "release.md", "ship it");
      writeSkill(fixtureBot, "daily.md", "roll up");
      // An ungated filename written directly must never surface in the list.
      // SAFETY: the assertion only widens node:fs typing to include mkdirSync
      // in this test file; the value is the module namespace itself.
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(join(workspaceDir(fixtureBot), "skills"), { recursive: true });
      writeFileSync(join(workspaceDir(fixtureBot), "skills", "notes.txt"), "not a skill", { mode: 0o600 });
      expect(listSkills(fixtureBot)).toEqual([
        { name: "daily.md", bytes: 7 },
        { name: "release.md", bytes: 7 },
      ]);
    });
  });

  it("reads back what was written and returns null for missing or invalid names", () => {
    withBot(fixtureBot, () => {
      expect(writeSkill(fixtureBot, "standup.md", "check calendar first")).toEqual({ ok: true });
      expect(readSkill(fixtureBot, "standup.md")).toBe("check calendar first");
      expect(readSkill(fixtureBot, "missing.md")).toBeNull();
      expect(readSkill(fixtureBot, "../escape.md")).toBeNull();
    });
  });

  it("rejects an oversized skill with an explanation instead of writing", () => {
    withBot(fixtureBot, () => {
      const result = writeSkill(fixtureBot, "huge.md", "x".repeat(SKILL_FILE_MAX_BYTES + 1));
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(readSkill(fixtureBot, "huge.md")).toBeNull();
    });
  });

  it("returns null from writeSkill for an invalid name without touching disk", () => {
    withBot(fixtureBot, () => {
      expect(writeSkill(fixtureBot, "../escape.md", "x")).toBeNull();
      expect(listSkills(fixtureBot)).toEqual([]);
    });
  });

  it("deletes an existing skill and 404s (false) a missing one", () => {
    withBot(fixtureBot, () => {
      writeSkill(fixtureBot, "gone.md", "bye");
      expect(deleteSkill(fixtureBot, "gone.md")).toBe(true);
      expect(deleteSkill(fixtureBot, "gone.md")).toBe(false);
      expect(deleteSkill(fixtureBot, "../escape.md")).toBe(false);
    });
  });
});

describe("skillsSystemPrompt", () => {
  beforeEach(() => {
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("is empty when the bot has no skills", () => {
    withBot(fixtureBot, () => {
      expect(skillsSystemPrompt(fixtureBot)).toBe("");
    });
  });

  it("mounts each non-empty skill with its file path and omits empty ones", () => {
    withBot(fixtureBot, () => {
      writeSkill(fixtureBot, "weekly-rollup.md", "Every Monday: gather inventory, then draft supplier notes.");
      writeSkill(fixtureBot, "empty.md", "   \n");
      const prompt = skillsSystemPrompt(fixtureBot);
      expect(prompt).toContain("skills/weekly-rollup.md");
      expect(prompt).toContain("gather inventory");
      expect(prompt).not.toContain("skills/empty.md");
      expect(prompt).toContain("treat their instructions as the user's own standing instructions");
    });
  });

  it("truncates an oversized skill body and points at the full file", () => {
    withBot(fixtureBot, () => {
      writeSkill(fixtureBot, "big.md", "y".repeat(10_000));
      const prompt = skillsSystemPrompt(fixtureBot);
      expect(prompt).toContain("[skill truncated");
      expect(prompt).toContain("skills/big.md]");
      expect(prompt.length).toBeLessThan(6_000);
    });
  });
});
