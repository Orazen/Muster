// Roster sections (OMB parity #1b) and the cross-bot attention inbox
// (parity #1a) — the pure half of the sidebar's next layer.
//
// OpenMausBot ships "threads with folders" and a cross-bot attention inbox
// ("what needs me"). Muster's roster already nests room-threads under bots
// and sorts attention-first, so the genuine gaps here are: named, persisted
// sections a bot can be moved into (the "Move to new section" menu item has
// been a disabled "Coming soon" stub since it was drawn), and one inbox
// that answers "what needs me" across every bot and room at once.
//
// Everything here is pure or storage-shaped so the rules are testable and
// the sidebar component stays thin. A section is identity + name + member
// bot ids; the assignment map is the source of truth for WHERE a bot sits,
// with each section carrying its member list for render order. Storage is
// localStorage (per profile, like density and collapsed sections) decoded
// through zod, matching the repo's boundary pattern.

import { z } from "zod";

export type RosterSectionId = string;

/** A named folder in the roster. Bots not in any section render in the
 * default "Teammates" list, exactly as before. */
export interface RosterSection {
  id: RosterSectionId;
  name: string;
  botIds: string[];
}

/** botId -> sectionId. A bot absent from the map is unsectioned. */
export type RosterAssignment = Record<string, RosterSectionId>;

export const MAX_SECTIONS = 8;
export const MAX_SECTION_NAME = 24;
export const MAX_BOTS_PER_SECTION = 20;

const SectionEntry = z.object({
  id: z.string().min(1).max(200).transform((s) => s.slice(0, 64)),
  // A long pasted name is clamped, not fatal: one bad entry must not take
  // the whole saved layout down with it.
  name: z.string().max(300).transform((s) => s.trim().slice(0, MAX_SECTION_NAME)),
  botIds: z.array(z.string().min(1).max(128)).max(64),
});

const StoredSections = z.array(SectionEntry);
const StoredAssignment = z.record(z.string(), z.string());

const SECTIONS_KEY = "muster:roster-sections.v1";
const ASSIGNMENT_KEY = "muster:roster-assignments.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const unique = (values: string[]): string[] => [...new Set(values)];

/** Decode the raw JSON text storage holds. Corrupt shapes read back as
 * empty — preferences must never take the roster down with them. */
export function sanitizeRosterSections(raw: string): RosterSection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const decoded = StoredSections.safeParse(parsed);
  if (!decoded.success) return [];
  const seen = new Set<string>();
  const sections: RosterSection[] = [];
  for (const entry of decoded.data) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (!entry.name) continue;
    sections.push({ id: entry.id, name: entry.name, botIds: unique(entry.botIds).slice(0, MAX_BOTS_PER_SECTION) });
    if (sections.length >= MAX_SECTIONS) break;
  }
  return sections;
}

/** Decode the assignment map, dropping entries whose key or value could
 * not have been written by this module. */
export function sanitizeAssignment(raw: string): RosterAssignment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const decoded = StoredAssignment.safeParse(parsed);
  if (!decoded.success) return {};
  const entries = Object.entries(decoded.data).filter(
    ([botId, sectionId]) => botId.length >= 1 && botId.length <= 128 && sectionId.length >= 1 && sectionId.length <= 64,
  );
  return Object.fromEntries(entries);
}

export function loadRosterSections(storage: StorageLike | null | undefined): RosterSection[] {
  try {
    const raw = storage?.getItem(SECTIONS_KEY);
    return raw ? sanitizeRosterSections(raw) : [];
  } catch {
    return [];
  }
}

export function saveRosterSections(storage: StorageLike | null | undefined, sections: RosterSection[]): RosterSection[] {
  const trimmed = sections.slice(0, MAX_SECTIONS);
  try {
    storage?.setItem(SECTIONS_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota/private mode: the session works, layout just does not persist */
  }
  return trimmed;
}

export function loadRosterAssignment(storage: StorageLike | null | undefined): RosterAssignment {
  try {
    const raw = storage?.getItem(ASSIGNMENT_KEY);
    return raw ? sanitizeAssignment(raw) : {};
  } catch {
    return {};
  }
}

export function saveRosterAssignment(storage: StorageLike | null | undefined, assignment: RosterAssignment): RosterAssignment {
  try {
    storage?.setItem(ASSIGNMENT_KEY, JSON.stringify(assignment));
  } catch {
    /* same tolerance as sections */
  }
  return assignment;
}

/** Move a bot into a section (or back to the default roster with null).
 * One bot sits in at most one section: any previous membership moves with
 * it. An unknown section id is a no-op, not a half-applied move. The
 * caller persists both halves of the returned pair. */
export function assignBotToSection(
  sections: RosterSection[],
  assignment: RosterAssignment,
  botId: string,
  sectionId: RosterSectionId | null,
) {
  if (sectionId !== null && !sections.some((section) => section.id === sectionId)) {
    return { sections, assignment };
  }
  const nextAssignment = { ...assignment };
  if (sectionId === null) delete nextAssignment[botId];
  else nextAssignment[botId] = sectionId;

  let nextSections = sections.map((section) => ({
    ...section,
    botIds: section.botIds.filter((id) => id !== botId),
  }));
  if (sectionId !== null) {
    nextSections = nextSections.map((section) =>
      section.id === sectionId && section.botIds.length < MAX_BOTS_PER_SECTION
        ? { ...section, botIds: [...section.botIds, botId] }
        : section,
    );
  }
  return { sections: nextSections, assignment: nextAssignment };
}

/** Remove a section; its bots fall back to the default roster. */
export function removeRosterSection(
  sections: RosterSection[],
  assignment: RosterAssignment,
  sectionId: RosterSectionId,
) {
  return {
    sections: sections.filter((section) => section.id !== sectionId),
    assignment: Object.fromEntries(
      Object.entries(assignment).filter(([, id]) => id !== sectionId),
    ),
  };
}

export function renameRosterSection(
  sections: RosterSection[],
  sectionId: RosterSectionId,
  name: string,
): RosterSection[] {
  const clean = name.trim().slice(0, MAX_SECTION_NAME);
  if (!clean) return sections;
  return sections.map((section) => (section.id === sectionId ? { ...section, name: clean } : section));
}

// ---------------------------------------------------------------------------
// The cross-bot attention inbox: "what needs me", across every bot and room.
// ---------------------------------------------------------------------------

export type AttentionReason = "waiting" | "failed" | "unread";

export interface AttentionItem {
  kind: "bot" | "room";
  id: string;
  name: string;
  reason: AttentionReason;
  /** Recency hint — last activity the caller already knows. Absent sorts last. */
  at?: number;
}

/** The structural facts the inbox derives from — the bots/rooms feeds the
 * sidebar already holds, reduced to what the rules may read. */
export interface AttentionFacts {
  id: string;
  name: string;
  unread?: boolean;
  waiting?: boolean;
  failed?: boolean;
  at?: number;
}

const RANK = {
  waiting: 0,
  failed: 1,
  unread: 2,
} as const satisfies Record<AttentionReason, number>;

/** Derive the inbox: waiting-on-you first, then failed tools, then unread.
 * Recency breaks ties (newest first). Capped — a frantic fleet still gets
 * a scannable list, and the full roster remains one glance away. */
export const ATTENTION_LIMIT = 8;

export function deriveAttentionInbox(
  bots: ReadonlyArray<AttentionFacts>,
  rooms: ReadonlyArray<AttentionFacts> = [],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const bot of bots) {
    if (bot.waiting) items.push({ kind: "bot", id: bot.id, name: bot.name, reason: "waiting", at: bot.at });
    else if (bot.failed) items.push({ kind: "bot", id: bot.id, name: bot.name, reason: "failed", at: bot.at });
    else if (bot.unread) items.push({ kind: "bot", id: bot.id, name: bot.name, reason: "unread", at: bot.at });
  }
  for (const room of rooms) {
    if (room.unread) items.push({ kind: "room", id: room.id, name: room.name, reason: "unread", at: room.at });
  }
  return items
    .sort((a, b) => RANK[a.reason] - RANK[b.reason] || (b.at ?? 0) - (a.at ?? 0))
    .slice(0, ATTENTION_LIMIT);
}
