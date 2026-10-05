// Unit tests for the persisted restart fence store.
//
// The contract suite proves the fence SEMANTICS through an engine; this suite
// proves the STORE itself: format, durability discipline, cross-instance
// visibility, and the fail-closed posture for every corrupt shape. No network,
// no real data dir — every case writes into a private temp directory.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileFencePersistence, MemoryFencePersistence, defaultEnrollmentFencePath } from "./installation-fence-persistence.ts";

const KEY = "client-key-fence-unit-0001";
const OTHER_KEY = "client-key-fence-unit-0002";

let directory: string | null = null;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "muster-fence-unit-"));
});

afterEach(() => {
  if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

const path = (name = "enrollment-fence.json") => join(directory!, name);

describe("FileFencePersistence", () => {
  it("a missing file is healthy and empty — absence is unambiguous, not a failure", () => {
    const store = new FileFencePersistence({ path: path() });
    expect(existsSync(path())).toBe(false);
    expect(store.degraded).toBe(false);
    expect(store.read()).toEqual([]);
    // Merely consulting the store did not create the file: no work happens
    // until something is actually persisted.
    expect(existsSync(path())).toBe(false);
  });

  it("add persists a versioned record with fencedAt and reason, and leaves no temp files", () => {
    const store = new FileFencePersistence({ path: path() });
    const before = 1_760_000_000_000;
    const timed = new FileFencePersistence({ path: path(), now: () => before });
    timed.add(KEY, { reason: "custody-unresolved" });
    expect(store.read()).toEqual([KEY]);

    // SAFETY: these bytes were just written by the store under test in exactly
    // this shape; the assertions below re-prove each field, so a wrong claim
    // about the format fails here rather than silently passing.
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as {
      version: number;
      fences: Array<{ key: string; fencedAt: number; reason?: string }>;
    };
    expect(parsed.version).toBe(1);    expect(parsed.fences).toHaveLength(1);
    expect(parsed.fences[0].key).toBe(KEY);
    expect(parsed.fences[0].fencedAt).toBe(before);
    expect(parsed.fences[0].reason).toBe("custody-unresolved");

    // The durable-write discipline leaves nothing behind: no sibling temp
    // files survive a completed rename.
    expect(readdirSync(directory!)).toEqual(["enrollment-fence.json"]);
  });

  it("a fresh instance over the same file observes what a prior instance persisted", () => {
    // The restart property at the store level: instance A persists, instance
    // B is constructed AFTER (fresh memory), and reads A's fence back.
    const storeA = new FileFencePersistence({ path: path() });
    storeA.add(KEY, { reason: "prior-instance" });
    storeA.add(OTHER_KEY);

    const storeB = new FileFencePersistence({ path: path() });
    expect(storeB.read()).toEqual([KEY, OTHER_KEY]);
    expect(storeB.degraded).toBe(false);
  });

  it("a duplicate add keeps one row per key, with the newest provenance", () => {
    let clock = 1_000;
    const store = new FileFencePersistence({ path: path(), now: () => clock });
    store.add(KEY, { reason: "first" });
    clock = 2_000;
    store.add(KEY, { reason: "second" });
    expect(store.read()).toEqual([KEY]);
    // SAFETY: written by the store under test one statement above; the fields
    // asserted are exactly the ones the format promises.
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as {
      fences: Array<{ key: string; fencedAt: number; reason?: string }>;
    };
    expect(parsed.fences[0].reason).toBe("second");
    expect(parsed.fences[0].fencedAt).toBe(2_000);
  });

  it("clear rewrites a valid empty file that fresh instances observe", () => {
    const store = new FileFencePersistence({ path: path() });
    store.add(KEY);
    store.clear();
    expect(store.read()).toEqual([]);

    const fresh = new FileFencePersistence({ path: path() });
    expect(fresh.read()).toEqual([]);
    expect(fresh.degraded).toBe(false);
  });

  it("reason is optional and round-trips as absent when not given", () => {
    const store = new FileFencePersistence({ path: path() });
    store.add(KEY);
    // SAFETY: written by the store under test one statement above; the point
    // of the assertion is that `reason` is ABSENT, not merely undefined.
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as {
      fences: Array<{ key: string; reason?: string }>;
    };
    expect("reason" in parsed.fences[0]).toBe(false);
  });

  describe("fail-closed corruption handling", () => {
    it("truncated JSON is degraded, and a degraded store accepts no writes", () => {
      writeFileSync(path(), '{"version":1,"fences":[{"key":"k","fencedAt":', { mode: 0o600 });
      const store = new FileFencePersistence({ path: path() });
      expect(store.degraded).toBe(true);
      expect(store.read()).toEqual([]);

      // add() must not heal the file by overwriting unknown contents with a
      // known-fenced set — that would lift fences nobody can see.
      store.add(KEY);
      expect(store.degraded).toBe(true);
      expect(store.read()).toEqual([]);
      expect(readFileSync(path(), "utf8")).toBe('{"version":1,"fences":[{"key":"k","fencedAt":');
    });

    it("every wrong-but-parseable shape is degraded", () => {
      const corruptPayloads: Array<[string, string]> = [
        ["wrong-version", JSON.stringify({ version: 2, fences: [] })],
        ["missing-fences", JSON.stringify({ version: 1 })],
        ["fences-not-array", JSON.stringify({ version: 1, fences: KEY })],
        ["key-wrong-type", JSON.stringify({ version: 1, fences: [{ key: 7, fencedAt: 1 }] })],
        ["fencedAt-wrong-type", JSON.stringify({ version: 1, fences: [{ key: KEY, fencedAt: "now" }] })],
        ["not-an-object", "[1,2,3]"],
        ["empty-bytes", ""],
      ];
      for (const [name, bytes] of corruptPayloads) {
        const corrupt = path(`corrupt-${name}.json`);
        writeFileSync(corrupt, bytes, { mode: 0o600 });
        const store = new FileFencePersistence({ path: corrupt });
        expect(store.degraded, name).toBe(true);
        expect(store.read(), name).toEqual([]);
      }
    });

    it("a symlinked fence file is degraded, never followed", () => {
      const target = path("target.json");
      writeFileSync(target, JSON.stringify({ version: 1, fences: [] }), { mode: 0o600 });
      symlinkSync(target, path());
      const store = new FileFencePersistence({ path: path() });
      expect(store.degraded).toBe(true);
      expect(store.read()).toEqual([]);
    });

    it("a file beyond the size bound is degraded", () => {
      writeFileSync(path(), "x".repeat(256 * 1024 + 1), { mode: 0o600 });
      const store = new FileFencePersistence({ path: path() });
      expect(store.degraded).toBe(true);
    });

    it("clear is the only operation that heals a degraded store", () => {
      writeFileSync(path(), "{ corrupt", { mode: 0o600 });
      const store = new FileFencePersistence({ path: path() });
      expect(store.degraded).toBe(true);

      store.clear();
      expect(store.degraded).toBe(false);
      expect(store.read()).toEqual([]);
      // The healed file is valid again for a fresh instance.
      expect(new FileFencePersistence({ path: path() }).degraded).toBe(false);
      // And the healed store persists normally afterwards: a new instance —
      // constructed after the add, per the single-writer limit — reads it.
      store.add(KEY);
      expect(new FileFencePersistence({ path: path() }).read()).toEqual([KEY]);
    });
  });
});

describe("MemoryFencePersistence", () => {
  it("round-trips keys and declares itself non-conforming", () => {
    const store = new MemoryFencePersistence();
    expect(store.conformsToDurableFence).toBe(false);
    expect(store.degraded).toBe(false);
    store.add(KEY, { reason: "test" });
    store.add(OTHER_KEY);
    expect(store.read()).toEqual([KEY, OTHER_KEY]);
    store.clear();
    expect(store.read()).toEqual([]);
  });
});

describe("defaultEnrollmentFencePath", () => {
  it("names a flat enrollment-fence.json under the data dir", () => {
    const resolved = defaultEnrollmentFencePath();
    // Flat file in the data root, named like the installation registry names
    // its own file — no subdirectory, no extension beyond .json.
    expect(resolved.endsWith("enrollment-fence.json")).toBe(true);
    expect(resolved.includes("/")).toBe(true);
  });
});

describe("concurrent instances in one process", () => {
  it("the cache of one instance is authoritative for what it wrote; writes stay consistent", () => {
    // Two instances over one file, used sequentially (the single-writer
    // contract). The second instance must adopt the first's rows, and the
    // first instance's subsequent add must not lose the second's.
    mkdirSync(directory!, { recursive: true });
    const first = new FileFencePersistence({ path: path() });
    first.add(KEY);
    const second = new FileFencePersistence({ path: path() });
    second.add(OTHER_KEY);
    // `first` predates the second write and does not observe it — its cache
    // holds what IT wrote. That is the single-writer limit, stated.
    expect(first.read()).toEqual([KEY]);
    // But a fresh instance sees the union, because both writes landed.
    expect(new FileFencePersistence({ path: path() }).read()).toEqual([KEY, OTHER_KEY]);
  });
});
