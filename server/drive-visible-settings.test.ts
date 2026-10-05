import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureAccountSettings, readAccountSettings } from "./drive-visible-settings.ts";
import { parseVisibleFile } from "./drive-visible.ts";

const alice = { userId: "alice", sessionId: "alice-session", workspaceId: "org-one", isPrimary: false };
const bob = { userId: "bob", sessionId: "bob-session", workspaceId: "org-two", isPrimary: false };
const otherWorkspace = { ...alice, workspaceId: "org-two" };
const invalidCaptures: Array<Parameters<typeof captureAccountSettings>[2]> = [
  { accessToken: "SYNTHETIC-TOKEN" }, { refreshToken: "SYNTHETIC-TOKEN" },
  { theme: "x".repeat(4_001) }, { notifications: Infinity }, { density: NaN },
  Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`unknown-${index}`, "x"])),
  { theme: "x".repeat(4_000), locale: "x".repeat(4_000), timezone: "x".repeat(4_000), density: "x".repeat(4_000), startupView: "x".repeat(4_000) },
];
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY);
    INSERT INTO user VALUES ('alice'), ('bob'); INSERT INTO organization VALUES ('org-one'), ('org-two');
    CREATE TABLE unaffected(value TEXT); INSERT INTO unaffected VALUES ('keep');`);
});
afterEach(() => db.close());

const rows = () => db.prepare("SELECT * FROM drive_visible_settings ORDER BY userId, workspaceId").all();
const tables = () => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();

describe("explicit account/workspace preference capture", () => {
  it("reads uncaptured state as unavailable without creating its table", () => {
    const before = tables();
    expect(readAccountSettings(db, alice)).toBeNull();
    expect(tables()).toEqual(before);
    expect(db.prepare("SELECT * FROM unaffected").all()).toEqual([{ value: "keep" }]);
  });

  it("creates only its own table on explicit capture and validates through the real parser", () => {
    const before = tables().map(row => row.name);
    const captured = captureAccountSettings(db, alice, { theme: "dark", density: "compact", reduceMotion: true }, 100);
    expect(captured).toEqual({ snapshot: { userId: "alice", workspaceId: "org-one", values: { theme: "dark", density: "compact", reduceMotion: true } },
      droppedSettings: [], capturedAt: 100 });
    expect(readAccountSettings(db, alice)).toEqual(captured.snapshot);
    expect(tables().map(row => row.name).filter(name => !before.includes(name))).toEqual(["drive_visible_settings", "sqlite_autoindex_drive_visible_settings_1"]);
    const document = String(rows()[0]?.document);
    expect(parseVisibleFile("settings", document)).toMatchObject({ ok: true, document: { kind: "settings", settings: captured.snapshot.values } });
  });

  it("isolates two accounts and two workspaces even when the primary operator reads", () => {
    captureAccountSettings(db, alice, { theme: "dark" }, 1);
    captureAccountSettings(db, bob, { theme: "light" }, 2);
    captureAccountSettings(db, otherWorkspace, { density: "compact" }, 3);
    expect(readAccountSettings(db, alice)?.values).toEqual({ theme: "dark" });
    expect(readAccountSettings(db, bob)?.values).toEqual({ theme: "light" });
    expect(readAccountSettings(db, otherWorkspace)?.values).toEqual({ density: "compact" });
    expect(readAccountSettings(db, { ...alice, isPrimary: true })?.values).toEqual({ theme: "dark" });
    expect(readAccountSettings(db, { ...bob, workspaceId: "org-one" })).toBeNull();
  });

  it("reports unknown keys but never persists their values", () => {
    const result = captureAccountSettings(db, alice, { theme: "dark", privateUnrecognizedPreference: "PRIVATE-DO-NOT-PERSIST" }, 1);
    expect(result.droppedSettings).toEqual(["privateUnrecognizedPreference"]);
    expect(readAccountSettings(db, alice)?.values).toEqual({ theme: "dark" });
    expect(JSON.stringify(rows())).not.toContain("PRIVATE-DO-NOT-PERSIST");
    expect(JSON.stringify(rows())).not.toContain("privateUnrecognizedPreference");
  });

  it("distinguishes explicit empty capture from no capture", () => {
    expect(readAccountSettings(db, alice)).toBeNull();
    captureAccountSettings(db, alice, {}, 0);
    expect(readAccountSettings(db, alice)).toEqual({ userId: "alice", workspaceId: "org-one", values: {} });
  });

  it("updates only the captured account/workspace and preserves unrelated data", () => {
    captureAccountSettings(db, alice, { theme: "dark" }, 1);
    captureAccountSettings(db, bob, { theme: "light" }, 2);
    const heldBob = rows().find(row => row.userId === "bob");
    captureAccountSettings(db, alice, { theme: "new", notifications: false }, 3);
    expect(readAccountSettings(db, alice)?.values).toEqual({ theme: "new", notifications: false });
    expect(rows().find(row => row.userId === "bob")).toEqual(heldBob);
    expect(db.prepare("SELECT value FROM unaffected").get()?.value).toBe("keep");
  });

  it.each(invalidCaptures)("rejects invalid or oversized capture before schema mutation %#", offered => {
    const before = tables();
    expect(() => captureAccountSettings(db, alice, offered, 1)).toThrow("Invalid visible Drive preference capture.");
    expect(tables()).toEqual(before);
  });

  it("rejects malformed runtime input at the boundary without exposing offered values", () => {
    // Deliberately bypass the TypeScript caller through JSON-shaped input.
    const malformed = JSON.parse('{"theme":{"nested":"PRIVATE"}}');
    expect(() => captureAccountSettings(db, alice, malformed, 1)).toThrow("Invalid visible Drive preference capture.");
    expect(tables().some(row => row.name === "drive_visible_settings")).toBe(false);
  });

  it.each([-1, Infinity, NaN, 1.5])("rejects invalid capture time %s", now => {
    expect(() => captureAccountSettings(db, alice, { theme: "dark" }, now)).toThrow();
    expect(readAccountSettings(db, alice)).toBeNull();
  });

  it("rejects invalid authority and never treats a request identity as primary authority", () => {
    expect(() => captureAccountSettings(db, { ...alice, sessionId: "" }, { theme: "dark" })).toThrow();
    expect(readAccountSettings(db, { ...alice, userId: "" })).toBeNull();
    expect(tables().some(row => row.name === "drive_visible_settings")).toBe(false);
  });

  it("rolls back a failed replacement and retains the previous usable capture", () => {
    captureAccountSettings(db, alice, { theme: "dark" }, 1);
    const before = rows();
    db.exec(`CREATE TRIGGER reject_capture BEFORE UPDATE ON drive_visible_settings BEGIN SELECT RAISE(ABORT, 'test-owned rejection'); END`);
    expect(() => captureAccountSettings(db, alice, { theme: "new" }, 2)).toThrow("Visible Drive preference capture unavailable.");
    expect(rows()).toEqual(before);
    expect(readAccountSettings(db, alice)?.values).toEqual({ theme: "dark" });
  });

  it("rolls back new schema creation when the authenticated foreign-key subject disappeared", () => {
    db.prepare("DELETE FROM user WHERE id = ?").run("alice");
    expect(() => captureAccountSettings(db, alice, { theme: "dark" }, 1)).toThrow();
    expect(tables().some(row => row.name === "drive_visible_settings")).toBe(false);
  });

  it.each(["not JSON", '{"schemaVersion":2,"kind":"settings","settings":{}}',
    '{"schemaVersion":1,"kind":"settings","settings":{"accessToken":"PRIVATE"}}',
    '{"schemaVersion":1,"kind":"settings","settings":{"unknown":"PRIVATE"}}',
    '{"schemaVersion":1,"kind":"settings","settings":{},"unexpected":"PRIVATE"}',
    "x".repeat(16 * 1024 + 1),
  ])("refuses corrupt/noncanonical stored captures without repairing or deleting %#", document => {
    captureAccountSettings(db, alice, { theme: "dark" }, 1);
    db.prepare("UPDATE drive_visible_settings SET document = ? WHERE userId = ?").run(document, "alice");
    const before = rows(); const schema = tables();
    expect(readAccountSettings(db, alice)).toBeNull();
    expect(rows()).toEqual(before); expect(tables()).toEqual(schema);
  });

  it("returns defensive values and keeps read-only database bytes/inode/mtime unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "muster-drive-settings-"));
    const file = join(directory, "capture.db");
    const disk = new DatabaseSync(file);
    try {
      disk.exec("CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'); INSERT INTO organization VALUES ('org-one');");
      captureAccountSettings(disk, alice, { theme: "dark" }, 1);
      const before = readFileSync(file); const metadata = statSync(file);
      const first = readAccountSettings(disk, alice);
      expect(first).toEqual({ userId: "alice", workspaceId: "org-one", values: { theme: "dark" } });
      if (!first) throw new Error("Expected explicit capture");
      // A caller may clone/change its returned value, never the stored row.
      const changed = { ...first.values, theme: "mutated output" };
      expect(changed.theme).toBe("mutated output");
      expect(readAccountSettings(disk, alice)?.values).toEqual({ theme: "dark" });
      expect(readFileSync(file)).toEqual(before); expect(statSync(file).ino).toBe(metadata.ino);
      expect(statSync(file).mtimeMs).toBe(metadata.mtimeMs);
    } finally { disk.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
