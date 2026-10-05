// Explicit capture of actual non-secret UI preferences. The host resolves a
// live authenticated account/workspace; this module never trusts request IDs,
// reads installation config, migrates auth tables, or invents an empty capture.
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { FollowUpAccount } from "./follow-up-identity.ts";
import { buildSettingsDocument, parseVisibleFile, projectSettings, renderDocument, SETTINGS_ALLOWLIST } from "./drive-visible.ts";

type SettingValue = string | number | boolean | null;
const MAX_CAPTURE_BYTES = 16 * 1024;
const MAX_OFFERED_KEYS = 64;
const id = z.string().min(1).max(200);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const accountSchema = z.object({ userId: id, sessionId: id, workspaceId: id, isPrimary: z.boolean() });
const settingsSchema = z.record(z.string().min(1).max(200), z.union([
  z.string().max(4_000), z.number().finite(), z.boolean(), z.null(),
])).refine(values => Object.keys(values).length <= MAX_OFFERED_KEYS
  && Buffer.byteLength(JSON.stringify(values)) <= MAX_CAPTURE_BYTES);
const rowSchema = z.object({
  userId: id, workspaceId: id, capturedAt: timestamp, document: z.string().max(MAX_CAPTURE_BYTES),
});
const allowed = new Set<string>(SETTINGS_ALLOWLIST);

/** Structurally matches the B source port. Values are an explicit capture of
 * current browser preferences, not proof of authorization on their own. */
export interface AccountSettingsSnapshot {
  readonly userId: string;
  readonly workspaceId: string;
  readonly values: Readonly<Record<string, SettingValue>>;
}
export interface AccountSettingsCapture {
  snapshot: AccountSettingsSnapshot;
  droppedSettings: string[];
  capturedAt: number;
}

function invalid(): never { throw new Error("Invalid visible Drive preference capture."); }

/** No table creation, schema initialization, fallback config, or mutation.
 * Missing/corrupt state remains unavailable rather than successful emptiness. */
export function readAccountSettings(db: DatabaseSync, account: FollowUpAccount): AccountSettingsSnapshot | null {
  const bound = accountSchema.safeParse(account);
  if (!bound.success) return null;
  try {
    const row = rowSchema.safeParse(db.prepare(`SELECT userId, workspaceId, capturedAt, document
      FROM drive_visible_settings WHERE userId = ? AND workspaceId = ?`).get(bound.data.userId, bound.data.workspaceId));
    if (!row.success || row.data.userId !== bound.data.userId || row.data.workspaceId !== bound.data.workspaceId
      || Buffer.byteLength(row.data.document) > MAX_CAPTURE_BYTES) return null;
    const parsed = parseVisibleFile("settings", row.data.document);
    if (!parsed.ok || parsed.document.kind !== "settings") return null;
    const values = settingsSchema.safeParse(parsed.document.settings);
    if (!values.success || Object.keys(values.data).some(key => !allowed.has(key))) return null;
    // The parser's deliberate unknown-key stripping must not hide damaged
    // persisted capture rows. This writer only stores its canonical document.
    const canonical = renderDocument("settings", buildSettingsDocument(projectSettings(values.data).settings));
    if (canonical !== row.data.document) return null;
    return { userId: bound.data.userId, workspaceId: bound.data.workspaceId, values: values.data };
  } catch { return null; }
}

/** Only an explicit authenticated capture creates this module's own table.
 * The existing user/organization tables and other workspace data stay intact.
 * Validation finishes before DDL; failure rolls back the exact capture. */
export function captureAccountSettings(
  db: DatabaseSync,
  account: FollowUpAccount,
  offered: Readonly<Record<string, SettingValue>>,
  now = Date.now(),
): AccountSettingsCapture {
  const bound = accountSchema.safeParse(account);
  const values = settingsSchema.safeParse(offered);
  const capturedAt = timestamp.safeParse(now);
  if (!bound.success || !values.success || !capturedAt.success) invalid();
  let projection: ReturnType<typeof projectSettings>;
  try { projection = projectSettings(values.data); }
  catch { invalid(); }
  const document = renderDocument("settings", buildSettingsDocument(projection.settings));
  const verified = parseVisibleFile("settings", document);
  if (!verified.ok || verified.document.kind !== "settings" || Buffer.byteLength(document) > MAX_CAPTURE_BYTES) invalid();
  const snapshot = { userId: bound.data.userId, workspaceId: bound.data.workspaceId, values: { ...verified.document.settings } };
  db.exec("SAVEPOINT drive_visible_settings_capture");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS drive_visible_settings (
      userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      workspaceId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      capturedAt INTEGER NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY(userId, workspaceId)
    )`);
    db.prepare(`INSERT INTO drive_visible_settings(userId, workspaceId, capturedAt, document) VALUES (?, ?, ?, ?)
      ON CONFLICT(userId, workspaceId) DO UPDATE SET capturedAt = excluded.capturedAt, document = excluded.document`)
      .run(snapshot.userId, snapshot.workspaceId, capturedAt.data, document);
    db.exec("RELEASE drive_visible_settings_capture");
  } catch {
    db.exec("ROLLBACK TO drive_visible_settings_capture; RELEASE drive_visible_settings_capture");
    throw new Error("Visible Drive preference capture unavailable.");
  }
  return { snapshot, droppedSettings: projection.dropped, capturedAt: capturedAt.data };
}
