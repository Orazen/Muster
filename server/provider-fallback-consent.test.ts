import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderFallbackConsent as get, setProviderFallbackConsent as set, isProviderFallbackConsentCurrent as current } from "./provider-fallback-consent.ts";
let db: DatabaseSync;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muster-fallback-"));
  db = new DatabaseSync(join(dir, "auth.db"));
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
it("defaults off and isolates account choices", () => {
  expect(get(db, "alice")).toEqual({ enabled: false, generation: 0 });
  expect(current(db, "alice", 0)).toBe(false);
  expect(set(db, "alice", true)).toEqual({ enabled: true, generation: 1 });
  expect(get(db, "bob")).toEqual({ enabled: false, generation: 0 });
});
it("invalidates in-flight consent across revoke and re-enable", () => {
  const snapshot = set(db, "alice", true);
  expect(current(db, "alice", snapshot.generation)).toBe(true);
  set(db, "alice", false);
  expect(current(db, "alice", snapshot.generation)).toBe(false);
  const renewed = set(db, "alice", true);
  expect(renewed.generation).toBe(3);
  expect(current(db, "alice", snapshot.generation)).toBe(false);
  expect(current(db, "alice", renewed.generation)).toBe(true);
});
it("persists choice and generation across reopening the auth database", () => {
  set(db, "alice", true); set(db, "alice", false);
  db.close(); db = new DatabaseSync(join(dir, "auth.db"));
  expect(get(db, "alice")).toEqual({ enabled: false, generation: 2 });
});
it("removes consent with its owning account", () => {
  set(db, "alice", true);
  db.prepare("DELETE FROM user WHERE id = ?").run("alice");
  expect(get(db, "alice").enabled).toBe(false);
});
it("rejects unknown accounts and invalid identities", () => {
  expect(() => set(db, "stranger", true)).toThrow();
  expect(() => get(db, "")).toThrow();
});
