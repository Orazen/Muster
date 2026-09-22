// Per-bot skills: reusable instruction playbooks that live in the bot's own
// workspace (<workspace>/skills/<name>.md) and ride into the system prompt —
// the file-based pattern MEMORY.md and memory/ topics already established.
// Plain markdown on purpose: the user can open, edit, or delete anything a
// skill says, and a skill never outranks the persona or safety prompts because
// it is appended, not substituted.
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { workspaceDir } from "./workspace.ts";

/** Skills are one .md segment in skills/, same character gate as memory
 * topics: word-character start, plain characters, .md suffix. No slashes
 * means no traversal by construction; no leading dot means no dotfiles. */
const SKILL_NAME = /^[\w][\w .()-]{0,79}\.md$/;

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

/** Cap on what one skill may hold — same "bounded paste endpoint" reasoning
 * as MEMORY_FILE_MAX_BYTES in workspace.ts. */
export const SKILL_FILE_MAX_BYTES = 128 * 1024;

/** A skill as the API returns it: name (filename), size, and whether it is
 * currently mounted into the prompt. */
export interface SkillEntry {
  name: string;
  bytes: number;
}

function skillsDir(botId: string): string {
  return join(workspaceDir(botId), "skills");
}

/** List the bot's skills, name + size only — contents are fetched one at a
 * time so listing stays cheap however large the playbooks grow. Absent
 * directory → empty list, never a throw: a bot that has not run yet has no
 * skills, which is not an error. */
export function listSkills(botId: string): SkillEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir(botId));
  } catch {
    return [];
  }
  return entries
    .filter(isSkillName)
    .flatMap((name) => {
      try {
        const stat = statSync(join(skillsDir(botId), name));
        return stat.isFile() ? [{ name, bytes: stat.size }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one skill. The name gate runs here too, not only in the HTTP route —
 * a future caller must not be able to turn this into a read of an arbitrary
 * path. Null for anything invalid or unreadable. */
export function readSkill(botId: string, name: string): string | null {
  if (!isSkillName(name)) return null;
  try {
    return readFileSync(join(skillsDir(botId), name), "utf8");
  } catch {
    return null;
  }
}

/** Create or replace one skill. Creates the skills/ directory on demand;
 * rejects oversized text with the same explanation-not-disk-fill contract as
 * the memory PUT. Returns null when the name is invalid. */
export function writeSkill(botId: string, name: string, text: string): { ok: true } | { ok: false; reason: string; status: number } | null {
  if (!isSkillName(name)) return null;
  if (Buffer.byteLength(text, "utf8") > SKILL_FILE_MAX_BYTES) {
    return { ok: false, reason: `a skill is capped at ${SKILL_FILE_MAX_BYTES / 1024}KB — split it into multiple skills`, status: 400 };
  }
  mkdirSync(skillsDir(botId), { recursive: true, mode: 0o700 });
  writeFileSync(join(skillsDir(botId), name), text, { mode: 0o600 });
  return { ok: true };
}

/** Delete one skill. Returns false when the name is invalid or the skill is
 * absent — deleting a missing skill is a 404, not silence. */
export function deleteSkill(botId: string, name: string): boolean {
  if (!isSkillName(name)) return false;
  try {
    unlinkSync(join(skillsDir(botId), name));
    return true;
  } catch {
    return false;
  }
}

/** How a mounted skill appears in the system prompt. Bounded per skill so a
 * huge playbook cannot blow the prompt budget: the header + first 4KB carry
 * the intent; the full file stays on disk where the bot can read it with its
 * ordinary file tools. */
const SKILL_PROMPT_MAX_BYTES = 4 * 1024;

function skillPromptBody(botId: string, name: string): string | null {
  const text = readSkill(botId, name);
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const bytes = Buffer.byteLength(trimmed, "utf8");
  return bytes <= SKILL_PROMPT_MAX_BYTES
    ? trimmed
    : `${Buffer.from(trimmed, "utf8").subarray(0, SKILL_PROMPT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "")}\n[skill truncated — read the full file at skills/${name}]`;
}

/** The skills block for the system prompt: one line per skill naming the
 * mounted playbook, its file path, and its instructions. Empty when the bot
 * has no skills or none of them are non-empty — a prompt with a dangling
 * "Skills:" header would invite the model to invent them. */
export function skillsSystemPrompt(botId: string): string {
  const skills = listSkills(botId);
  if (skills.length === 0) return "";
  const lines: string[] = [];
  for (const { name } of skills) {
    const body = skillPromptBody(botId, name);
    if (body !== null) {
      lines.push(`- skills/${name}: ${body}`);
    }
  }
  if (lines.length === 0) return "";
  return (
    " The user installed these skill playbooks for you — follow them when they apply" +
    " to the current task, and treat their instructions as the user's own standing" +
    " instructions:\n" +
    lines.join("\n")
  );
}
