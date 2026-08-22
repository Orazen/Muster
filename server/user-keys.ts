// Per-user credential vault — cloud deployments only.
//
// Each signed-in account stores its own provider API keys, encrypted at rest
// with AES-256-GCM under a key derived (scrypt) from the deployment's auth
// secret. Keys never leave the server unencrypted; readers get only
// configured-flags, never values.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

export interface UserKeyEntry {
  /** base64 iv:ciphertext:authTag */
  sealed: string;
  updatedAt: number;
}

interface VaultFile {
  version: 1;
  users: Record<string, Record<string, UserKeyEntry>>;
}

let cachedKey: Buffer | null = null;

/** Derive the AES master key once per process from the deployment secret. */
function masterKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(process.env.BETTER_AUTH_SECRET ?? "", "muster-user-keys-v1", 32);
  }
  return cachedKey;
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${enc.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

export function open(sealed: string): string | null {
  const [ivB64, dataB64, tagB64] = sealed.split(":");
  if (!ivB64 || !dataB64 || !tagB64) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong key or tampered — treat as absent, never throw
  }
}

function vaultPath(dataDir: string): string {
  return join(dataDir, "user-keys.json");
}

function loadVault(dataDir: string): VaultFile {
  const p = vaultPath(dataDir);
  if (!existsSync(p)) return { version: 1, users: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as VaultFile;
    if (parsed.version !== 1 || typeof parsed.users !== "object") throw new Error("bad shape");
    return parsed;
  } catch {
    return { version: 1, users: {} }; // corrupt file loses secrets, never crashes boot
  }
}

function saveVault(dataDir: string, vault: VaultFile): void {
  const p = vaultPath(dataDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(vault));
  renameSync(tmp, p); // atomic swap — no torn writes
}

/** Store one provider key for a user. Overwrites silently. */
export function setUserProviderKey(cfgDataDir: string, userId: string, providerId: string, apiKey: string): void {
  const vault = loadVault(cfgDataDir);
  vault.users[userId] ??= {};
  vault.users[userId][providerId] = { sealed: seal(apiKey), updatedAt: Date.now() };
  saveVault(cfgDataDir, vault);
}

/** Remove one provider key. */
export function clearUserProviderKey(cfgDataDir: string, userId: string, providerId: string): void {
  const vault = loadVault(cfgDataDir);
  if (vault.users[userId]) {
    delete vault.users[userId][providerId];
    saveVault(cfgDataDir, vault);
  }
}

/** Which providers has THIS user configured? Flags only — never values. */
export function userProviderFlags(cfgDataDir: string, userId: string): Record<string, { configured: boolean }> {
  const entries = loadVault(cfgDataDir).users[userId] ?? {};
  const flags: Record<string, { configured: boolean }> = {};
  for (const [id, entry] of Object.entries(entries)) {
    flags[id] = { configured: Boolean(open(entry.sealed)) };
  }
  return flags;
}

/** Resolve the plaintext key for THIS user only — the single reader, used by
 * the turn-start path. Another userId's keys are structurally unreachable. */
export function resolveUserProviderKey(cfgDataDir: string, userId: string, providerId: string): string | null {
  const entry = loadVault(cfgDataDir).users[userId]?.[providerId];
  if (!entry) return null;
  return open(entry.sealed);
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
): Record<string, { driver: string; displayName: string; environment: Record<string, string> }> {
  const entries = loadVault(cfgDataDir).users[userId] ?? {};
  const map: Record<string, { driver: string; displayName: string; environment: Record<string, string> }> = {};
  for (const [providerId, entry] of Object.entries(entries)) {
    const key = open(entry.sealed);
    if (!key) continue;
    const envVar = driverEnv[providerId];
    if (!envVar) continue;
    const label = providerId.charAt(0).toUpperCase() + providerId.slice(1);
    map[userInstanceId(providerId, userId)] = {
      driver: providerId,
      displayName: `${label} (your key)`,
      environment: { [envVar]: key },
    };
  }
  return map;
}

/** Every user's configs — boot-time registration for the shared registry. */
export function allUserInstanceConfigs(
  cfgDataDir: string,
  driverEnv: Record<string, string>,
): Record<string, { driver: string; displayName: string; environment: Record<string, string> }> {
  const vault = loadVault(cfgDataDir);
  const merged: Record<string, { driver: string; displayName: string; environment: Record<string, string> }> = {};
  for (const userId of Object.keys(vault.users)) {
    Object.assign(merged, userInstanceConfigs(cfgDataDir, userId, driverEnv));
  }
  return merged;
}
