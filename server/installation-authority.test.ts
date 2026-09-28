// Unit coverage for the stable installation authority. The report's
// falsifiable cases that live at this layer: same user-agent on two machines
// is two rows (distinct client keys); another account cannot list or revoke;
// a lost provisioning response is reconciled by stable identity; a stale
// credential cannot authenticate; a restart (fresh registry over the same
// file) cannot resurrect revoked authority. The wire behavior is pinned by
// installation-harness.test.ts.
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashCredential, InstallationRegistry, registryPathFor } from "./installation-authority.ts";

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

describe("installation authority", () => {
  it("registers an installation with a one-time credential and a stable id", () => {
    const store = registry();
    const first = store.register(BASE, 1_000);
    expect(first.reactivated).toBe(false);
    expect(first.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(first.record.id).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(first.record.capabilities).toEqual(["workspace"]);
    expect(first.record.credentialHash).toBe(hashCredential(first.credential!));
    expect(first.record.credentialExpiresAt).toBe(1_000 + 24 * 60 * 60_000);
  });

  it("is idempotent per (owner, client key): same key, same stable id, fresh secret", () => {
    const store = registry();
    const first = store.register(BASE, 1_000);
    const second = store.register(BASE, 2_000);
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
    const desk = store.register({ ...BASE, clientKey: "desk-mac-alpha" }, 1_000);
    const laptop = store.register({ ...BASE, clientKey: "laptop-mac" }, 1_000);
    expect(desk.record.id).not.toBe(laptop.record.id);
    expect(store.list("owner-1")).toHaveLength(2);
  });

  it("keeps accounts apart: another account cannot list or revoke", () => {
    const store = registry();
    const mine = store.register({ ...BASE }, 1_000);
    expect(store.revoke("owner-2", mine.record.id, 2_000)).toBe(false);
    expect(store.rotate("owner-2", mine.record.id, 2_000)).toBeNull();
    expect(mine.record.revokedAt).toBeNull();
    const foreign = store.register({ ownerId: "owner-2", clientKey: "other-box", label: "Other", platform: "linux" }, 1_000);
    expect(store.list("owner-1").map((row) => row.id)).toEqual([mine.record.id]);
    expect(store.list("owner-1")).not.toContainEqual(expect.objectContaining({ id: foreign.record.id }));
  });

  it("reconciles a lost provisioning response by stable identity, not a second row", () => {
    const store = registry();
    const first = store.register(BASE, 1_000);
    // The credential response was lost; the machine retries with its key.
    const retry = store.register(BASE, 5_000);
    expect(retry.record.id).toBe(first.record.id);
    // The retry mints a fresh one-time credential — the same outcome as an
    // explicit rotation, without ever duplicating the installation.
    expect(retry.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(retry.record.credentialHash).toBe(hashCredential(retry.credential!));
    expect(store.list("owner-1")).toHaveLength(1);
  });

  it("authenticates the credential until expiry and never after", () => {
    const store = registry();
    const { credential } = store.register(BASE, 1_000);
    expect(store.authenticate(credential!, 2_000)?.id).toBeDefined();
    const late = 1_000 + 24 * 60 * 60_000 + 1;
    expect(store.authenticate(credential!, late)).toBeNull();
  });

  it("rotation invalidates the previous credential and keeps the identity", () => {
    const store = registry();
    const created = store.register(BASE, 1_000);
    const id = created.record.id;
    const rotated = store.rotate("owner-1", id, 2_000);
    expect(rotated?.credential).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(store.authenticate(created.credential!, 3_000)).toBeNull();
    expect(store.authenticate(rotated!.credential!, 3_000)?.id).toBe(id);
  });

  it("refresh re-mints for a proven current credential and kills the old one", () => {
    const store = registry();
    const created = store.register(BASE, 1_000);
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
    const created = store.register(BASE, 1_000);
    const id = created.record.id;
    const late = 1_000 + 24 * 60 * 60_000 + 1;
    expect(store.refresh(id, created.credential!, late)).toBeNull();
    store.revoke("owner-1", id, 2_000);
    expect(store.refresh(id, created.credential!, 3_000)).toBeNull();
  });

  it("revocation is durable: a restart (fresh registry) cannot resurrect it", () => {
    const store = registry();
    const created = store.register(BASE, 1_000);
    expect(store.revoke("owner-1", created.record.id, 2_000)).toBe(true);
    expect(store.authenticate(created.credential!, 3_000)).toBeNull();
    // A brand-new instance over the same file re-reads the revocation.
    const restarted = registry();
    expect(restarted.authenticate(created.credential!, 4_000)).toBeNull();
    // Re-registering the same machine is a NEW installation, never a
    // resurrection of the revoked row.
    const again = restarted.register(BASE, 5_000);
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
      store.register({ ...BASE, clientKey: `machine-${index}` }, 1_000 + index);
    }
    expect(JSON.parse(readFileSync(registryPathFor(directory), "utf8"))).toMatchObject({ version: 1 });
    expect(store.list("owner-1").length).toBeLessThanOrEqual(256);
  });
});
