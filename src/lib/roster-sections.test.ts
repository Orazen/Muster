import { describe, expect, it } from "vitest";
import {
  assignBotToSection,
  ATTENTION_LIMIT,
  deriveAttentionInbox,
  loadRosterAssignment,
  loadRosterSections,
  MAX_SECTIONS,
  MAX_SECTION_NAME,
  removeRosterSection,
  renameRosterSection,
  sanitizeAssignment,
  sanitizeRosterSections,
  saveRosterAssignment,
  saveRosterSections,
  type RosterSection,
} from "./roster-sections";

const memoryStorage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

describe("section storage", () => {
  it("round-trips sections and drops duplicate ids, blank names, over-cap extras", () => {
    const storage = memoryStorage();
    saveRosterSections(storage, [
      { id: "s1", name: "  Research  ", botIds: ["a", "a", "b"] },
      { id: "s1", name: "dupe", botIds: [] },
      { id: "s2", name: "   ", botIds: [] },
      { id: "s3", name: "Ops", botIds: [] },
    ]);
    const loaded = loadRosterSections(storage);
    expect(loaded).toEqual([
      { id: "s1", name: "Research", botIds: ["a", "b"] },
      { id: "s3", name: "Ops", botIds: [] },
    ]);
    // cap enforced at save AND load
    const many: RosterSection[] = Array.from({ length: MAX_SECTIONS + 3 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, botIds: [] }));
    expect(saveRosterSections(storage, many).length).toBe(MAX_SECTIONS);
    expect(loadRosterSections(storage).length).toBe(MAX_SECTIONS);
  });

  it("reads corrupt JSON and wrong shapes as empty", () => {
    expect(loadRosterSections(memoryStorage({ "muster:roster-sections.v1": "{oops" }))).toEqual([]);
    expect(loadRosterSections(memoryStorage({ "muster:roster-sections.v1": JSON.stringify([{ id: 1, name: "x", botIds: [] }]) }))).toEqual([]);
    expect(loadRosterSections(undefined)).toEqual([]);
  });

  it("clamps over-long names and rejects garbage assignments", () => {
    const sections = sanitizeRosterSections(JSON.stringify([{ id: "s1", name: "x".repeat(40), botIds: [] }]));
    expect(sections[0].name.length).toBe(MAX_SECTION_NAME);
    expect(sanitizeAssignment(JSON.stringify({ a: "s1", "": "s2", ["b".repeat(200)]: "s3" }))).toEqual({ a: "s1" });
    expect(sanitizeAssignment("nope")).toEqual({});
  });

  it("persists assignments and survives corrupt JSON", () => {
    const storage = memoryStorage();
    saveRosterAssignment(storage, { a: "s1", b: "s2" });
    expect(loadRosterAssignment(storage)).toEqual({ a: "s1", b: "s2" });
    expect(loadRosterAssignment(memoryStorage({ "muster:roster-assignments.v1": "nope" }))).toEqual({});
    expect(loadRosterAssignment(memoryStorage({ "muster:roster-assignments.v1": JSON.stringify({ a: 42 }) }))).toEqual({});
  });
});

describe("assignment moves", () => {
  const base: RosterSection[] = [
    { id: "s1", name: "Research", botIds: ["a"] },
    { id: "s2", name: "Ops", botIds: ["b", "c"] },
  ];

  it("moves a bot between sections, taking it out of the old one", () => {
    const { sections, assignment } = assignBotToSection(base, { a: "s1" }, "a", "s2");
    expect(sections.find((s) => s.id === "s1")?.botIds).toEqual([]);
    expect(sections.find((s) => s.id === "s2")?.botIds).toEqual(["b", "c", "a"]);
    expect(assignment).toEqual({ a: "s2" });
  });

  it("unassigning removes the bot from every section and the map", () => {
    const { sections, assignment } = assignBotToSection(base, { c: "s2" }, "c", null);
    expect(sections.find((s) => s.id === "s2")?.botIds).toEqual(["b"]);
    expect(assignment).toEqual({});
  });

  it("assigning an unsectioned bot leaves the other section untouched", () => {
    const { sections, assignment } = assignBotToSection(base, {}, "z", "s1");
    expect(sections.find((s) => s.id === "s1")?.botIds).toEqual(["a", "z"]);
    expect(sections.find((s) => s.id === "s2")?.botIds).toEqual(["b", "c"]);
    expect(assignment).toEqual({ z: "s1" });
  });

  it("a missing section id is a no-op, not a half-applied move", () => {
    const { sections, assignment } = assignBotToSection(base, { c: "s2" }, "c", "ghost");
    expect(assignment).toEqual({ c: "s2" });
    expect(sections.find((s) => s.id === "s2")?.botIds).toEqual(["b", "c"]);
  });
});

describe("section lifecycle", () => {
  it("removeRosterSection drops the section and unmaps its bots", () => {
    const sections: RosterSection[] = [
      { id: "s1", name: "Research", botIds: ["a", "b"] },
      { id: "s2", name: "Ops", botIds: [] },
    ];
    const next = removeRosterSection(sections, { a: "s1", b: "s1", z: "s2" }, "s1");
    expect(next.sections).toEqual([sections[1]]);
    expect(next.assignment).toEqual({ z: "s2" });
  });

  it("rename clamps and ignores blank names", () => {
    const sections: RosterSection[] = [{ id: "s1", name: "Research", botIds: [] }];
    expect(renameRosterSection(sections, "s1", "  Deep work  ")[0].name).toBe("Deep work");
    expect(renameRosterSection(sections, "s1", "   ")).toEqual(sections);
    expect(renameRosterSection(sections, "ghost", "x")).toEqual(sections);
  });
});

describe("deriveAttentionInbox", () => {
  it("ranks waiting > failed > unread, recency within a rank", () => {
    const items = deriveAttentionInbox(
      [
        { id: "u", name: "Unread bot", unread: true, at: 100 },
        { id: "f", name: "Failed bot", failed: true, at: 50 },
        { id: "w", name: "Waiting bot", waiting: true, at: 10 },
        { id: "idle", name: "Idle bot" },
      ],
      [{ id: "r", name: "Noisy room", unread: true, at: 200 }],
    );
    expect(items.map((i) => `${i.kind}:${i.id}:${i.reason}`)).toEqual([
      "bot:w:waiting",
      "bot:f:failed",
      // same rank as the bot's unread, but newer — recency breaks the tie
      "room:r:unread",
      "bot:u:unread",
    ]);
  });

  it("newest unread wins inside a rank", () => {
    const items = deriveAttentionInbox([
      { id: "old", name: "Old", unread: true, at: 5 },
      { id: "new", name: "New", unread: true, at: 9 },
    ]);
    expect(items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("one reason per item: waiting shadows failed and unread", () => {
    const items = deriveAttentionInbox([{ id: "x", name: "X", waiting: true, failed: true, unread: true }]);
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe("waiting");
  });

  it("caps the list and ignores quiet fleets", () => {
    const quiet = deriveAttentionInbox([{ id: "a", name: "A" }], [{ id: "r", name: "R" }]);
    expect(quiet).toEqual([]);
    const many = deriveAttentionInbox(
      Array.from({ length: ATTENTION_LIMIT + 5 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, unread: true, at: i })),
    );
    expect(many).toHaveLength(ATTENTION_LIMIT);
    expect(many[0].id).toBe(`b${ATTENTION_LIMIT + 4}`);
  });
});
