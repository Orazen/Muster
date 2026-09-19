import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
const consentRowSchema = z.object({ enabled: z.union([z.literal(0), z.literal(1)]), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export interface ProviderFallbackConsent { enabled: boolean; generation: number }

function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_fallback_consent (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    generation INTEGER NOT NULL CHECK(generation > 0)
  )`);
}
function validateUser(userId: string): void {
  if (!z.string().min(1).max(1024).safeParse(userId).success) throw new Error("Invalid fallback consent account");
}

/** An absent account choice is always off; operator settings cannot grant consent. */
export function getProviderFallbackConsent(db: DatabaseSync, userId: string): ProviderFallbackConsent {
  validateUser(userId);
  initialize(db);
  const row = db.prepare("SELECT enabled, generation FROM provider_fallback_consent WHERE userId = ?").get(userId);
  if (!row) return { enabled: false, generation: 0 };
  const parsed = consentRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error("Invalid fallback consent record");
  }
  return { enabled: parsed.data.enabled === 1, generation: parsed.data.generation };
}

/** Every explicit choice invalidates snapshots, including disable followed by re-enable. */
export function setProviderFallbackConsent(db: DatabaseSync, userId: string, enabled: boolean): ProviderFallbackConsent {
  validateUser(userId);
  if (!z.boolean().safeParse(enabled).success) throw new Error("Invalid fallback consent choice");
  initialize(db);
  const row = db.prepare(`INSERT INTO provider_fallback_consent (userId, enabled, generation) VALUES (?, ?, 1)
    ON CONFLICT(userId) DO UPDATE SET enabled = excluded.enabled, generation = generation + 1
    WHERE generation < 9007199254740991 RETURNING enabled, generation`).get(userId, enabled ? 1 : 0);
  if (!row) throw new Error("Fallback consent generation exhausted");
  return { enabled: row.enabled === 1, generation: Number(row.generation) };
}

export function isProviderFallbackConsentCurrent(db: DatabaseSync, userId: string, generation: number): boolean {
  const current = getProviderFallbackConsent(db, userId);
  return current.enabled && current.generation === generation;
}
