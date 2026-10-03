// Unit coverage for the stable installation authority. The report's
// falsifiable cases that live at this layer: same user-agent on two machines
// is two rows (distinct client keys); another account cannot list or revoke;
// a lost provisioning response is reconciled by stable identity; a stale
// credential cannot authenticate; a restart (fresh registry over the same
// file) cannot resurrect revoked authority. The wire behavior is pinned by
// installation-harness.test.ts.
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashCredential, InstallationRegistry, registryPathFor, type RegisterInput } from "./installation-authority.ts";

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "muster-installation-"));
});

afterEach(() => {
  if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true });
});

function registry(): InstallationRegistry {
  return new InstallationRegistry(registryPathFor(directory));
}

const BASE = { ownerId: "owner-1", clientKey: "desk-mac-alpha", label: "Study Mac", platform: "macos" as const };

/** A registration that must have happened. `register` returns null when the
 * write did not reach disk, and that is a value these cases assert against
 * rather than something to paper over with a non-null assertion. */
const registered = (store: InstallationRegistry, input: RegisterInput, now?: number): NonNullable<ReturnType<InstallationRegistry["register"]>> => {
  const outcome = store.register(input, now);
  if (outcome === null) throw new Error("register refused: the registry write failed");
  return outcome;
};

describe("installation authority", () => {
  /** Make later writes fail while leaving the existing registry file intact
   * and readable — an earlier version of this fixture deleted the whole
   * directory, which made the reload half of every case assert against a file
   * that no longer existed. A read-only directory is the honest way to deny
   * writes: the row survives on disk, and the reload still has something to
   * read. Returns false when the process can write anyway (running as root),
   * so the case skips loudly instead of passing for the wrong reason. */
  const denyWrites = (dir: string): boolean => {
    chmodSync(dir, 0o500);
    // Deliberately NOT restored here: restoring before the caller acts would
    // undo the denial, and the first version of this helper did exactly that,
    // so every case passed against a writable registry and proved nothing.
    // The test's own finally puts the permission back.
    try {
      writeFileSync(join(dir, "probe"), "x");
      return false;
    } catch {
      return true;
    }
  };

  it("a failed refresh does NOT invalidate the credential it tells you to keep", (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), "muster-installation-refresh-"));
    try {
      const path = registryPathFor(dir);
      const store = new InstallationRegistry(path);
      const first = registered(store, BASE, 1_000);
      const live = first.credential!;
      expect(store.authenticate(live, 2_000)).not.toBeNull();

      // Skipped, not passed: a run that cannot deny writes cannot exercise
      // this, and returning quietly would report the property as proven.
      if (!denyWrites(dir)) {
        ctx.skip();
        return;
      }

      // The renewal is refused...
      expect(store.refresh(first.record.id, live, 2_000)).toBeNull();
      expect(store.isDurable).toBe(false);
      // ...and, the whole point, the credential the 503 advises the machine
      // to keep presenting STILL WORKS. Before this it had already been
      // replaced in memory, so the advice bricked the installation until the
      // next restart.
      expect(store.authenticate(live, 2_000), "a failed refresh killed a working credential").not.toBeNull();
      // And nothing reached the file, so a reload agrees.
      expect(new InstallationRegistry(path, 2_000).authenticate(live, 2_000)).not.toBeNull();
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed rotation leaves the previous credential working", (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), "muster-installation-rotate-"));
    try {
      const path = registryPathFor(dir);
      const store = new InstallationRegistry(path);
      const first = registered(store, BASE, 1_000);
      const live = first.credential!;

      // Skipped, not passed: a run that cannot deny writes cannot exercise
      // this, and returning quietly would report the property as proven.
      if (!denyWrites(dir)) {
        ctx.skip();
        return;
      }

      // The route's 503 says "the old credential still works". Make that true.
      expect(store.rotate(BASE.ownerId, first.record.id, 2_000)).toBeNull();
      expect(store.authenticate(live, 2_000), "a failed rotation killed a working credential").not.toBeNull();
      expect(new InstallationRegistry(path, 2_000).authenticate(live, 2_000)).not.toBeNull();
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed revocation does not half-happen", (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), "muster-installation-revoke-"));
    try {
      const path = registryPathFor(dir);
      const store = new InstallationRegistry(path);
      const first = registered(store, BASE, 1_000);
      const live = first.credential!;

      // Skipped, not passed: a run that cannot deny writes cannot exercise
      // this, and returning quietly would report the property as proven.
      if (!denyWrites(dir)) {
        ctx.skip();
        return;
      }

      // Refused, so the row is untouched everywhere. The old bug wrote
      // revokedAt into memory only, which read as revoked in-process while the
      // file still said active — so a restart un-revoked the installation.
      expect(store.revoke(BASE.ownerId, first.record.id, 2_000)).toBe(false);
      expect(store.authenticate(live, 2_000), "a failed revocation still revoked").not.toBeNull();
      expect(new InstallationRegistry(path, 2_000).authenticate(live, 2_000)).not.toBeNull();
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed write as a refusal rather than a registration", () => {
    const directory = mkdtempSync(join(tmpdir(), "muster-installation-deny-"));
    try {
      // A path whose parent is a FILE, not a directory: mkdirSync cannot
      // create it, so the write fails for a reason no credential can fix.
      const blocker = join(directory, "blocked");
      writeFileSync(blocker, "not a directory");
      const store = new InstallationRegistry(join(blocker, "registry.json"));
      expect(store.register(BASE, 1_000)).toBeNull();
      expect(store.isDurable).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("registers an installation with a one-time credential and a stable id", () => {
    const store = registry();
    const first = registered(store, BASE, 1_000);
    expect(first.reactivated).toBe(false);
    expect(first.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(first.record.id).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(first.record.capabilities).toEqual(["workspace"]);
    expect(first.record.credentialHash).toBe(hashCredential(first.credential!));
    expect(first.record.credentialExpiresAt).toBe(1_000 + 24 * 60 * 60_000);
  });

  it("is idempotent per (owner, client key): same key, same stable id, fresh secret", () => {
    const store = registry();
    const first = registered(store, BASE, 1_000);
    const second = registered(store, BASE, 2_000);
    expect(second.reactivated).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    // The re-attach mints a new one-time credential (and retires the old
    // one) — a machine only ever re-registers because it lacks a usable
    // secret, so idempotence is about the ROW, not about keeping a secret.
    expect(second.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(second.credential).not.toBe(first.credential);
    expect(store.authenticate(first.credential!, 3_000)).toBeNull();
  });

  it("treats two machines as two installations even with an identical user-agent", () => {
    const store = registry();
    const desk = registered(store, { ...BASE, clientKey: "desk-mac-alpha" }, 1_000);
    const laptop = registered(store, { ...BASE, clientKey: "laptop-mac" }, 1_000);
    expect(desk.record.id).not.toBe(laptop.record.id);
    expect(store.list("owner-1")).toHaveLength(2);
  });

  it("keeps accounts apart: another account cannot list or revoke", () => {
    const store = registry();
    const mine = registered(store, { ...BASE }, 1_000);
    expect(store.revoke("owner-2", mine.record.id, 2_000)).toBe(false);
    expect(store.rotate("owner-2", mine.record.id, 2_000)).toBeNull();
    expect(mine.record.revokedAt).toBeNull();
    const foreign = registered(store, { ownerId: "owner-2", clientKey: "other-box", label: "Other", platform: "linux" }, 1_000);
    expect(store.list("owner-1").map((row) => row.id)).toEqual([mine.record.id]);
    expect(store.list("owner-1")).not.toContainEqual(expect.objectContaining({ id: foreign.record.id }));
  });

  it("reconciles a lost provisioning response by stable identity, not a second row", () => {
    const store = registry();
    const first = registered(store, BASE, 1_000);
    // The credential response was lost; the machine retries with its key.
    const retry = registered(store, BASE, 5_000);
    expect(retry.record.id).toBe(first.record.id);
    // The retry mints a fresh one-time credential — the same outcome as an
    // explicit rotation, without ever duplicating the installation.
    expect(retry.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(retry.record.credentialHash).toBe(hashCredential(retry.credential!));
    expect(store.list("owner-1")).toHaveLength(1);
  });

  it("authenticates the credential until expiry and never after", () => {
    const store = registry();
    const { credential } = registered(store, BASE, 1_000);
    expect(store.authenticate(credential!, 2_000)?.id).toBeDefined();
    const late = 1_000 + 24 * 60 * 60_000 + 1;
    expect(store.authenticate(credential!, late)).toBeNull();
  });

  it("rotation invalidates the previous credential and keeps the identity", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    const id = created.record.id;
    const rotated = store.rotate("owner-1", id, 2_000);
    expect(rotated?.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(store.authenticate(created.credential!, 3_000)).toBeNull();
    expect(store.authenticate(rotated!.credential!, 3_000)?.id).toBe(id);
  });

  it("refresh re-mints for a proven current credential and kills the old one", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    const id = created.record.id;
    const renewed = store.refresh(id, created.credential!, 2_000);
    expect(renewed?.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(renewed?.credential).not.toBe(created.credential);
    expect(renewed?.record.id).toBe(id);
    expect(store.authenticate(created.credential!, 3_000)).toBeNull();
    expect(store.authenticate(renewed!.credential!, 3_000)?.id).toBe(id);
  });

  it("an expired credential refreshes nothing, and a revoked row is unreachable to refresh", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    const id = created.record.id;
    const late = 1_000 + 24 * 60 * 60_000 + 1;
    expect(store.refresh(id, created.credential!, late)).toBeNull();
    store.revoke("owner-1", id, 2_000);
    expect(store.refresh(id, created.credential!, 3_000)).toBeNull();
  });

  it("revocation is durable: a restart (fresh registry) cannot resurrect it", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    expect(store.revoke("owner-1", created.record.id, 2_000)).toBe(true);
    expect(store.authenticate(created.credential!, 3_000)).toBeNull();
    // A brand-new instance over the same file re-reads the revocation.
    const restarted = registry();
    expect(restarted.authenticate(created.credential!, 4_000)).toBeNull();
    // Re-registering the same machine is a NEW installation, never a
    // resurrection of the revoked row.
    const again = registered(restarted, BASE, 5_000);
    expect(again.record.id).not.toBe(created.record.id);
    expect(again.reactivated).toBe(false);
    expect(restarted.list("owner-1")).toHaveLength(2);
    // SAFETY: the registry file is written by this module's own save() with
    // a fixed top-level shape {version, installations}; the test asserts the
    // persisted revocation stamp inside it.
    const rows = JSON.parse(readFileSync(registryPathFor(directory), "utf8")) as { installations: Array<{ id: string; revokedAt: number | null }> };
    expect(rows.installations.find((row) => row.id === created.record.id)?.revokedAt).toBe(2_000);
  });

  it("a missing or corrupt file reads as empty authority", () => {
    const store = registry();
    expect(store.list("owner-1")).toEqual([]);
    writeFileSync(join(directory, "installation-registry.json"), "{ not json");
    expect(new InstallationRegistry(registryPathFor(directory)).list("owner-1")).toEqual([]);
  });

  it("keeps the table bounded under a registration loop", () => {
    const store = registry();
    for (let index = 0; index < 300; index += 1) {
      registered(store, { ...BASE, clientKey: `machine-${index}` }, 1_000 + index);
    }
    expect(JSON.parse(readFileSync(registryPathFor(directory), "utf8"))).toMatchObject({ version: 1 });
    expect(store.list("owner-1").length).toBeLessThanOrEqual(256);
  });
});

/** Durable generation boundary. The whole point of these cases is that the
 * generation survives the PROCESS, not just a call: a transition opened
 * before a restart must still be refusable after it. Every case below
 * therefore builds a fresh `InstallationRegistry` over the same file rather
 * than reusing one instance, because a single instance would pass even if the
 * value lived in a private field — which is exactly the shape of
 * `installation-consumer`'s process-local `epoch` that must never be reused
 * here. A test that cannot fail for the wrong reason is not evidence. */
describe("durable installation generation", () => {
  it("mints a first generation for an active row", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    expect(store.beginTransition(created.record.id, 1_100)?.generation).toBe(1);
    // Monotonic: each begin moves strictly forward.
    expect(store.beginTransition(created.record.id, 1_200)?.generation).toBe(2);
    expect(store.beginTransition(created.record.id, 1_300)?.generation).toBe(3);
  });

  it("a generation survives a restart, so a pre-restart transition stays refusable", () => {
    const first = registry();
    const created = registered(first, BASE, 1_000);
    const opened = first.beginTransition(created.record.id, 1_100);
    expect(opened?.generation).toBe(1);

    // A brand-new instance over the same file. If the generation were only
    // in memory this would read 1 again and the stale commit below would win.
    const restarted = registry();
    expect(restarted.beginTransition(created.record.id, 2_000)?.generation).toBe(2);
    expect(restarted.commitTransition(created.record.id, opened!.generation, () => {})).toBe(false);
    expect(restarted.commitTransition(created.record.id, 2, () => {})).toBe(true);
  });

  it("a refused commit does not advance the generation", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    const opened = store.beginTransition(created.record.id, 1_100);
    expect(opened?.generation).toBe(1);
    expect(store.commitTransition(created.record.id, 99, () => {})).toBe(false);
    expect(store.commitTransition(created.record.id, 0, () => {})).toBe(false);
    // The next minted generation is 2, not 3: nothing was consumed.
    expect(store.beginTransition(created.record.id, 1_400)?.generation).toBe(2);
  });

  it("only the current generation's commit applies, and only its own edit", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    const first = store.beginTransition(created.record.id, 1_100)!;
    const second = store.beginTransition(created.record.id, 1_200)!;
    let applied = false;
    expect(store.commitTransition(created.record.id, first.generation, () => { applied = true; })).toBe(false);
    expect(applied).toBe(false);
    expect(store.commitTransition(created.record.id, second.generation, () => { applied = true; })).toBe(true);
    expect(applied).toBe(true);
  });

  it("a refused commit writes nothing at all, even when the edit would have thrown", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    const opened = store.beginTransition(created.record.id, 1_100)!;
    store.beginTransition(created.record.id, 1_200);
    const before = readFileSync(registryPathFor(directory), "utf8");
    expect(store.commitTransition(created.record.id, opened.generation, () => { throw new Error("must not run"); })).toBe(false);
    expect(readFileSync(registryPathFor(directory), "utf8")).toBe(before);
  });

  it("a revoked row admits no transition, before or after a restart", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    expect(store.revoke("owner-1", created.record.id, 1_100)).toBe(true);
    expect(store.beginTransition(created.record.id, 1_200)).toBeNull();
    expect(registry().beginTransition(created.record.id, 1_300)).toBeNull();
    expect(store.commitTransition(created.record.id, 1, () => {})).toBe(false);
  });

  it("an unknown installation mints and commits nothing", () => {
    const store = registry();
    expect(store.beginTransition("no-such-installation", 1_000)).toBeNull();
    expect(store.commitTransition("no-such-installation", 1, () => {})).toBe(false);
    expect(store.list("owner-1")).toEqual([]);
  });

  it("two registries over separate files count independently and never compare", () => {
    const other = mkdtempSync(join(tmpdir(), "muster-installation-other-"));
    try {
      const mine = registry();
      const theirs = new InstallationRegistry(registryPathFor(other));
      const a = registered(mine, BASE, 1_000);
      const b = registered(theirs, { ...BASE, ownerId: "owner-2" }, 1_000);
      // Both start at 1. That is two unrelated counters, not a shared one:
      // each file advances on its own and neither can commit against the other.
      expect(mine.beginTransition(a.record.id, 1_100)?.generation).toBe(1);
      expect(theirs.beginTransition(b.record.id, 1_100)?.generation).toBe(1);
      expect(mine.beginTransition(a.record.id, 1_200)?.generation).toBe(2);
      // The other file's row is untouched by my second mint.
      expect(theirs.commitTransition(b.record.id, 1, () => {})).toBe(true);
      expect(theirs.beginTransition(b.record.id, 1_300)?.generation).toBe(2);
      // A generation from one file is not a generation of the other.
      expect(mine.commitTransition(b.record.id, 2, () => {})).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("a legacy registry file with no generation still reads, and starts at 1", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    // Rewrite the file the way a pre-generation build wrote it: the row with
    // no `generation` key at all. This must not read as corrupt (which would
    // silently drop every existing installation) and must not read as
    // adopting some arbitrary stored value.
    const path = registryPathFor(directory);
    // SAFETY: the registry file is written by this module's own persist() with
    // a fixed top-level shape {version, installations}; the assertion names
    // only the field these cases remove.
    const legacy = JSON.parse(readFileSync(path, "utf8")) as { installations: Array<{ generation?: number | null }> };
    for (const row of legacy.installations) delete row.generation;
    writeFileSync(path, JSON.stringify(legacy, null, 2));

    const reopened = registry();
    expect(reopened.list("owner-1")).toHaveLength(1);
    expect(reopened.authenticate(created.credential!, 2_000)).not.toBeNull();
    expect(reopened.beginTransition(created.record.id, 2_100)?.generation).toBe(1);
    expect(reopened.commitTransition(created.record.id, 0, () => {})).toBe(false);
  });

  it("a corrupt generation fails closed rather than resetting the counter", () => {
    const store = registry();
    const created = registered(store, BASE, 1_000);
    expect(store.beginTransition(created.record.id, 1_100)?.generation).toBe(1);
    const path = registryPathFor(directory);
    // SAFETY: same fixed {version, installations} shape written by persist();
    // the assertion names the field deliberately corrupted below. It is
    // written as a widened string on purpose, which is the whole point of the
    // case: the loader must reject it, not coerce it back to 0.
    const tampered = JSON.parse(readFileSync(path, "utf8")) as { installations: Array<{ generation: string }> };
    tampered.installations[0].generation = "two";
    writeFileSync(path, JSON.stringify(tampered, null, 2));
    // A row whose generation cannot be read is not silently treated as 0,
    // which would re-admit an already-consumed generation.
    expect(registry().beginTransition(created.record.id, 2_000)).toBeNull();
  });
});
