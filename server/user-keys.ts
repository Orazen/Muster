// Per-user credential vault — cloud deployments only.
//
// Each signed-in account stores its own provider API keys, encrypted at rest
// with AES-256-GCM under a key derived (scrypt) from the deployment's auth
// secret. Keys never leave the server unencrypted; readers get only
// configured-flags, never values.
//
// The scrypt salt is RANDOM PER FILE, not the fixed string this module once
// used: a salt baked into the source lets anyone with the (public) repo
// precompute scrypt tables against weak BETTER_AUTH_SECRET choices. New
// vaults and every mutating write carry a per-file salt (version 2); v1
// files are re-sealed under their own salt on the next mutating write, and
// entries that no longer open — already dead to every reader — are dropped.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";

const userKeyEntrySchema = z.object({ sealed: z.string(), updatedAt: z.number() });
export type UserKeyEntry = z.infer<typeof userKeyEntrySchema>;

const vaultHeaderSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), salt: z.string().optional() }),
  z.object({ version: z.literal(2), salt: z.string().min(1) }),
]);
const objectSchema = z.record(z.string(), z.unknown());
const missingFileError = z.object({ code: z.literal("ENOENT") });
type VaultFile = z.infer<typeof vaultHeaderSchema> & { users: Record<string, Record<string, UserKeyEntry>> };
type SaltedVault = Extract<VaultFile, { version: 2 }>;
interface LoadedVault { vault: VaultFile; writable: boolean }

function emptyUsers(): VaultFile["users"] { return Object.create(null); }
function emptyEntries(): Record<string, UserKeyEntry> { return Object.create(null); }

function ownJsonEntries(raw: JsonValue): [string, JsonValue][] | null {
  if (!objectSchema.safeParse(raw).success) return null;
  // SAFETY: parseJson produces only JSON values, and objectSchema excludes
  // primitives/null/arrays. Read the original own entries because Zod's
  // record output deliberately strips an own key named __proto__.
  return Object.entries(raw as JsonObject);
}

/** The v1 salt — kept so pre-migration files (and the one-arg seal/open
 * below) keep opening until the next write migrates them. */
const LEGACY_SALT = "muster-user-keys-v1";

/** scrypt is deliberately expensive; deployments hold at most the legacy
 * key plus the current file's salt, but merge/migration paths can touch a
 * second file's salt in one process. */
const KEY_CACHE_MAX = 4;
const cachedKeys = new Map<string, Buffer>();

/** Derive the AES key for one salt, memoized per process. */
function keyFor(salt: string): Buffer {
  let key = cachedKeys.get(salt);
  if (!key) {
    key = scryptSync(process.env.BETTER_AUTH_SECRET ?? "", salt, 32);
    if (cachedKeys.size >= KEY_CACHE_MAX) {
      const oldest = cachedKeys.keys().next().value;
      if (oldest !== undefined) cachedKeys.delete(oldest);
    }
    cachedKeys.set(salt, key);
  }
  return key;
}

function sealWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${enc.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

function openWith(key: Buffer, sealed: string): string | null {
  const [ivB64, dataB64, tagB64] = sealed.split(":");
  if (!ivB64 || !dataB64 || !tagB64) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong key or tampered — treat as absent, never throw
  }
}

/** Legacy-key forms: the vault's own writes always go through the file's
 * salt (sealWith under keyFor(vault.salt)). These remain for callers that
 * seal values OUTSIDE a vault file — and for the tests. */
export function seal(plaintext: string): string {
  return sealWith(keyFor(LEGACY_SALT), plaintext);
}

export function open(sealed: string): string | null {
  return openWith(keyFor(LEGACY_SALT), sealed);
}

const newSalt = () => randomBytes(16).toString("base64");

function vaultPath(dataDir: string): string {
  return join(dataDir, "user-keys.json");
}

function emptyVault(writable: boolean): LoadedVault {
  return { vault: { version: 2, salt: newSalt(), users: emptyUsers() }, writable };
}

function loadVault(dataDir: string): LoadedVault {
  const p = vaultPath(dataDir);
  try {
    const rootEntries = ownJsonEntries(parseJson(readFileSync(p, "utf8")));
    if (!rootEntries) return emptyVault(false);
    const root = Object.fromEntries(rootEntries);
    const header = vaultHeaderSchema.safeParse(root);
    const accountEntries = ownJsonEntries(root.users ?? null);
    if (!header.success || !accountEntries) return emptyVault(false);
    const users = emptyUsers();
    let writable = true;
    for (const [userId, rawEntries] of accountEntries) {
      const providerEntries = ownJsonEntries(rawEntries);
      if (!providerEntries) { writable = false; continue; }
      const entries = emptyEntries();
      for (const [providerId, rawEntry] of providerEntries) {
        const entry = userKeyEntrySchema.safeParse(rawEntry);
        if (!entry.success) { writable = false; continue; }
        entries[providerId] = entry.data;
      }
      users[userId] = entries;
    }
    return { vault: { ...header.data, users }, writable };
  } catch (error) {
    return emptyVault(missingFileError.safeParse(error).success);
  }
}

function loadWritableVault(dataDir: string): VaultFile {
  const loaded = loadVault(dataDir);
  // A damaged entry can contain recoverable ciphertext. Readers may use the
  // valid neighbors, but a normal key update must never discard that data.
  if (!loaded.writable) throw new Error("Provider key vault needs repair before changes can be saved.");
  return loaded.vault;
}

/** Re-seal every entry under a fresh per-file salt (v1 → v2). Entries that
 * no longer open were already dead to every reader — resolveUserProviderKey
 * returned null and instance configs skipped them — so dropping them loses
 * nothing functional. Migration happens on MUTATING writes only; readers
 * never rewrite the file. */
function withSalt(vault: VaultFile): SaltedVault {
  if (vault.version === 2) return vault;
  const salt = newSalt();
  const fresh = keyFor(salt);
  const legacy = keyFor(LEGACY_SALT);
  const users = emptyUsers();
  let dropped = 0;
  for (const [userId, entries] of Object.entries(vault.users)) {
    const resealed = emptyEntries();
    for (const [providerId, entry] of Object.entries(entries)) {
      const plaintext = openWith(legacy, entry.sealed);
      if (plaintext === null) {
        dropped++;
        continue;
      }
      resealed[providerId] = { sealed: sealWith(fresh, plaintext), updatedAt: entry.updatedAt };
    }
    if (Object.keys(resealed).length > 0) users[userId] = resealed;
  }
  if (dropped > 0) console.warn(`user-keys: salt migration dropped ${dropped} unreadable vault entry(ies)`);
  return { version: 2, salt, users };
}

function saveVault(dataDir: string, vault: VaultFile): void {
  const p = vaultPath(dataDir);
  // 0600 like config.json: the ciphertext is only as strong as the secret
  // beside it, and on desktop installs BETTER_AUTH_SECRET sits in the same
  // directory — a world-readable vault would hand both to any local process.
  writeFileAtomic(p, JSON.stringify(vault), { mode: 0o600 });
}

/** Store one provider key for a user. Overwrites silently. */
export function setUserProviderKey(cfgDataDir: string, userId: string, providerId: string, apiKey: string): void {
  const vault = withSalt(loadWritableVault(cfgDataDir));
  vault.users[userId] ??= emptyEntries();
  vault.users[userId][providerId] = {
    sealed: sealWith(keyFor(vault.salt), apiKey),
    updatedAt: Date.now(),
  };
  saveVault(cfgDataDir, vault);
}

/** Remove one provider key. A deletion re-seals nothing, so a v1 file stays
 * v1 until the next storing write migrates it. */
export function clearUserProviderKey(cfgDataDir: string, userId: string, providerId: string): void {
  const vault = loadWritableVault(cfgDataDir);
  if (vault.users[userId]) {
    delete vault.users[userId][providerId];
    saveVault(cfgDataDir, vault);
  }
}

/** Which providers has THIS user configured? Flags only — never values. */
/** Provider-configured flags keyed by provider id — flags only, no values. */
export type UserProviderFlags = Record<string, { configured: boolean }>;

export function userProviderFlags(cfgDataDir: string, userId: string) {
  const { vault } = loadVault(cfgDataDir);
  const key = keyFor(vault.salt ?? LEGACY_SALT);
  const entries = vault.users[userId] ?? emptyEntries();
  const flags: UserProviderFlags = Object.create(null);
  for (const [id, entry] of Object.entries(entries)) {
    flags[id] = { configured: Boolean(openWith(key, entry.sealed)) };
  }
  return flags;
}

/** Resolve the plaintext key for THIS user only — the single reader, used by
 * the turn-start path. Another userId's keys are structurally unreachable. */
export function resolveUserProviderKey(cfgDataDir: string, userId: string, providerId: string): string | null {
  const { vault } = loadVault(cfgDataDir);
  const entry = vault.users[userId]?.[providerId];
  if (!entry) return null;
  return openWith(keyFor(vault.salt ?? LEGACY_SALT), entry.sealed);
}

/** Per-user instance id namespace: `deepseekApi:user-a`. The suffix is the
 * isolation boundary — turn-start refuses an instance whose suffix does not
 * match the bot's owner. */
export function userInstanceId(providerId: string, userId: string): string {
  return `${providerId}Api:${userId}`;
}

export function userInstanceOwner(instanceId: string): string | null {
  const idx = instanceId.indexOf("Api:");
  return idx === -1 ? null : instanceId.slice(idx + 4);
}

/** Build registry instance configs for one user's vault keys. Instance ids
 * are user-scoped (`deepseekApi:user-a`) so ownership is checkable at
 * turn-start and users never share an engine instance. */
export function userInstanceConfigs(
  cfgDataDir: string,
  userId: string,
  driverEnv: Record<string, string>,
) {
  const { vault } = loadVault(cfgDataDir);
  const key = keyFor(vault.salt ?? LEGACY_SALT);
  const entries = vault.users[userId] ?? emptyEntries();
  // Built by assignment over known-good entries, then returned as-is so the
  // inferred record keeps its evidence (no widening annotation).
  const built = Object.entries(entries).flatMap(([providerId, entry]) => {
    const secret = openWith(key, entry.sealed);
    const envVar = Object.hasOwn(driverEnv, providerId) ? driverEnv[providerId] : undefined;
    if (!secret || !envVar) return [];
    const label = providerId.charAt(0).toUpperCase() + providerId.slice(1);
    return [[
      userInstanceId(providerId, userId),
      { driver: providerId, displayName: `${label} (your key)`, environment: { [envVar]: secret } },
    ] as const];
  });
  return Object.fromEntries(built);
}

/** Every user's configs — boot-time registration for the shared registry. */
export function allUserInstanceConfigs(
  cfgDataDir: string,
  driverEnv: Record<string, string>,
) {
  const { vault } = loadVault(cfgDataDir);
  return Object.keys(vault.users).flatMap((userId) =>
    Object.entries(userInstanceConfigs(cfgDataDir, userId, driverEnv)),
  ).reduce<Record<string, { driver: string; displayName: string; environment: Record<string, string> }>>(
    // SAFETY: the accumulator only ever receives this function's own entries.
    (acc, [id, cfg]) => {
      acc[id] = cfg;
      return acc;
    },
    {},
  );
}

/** Move every provider key from one account to another. Where both hold the
 * same provider the TARGET keeps its own value — the account the user is
 * actively using wins. The source's vault entry is removed. Returns
 * [movedProviderIds, keptProviderIds] for the UI summary. */
export function mergeUserVault(cfgDataDir: string, fromUser: string, toUser: string): [string[], string[]] {
  if (fromUser === toUser) return [[], []];
  const vault = withSalt(loadWritableVault(cfgDataDir));
  const src = vault.users[fromUser];
  if (!src) return [[], []];
  const dst = (vault.users[toUser] ??= emptyEntries());
  const moved: string[] = [];
  const kept: string[] = [];
  for (const [providerId, entry] of Object.entries(src)) {
    if (dst[providerId]) kept.push(providerId);
    else {
      dst[providerId] = entry;
      moved.push(providerId);
    }
  }
  delete vault.users[fromUser];
  saveVault(cfgDataDir, vault);
  return [moved, kept];
}
