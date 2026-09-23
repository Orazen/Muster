// M1 retrieval — deterministic BM25 (relevance, tf, tie order), the limit
// cap, provenance on every hit, the defined empty-q browse, tokenization
// parity with workspace-brain, both corpus readers, and searchMemory's
// default-deny wiring. Isolation comes from server/testing/setup.ts: it
// points HOME at a throwaway directory before config.ts loads, and
// DATA_DIR — which the brain corpus reader and every workspace path derive
// from homedir() at import time — resolves inside it, so fixtures are
// written to exactly the paths the modules read. No server, no network.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MemoryGrant } from "./memory-grants.ts";
import type { MemoryDoc } from "./memory-retrieval.ts";

const { DATA_DIR } = await import("./config.ts");
const retrieval = await import("./memory-retrieval.ts");
const { tokenize } = await import("./workspace-brain.ts");
const workspace = await import("./workspace.ts");

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

/** A fact document with a constant title unless the test says otherwise —
 * identical titles keep the field weight out of tie comparisons. */
const factDoc = (
  key: string,
  text: string,
  createdAt: number,
  options: { title?: string; id?: string } = {},
): MemoryDoc => ({
  id: options.id ?? `fact:${key}`,
  kind: "fact",
  title: options.title ?? "plain header",
  text,
  createdAt,
  provenance: {
    kind: "fact",
    factId: key,
    source: `source-${key}`,
    origin: "unit",
    ownerId: "u1",
    createdAt,
  },
});

const idsOf = (docs: MemoryDoc[]): string[] => docs.map((doc) => doc.id);

describe("memory retrieval (BM25, provenance, limits)", () => {
  it("scores the strongest match first and never surfaces a non-match", () => {
    const docs = [
      factDoc("strong", "deploy deploy deploy pipeline steps", NOW - 60_000),
      factDoc("weak", "deploy once for the archive", NOW),
      factDoc("none", "gardening notes about tomatoes", NOW),
    ];
    const result = retrieval.searchDocuments(docs, "deploy", { now: NOW });
    expect(result.mode).toBe("search");
    // Relevance first: the older document still wins on tf, and the
    // zero-match document is dropped entirely.
    expect(result.hits.map((hit) => hit.id)).toEqual(["fact:strong", "fact:weak"]);
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score);
    expect(result.hits[0].matched).toEqual(["deploy"]);
  });

  it("raises the score with term frequency when everything else matches", () => {
    const docs = [
      factDoc("single", "widget alpha notes", NOW),
      factDoc("double", "widget widget alpha notes", NOW),
    ];
    const hits = retrieval.searchDocuments(docs, "widget", { now: NOW }).hits;
    expect(hits.map((hit) => hit.id)).toEqual(["fact:double", "fact:single"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("breaks ties deterministically — newest first, then id ascending, over any input order", () => {
    const docs = [
      factDoc("b", "identical tie text", NOW + 1000, { id: "fact:b" }),
      factDoc("c", "identical tie text", NOW + 2000, { id: "fact:c" }),
      factDoc("a", "identical tie text", NOW + 1000, { id: "fact:a" }),
    ];
    // Future timestamps age-clip to exactly the same recency factor, so all
    // three scores are byte-identical: c wins on createdAt, a before b on id.
    const expected = ["fact:c", "fact:a", "fact:b"];
    const orders = [docs, [...docs].reverse(), [docs[1], docs[2], docs[0]]];
    for (const order of orders) {
      const hits = retrieval.searchDocuments(order, "identical", { now: NOW }).hits;
      expect(hits.map((hit) => hit.id)).toEqual(expected);
      expect(new Set(hits.map((hit) => hit.score)).size).toBe(1);
    }
  });

  it("prefers the newer document when scores are exactly equal, even against id order", () => {
    const older = factDoc("a", "same score text", NOW + 999, { id: "fact:a" });
    const newer = factDoc("b", "same score text", NOW + 1000, { id: "fact:b" });
    const hits = retrieval.searchDocuments([older, newer], "score", { now: NOW }).hits;
    expect(hits[0].score).toBe(hits[1].score);
    expect(hits.map((hit) => hit.id)).toEqual(["fact:b", "fact:a"]);
  });

  it("clamps limit to [1, 50], defaults to 8, and treats non-integers as the default", () => {
    const docs = Array.from({ length: 60 }, (_, index) =>
      factDoc(`m${index}`, `widget entry number ${index}`, NOW - index * 1000, { id: `fact:m${index}` }));
    const over = retrieval.searchDocuments(docs, "widget", { limit: 999, now: NOW });
    expect(over.limit).toBe(50);
    expect(over.hits).toHaveLength(50);
    expect(retrieval.searchDocuments(docs, "widget", { limit: 0, now: NOW }).limit).toBe(1);
    expect(retrieval.searchDocuments(docs, "widget", { limit: -10, now: NOW }).limit).toBe(1);
    const absent = retrieval.searchDocuments(docs, "widget", { now: NOW });
    expect(absent.limit).toBe(8);
    expect(absent.hits).toHaveLength(8);
    expect(retrieval.searchDocuments(docs, "widget", { limit: 3.5, now: NOW }).limit).toBe(8);
    expect(retrieval.searchDocuments(docs, "widget", { limit: Number.NaN, now: NOW }).limit).toBe(8);
    expect(retrieval.DEFAULT_LIMIT).toBe(8);
    expect(retrieval.MAX_LIMIT).toBe(50);
  });

  it("attaches provenance, score components, and matched terms to every hit", () => {
    const docs = [factDoc("prov", "deploy notes with provenance", NOW, { title: "runbook source-portal" })];
    const hits = retrieval.searchDocuments(docs, "deploy", { now: NOW }).hits;
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit.provenance).toEqual({
      kind: "fact",
      factId: "prov",
      source: "source-prov",
      origin: "unit",
      ownerId: "u1",
      createdAt: NOW,
    });
    expect(hit.title).toBe("runbook source-portal");
    expect(hit.components.bm25).toBeGreaterThan(0);
    expect(hit.components.recency).toBeGreaterThanOrEqual(1);
    expect(hit.matched).toContain("deploy");
    expect(hit.score).toBeGreaterThan(0);
  });

  it("browses recent-first with score 0 on an empty or whitespace query", () => {
    const docs = [
      factDoc("old", "alpha content", 1000, { id: "fact:old" }),
      factDoc("new", "beta content", 3000, { id: "fact:new" }),
      factDoc("mid", "gamma content", 2000, { id: "fact:mid" }),
    ];
    for (const q of ["", "   "]) {
      const result = retrieval.searchDocuments(docs, q, { now: NOW });
      expect(result.mode).toBe("browse");
      expect(result.hits.map((hit) => hit.id)).toEqual(["fact:new", "fact:mid", "fact:old"]);
      expect(result.hits.every((hit) => hit.score === 0 && hit.matched.length === 0)).toBe(true);
    }
    expect(retrieval.searchDocuments(docs, "", { limit: 2, now: NOW }).hits).toHaveLength(2);
  });

  it("keeps tokenize()'s exact term set while preserving multiplicity", () => {
    const text = "Deploy v2.1 @ops the CI failed twice, twice; user@example.com saw 404 and 404!";
    const counted = retrieval.tokensOf(text);
    expect(new Set(counted)).toEqual(new Set(tokenize(text)));
    expect(counted.filter((token) => token === "twice")).toHaveLength(2);
    expect(counted.filter((token) => token === "404")).toHaveLength(2);
    expect(counted).toContain("user@example.com");
    expect(counted).toContain("v2.1");
    expect(counted).not.toContain("the");
    expect(counted).not.toContain("ci");
    const second = "Second SAMPLE, with Punctuation!! and the.";
    expect(new Set(retrieval.tokensOf(second))).toEqual(new Set(tokenize(second)));
    expect(retrieval.tokensOf("deploy deploy")).toEqual(["deploy", "deploy"]);
    expect(retrieval.tokensOf("the and but for")).toEqual([]);
  });

  it("bounds the recency factor to [1, 1.25]", () => {
    expect(retrieval.recencyFactor(NOW, NOW)).toBeCloseTo(1.25, 10);
    expect(retrieval.recencyFactor(NOW + 5_000, NOW)).toBeCloseTo(1.25, 10);
    expect(retrieval.recencyFactor(NOW - 10 * 365 * 86_400_000, NOW)).toBeCloseTo(1, 6);
    expect(retrieval.recencyFactor(NOW - 30 * 86_400_000, NOW)).toBeCloseTo(1 + 0.25 / Math.E, 6);
  });
});

describe("memory retrieval corpora", () => {
  // The exact lockstep path memory-retrieval derives from DATA_DIR.
  const brainFile = join(DATA_DIR, "workspace-brain.json");
  const brainFixture = {
    facts: [
      { id: "fa", ownerId: "userA", text: "alpha deploy owner a", kind: "note", source: "s1", origin: "o1", createdAt: 3000 },
      { id: "fb", ownerId: "userB", text: "beta release owner b", kind: "note", source: "s2", createdAt: 2000 },
      { id: "fc", text: "desktop unowned fact", kind: "note", source: "s3", createdAt: 1000 },
      { id: "fd", ownerId: "userA", text: "withdrawn deploy entry", kind: "note", source: "s4", createdAt: 4000, withdrawnAt: 12_345 },
    ],
  };

  it("reads brain facts through owner and granted views, excluding withdrawals", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(brainFile, JSON.stringify(brainFixture));
    expect(idsOf(retrieval.brainFactDocs({ owner: "userA", view: "owner" }))).toEqual(["fact:fa", "fact:fc"]);
    expect(idsOf(retrieval.brainFactDocs({ owner: "userB", view: "owner" }))).toEqual(["fact:fb", "fact:fc"]);
    expect(idsOf(retrieval.brainFactDocs({ owner: undefined, view: "owner" }))).toEqual(["fact:fa", "fact:fb", "fact:fc"]);
    // The granted view is STRICT: only the anchored owner's own facts…
    expect(idsOf(retrieval.brainFactDocs({ owner: "userA", view: "granted" }))).toEqual(["fact:fa"]);
    expect(idsOf(retrieval.brainFactDocs({ owner: "userB", view: "granted" }))).toEqual(["fact:fb"]);
    // …and on a desktop install (no owner id) only the unowned facts, never
    // another install's.
    expect(idsOf(retrieval.brainFactDocs({ owner: undefined, view: "granted" }))).toEqual(["fact:fc"]);
    const [first] = retrieval.brainFactDocs({ owner: "userA", view: "owner" });
    expect(first.title).toBe("note s1");
    expect(first.text).toBe("alpha deploy owner a");
    expect(first.provenance).toEqual({
      kind: "fact",
      factId: "fa",
      source: "s1",
      origin: "o1",
      ownerId: "userA",
      createdAt: 3000,
    });
  });

  it("degrades to zero fact docs for an absent, corrupt, or foreign brain file", () => {
    const read = () => retrieval.brainFactDocs({ owner: "userA", view: "owner" });
    writeFileSync(brainFile, "{definitely not json");
    expect(read()).toEqual([]);
    writeFileSync(brainFile, JSON.stringify({ other: [] }));
    expect(read()).toEqual([]);
    writeFileSync(brainFile, JSON.stringify({ facts: "nope" }));
    expect(read()).toEqual([]);
    rmSync(brainFile);
    expect(read()).toEqual([]);
    writeFileSync(brainFile, JSON.stringify(brainFixture)); // restore for the pipeline tests
  });

  it("reads MEMORY.md and topic files as documents with file provenance", () => {
    const botId = "mem-bot";
    workspace.ensureWorkspace(botId);
    // Seed-only is instructions, not memory → no document yet.
    expect(retrieval.botMemoryDocs(botId)).toEqual([]);
    const dir = workspace.workspaceDir(botId);
    writeFileSync(join(dir, "MEMORY.md"), "Staging deploy checklist lives in MEMORY.md.");
    writeFileSync(join(dir, "memory", "deploy.md"), "Deploy topic notes for BM25.");
    writeFileSync(join(dir, "memory", "empty.md"), "");
    const docs = retrieval.botMemoryDocs(botId);
    // MEMORY.md first, then topics by name; the empty topic never becomes a doc.
    expect(idsOf(docs)).toEqual([`memory:${botId}:MEMORY.md`, `memory:${botId}:memory/deploy.md`]);
    const [main, topic] = docs;
    expect(main.kind).toBe("memory");
    expect(main.createdAt).toBeGreaterThan(0);
    expect(main.provenance).toMatchObject({
      kind: "memory",
      botId,
      file: "MEMORY.md",
      bytes: Buffer.byteLength(main.text, "utf8"),
    });
    expect(topic.title).toBe("memory/deploy.md");
    expect(topic.provenance).toMatchObject({ kind: "memory", botId, file: "memory/deploy.md" });
    expect(retrieval.botMemoryDocs("bot-that-never-existed")).toEqual([]);
  });
});

describe("searchMemory pipeline (default deny via resource grants)", () => {
  const PIPE_BOT = "search-bot";
  const activeGrant = (overrides: Partial<MemoryGrant> = {}): MemoryGrant => ({
    id: "grant-1",
    grantee: { kind: "user", id: "grantee-1" },
    botId: PIPE_BOT,
    resource: "memory",
    permission: "read",
    createdAt: NOW - 1_000,
    ...overrides,
  });
  const granteeView = (list: MemoryGrant[]) => retrieval.searchMemory({
    botId: PIPE_BOT,
    botOwnerId: "userA",
    requester: { kind: "user", id: "grantee-1" },
    isOwner: false,
    grants: list,
    q: "deploy",
    now: NOW,
  });

  it("serves the owner both corpora and denies a stranger by default", () => {
    workspace.ensureWorkspace(PIPE_BOT);
    writeFileSync(
      join(workspace.workspaceDir(PIPE_BOT), "MEMORY.md"),
      "Owner private note: staging deploy checklist for the release.",
    );
    const owned = retrieval.searchMemory({
      botId: PIPE_BOT,
      botOwnerId: "userA",
      requester: { kind: "user", id: "userA" },
      isOwner: true,
      grants: [],
      q: "deploy",
      now: NOW,
    });
    if (!owned) throw new Error("the owner must never be default-denied");
    expect(owned.via).toBe("owner");
    expect(owned.mode).toBe("search");
    expect(new Set(owned.hits.map((hit) => hit.kind))).toEqual(new Set(["memory", "fact"]));
    expect(owned.hits.every((hit) => hit.provenance !== undefined)).toBe(true);
    // Default deny: no grant, not the owner → null (the route's 404 signal).
    expect(granteeView([])).toBeNull();
    // A grant anchored to another bot never leaks across.
    expect(granteeView([activeGrant({ botId: "other-bot" })])).toBeNull();
  });

  it("scopes a granted view to exactly the granted resource, via the grant", () => {
    const memoryOnly = granteeView([activeGrant({ resource: "memory" })]);
    if (!memoryOnly) throw new Error("an active memory grant must admit the grantee");
    expect(memoryOnly.via).toBe("grant");
    expect(memoryOnly.hits.length).toBeGreaterThan(0);
    expect(memoryOnly.hits.every((hit) => hit.kind === "memory")).toBe(true);

    const factsOnly = granteeView([activeGrant({ resource: "facts" })]);
    if (!factsOnly) throw new Error("an active facts grant must admit the grantee");
    expect(factsOnly.via).toBe("grant");
    expect(factsOnly.hits.length).toBeGreaterThan(0);
    expect(factsOnly.hits.every((hit) => hit.kind === "fact")).toBe(true);
  });

  it("treats revoked and expired grants as no grant at all", () => {
    expect(granteeView([activeGrant({ revokedAt: NOW - 1 })])).toBeNull();
    expect(granteeView([activeGrant({ expiresAt: NOW })])).toBeNull(); // boundary: not strictly future
    expect(granteeView([activeGrant({ expiresAt: NOW - 1 })])).toBeNull();
    expect(granteeView([activeGrant({ expiresAt: NOW + 60_000 })])).not.toBeNull();
  });

  it("answers a granted-but-empty corpus with hits:[] rather than a denial", () => {
    const emptyBot = "empty-bot";
    workspace.ensureWorkspace(emptyBot); // seed-only: no memory documents
    const result = retrieval.searchMemory({
      botId: emptyBot,
      botOwnerId: "userA",
      requester: { kind: "user", id: "grantee-1" },
      isOwner: false,
      grants: [activeGrant({ botId: emptyBot })],
      q: "",
      now: NOW,
    });
    if (!result) throw new Error("the grant exists — an empty corpus must not read as a denial");
    expect(result.via).toBe("grant");
    expect(result.mode).toBe("browse");
    expect(result.hits).toEqual([]);
  });

  it("reports the desktop owner view distinctly and clamps the delegated limit", () => {
    const desktop = retrieval.searchMemory({
      botId: PIPE_BOT,
      botOwnerId: undefined,
      requester: { kind: "desktop" },
      isOwner: true,
      grants: [],
      q: "deploy",
      limit: 999,
      now: NOW,
    });
    if (!desktop) throw new Error("a desktop owner is never denied");
    expect(desktop.via).toBe("desktop");
    expect(desktop.limit).toBe(50);
  });
});
