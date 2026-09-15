// Per-user custom model providers — the hosted multi-tenant counterpart of
// the operator's global cfg.customProviders.
//
// The problem this closes: on a hosted deployment, non-primary accounts
// could not use custom providers AT ALL. Custom providers lived (and still
// live for the operator) in the global config, so the engine/infra guard
// 404'd every /api/custom-providers* route for them — the picker showed
// "No model providers are available", "Fetch models" answered "no such
// resource", and the operator-facing advice "add your own key" was a dead
// end. Built-in vault keys (/api/user-keys) worked, but a b.ai-style
// OpenAI-compatible endpoint had nowhere to go.
//
// Design mirrors the vault's isolation exactly: metadata (name, baseUrl,
// models) in a per-user file; the key in the shared encrypted vault under
// provider id `custom-<id>` for that user; registry instances keyed
// `custom-<id>Api:<userId>` so turn-start's ownership check
// (userInstanceOwner) isolates them with no new machinery. The operator's
// global providers and this per-user set never touch each other's data.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson, type JsonValue } from "./schema.ts";
import {
  CUSTOM_PROVIDER_MAX,
  customKeyProviderId,
  customProviderInstances,
  customProviderSchema,
  sanitizeCustomProviderId,
  type CustomProvider,
  type CustomProviderInput,
} from "./custom-providers.ts";
import { userInstanceId } from "./user-keys.ts";
import type { InstanceConfigMap } from "./contracts.ts";

const storeSchema = z.record(z.string(), z.array(customProviderSchema));
const objectSchema = z.record(z.string(), z.unknown());

function filePath(dataDir: string): string {
  return join(dataDir, "user-custom-providers.json");
}

function readStore(dataDir: string): Record<string, CustomProvider[]> {
  try {
    const raw = parseJson(readFileSync(filePath(dataDir), "utf8"));
    if (!objectSchema.safeParse(raw).success) return {};
    const parsed = storeSchema.safeParse(raw);
    return parsed.success ? parsed.data : {};
  } catch {
    return {}; // missing/unreadable file = nobody has added one yet
  }
}

/** All providers for one user, in add order. */
export function listUserCustomProviders(dataDir: string, userId: string): CustomProvider[] {
  return readStore(dataDir)[userId] ?? [];
}

/** Add one provider with a collision-free id derived from its name.
 * Returns null when the user is at the cap (the route enforces the same
 * limit with its own message; this is the module's own guard). */
export function addUserCustomProvider(
  dataDir: string,
  userId: string,
  input: CustomProviderInput,
): CustomProvider | null {
  const store = readStore(dataDir);
  const mine = store[userId] ?? [];
  if (mine.length >= CUSTOM_PROVIDER_MAX) return null;
  let id = sanitizeCustomProviderId(input.name);
  let n = 2;
  while (mine.some((p) => p.id === id)) id = `${sanitizeCustomProviderId(input.name)}-${n++}`;
  const provider = { ...input, id };
  store[userId] = [...mine, provider];
  writeFileAtomic(filePath(dataDir), JSON.stringify(store), { mode: 0o600 });
  return provider;
}

/** Remove one provider by id. Returns whether anything was deleted. */
export function removeUserCustomProvider(dataDir: string, userId: string, id: string): boolean {
  const store = readStore(dataDir);
  const mine = store[userId] ?? [];
  const next = mine.filter((p) => p.id !== id);
  if (next.length === mine.length) return false;
  if (next.length) store[userId] = next;
  else delete store[userId];
  writeFileAtomic(filePath(dataDir), JSON.stringify(store), { mode: 0o600 });
  return true;
}

/** Registry instance configs for one user's custom providers. Reuses the
 * operator's builder, then re-keys every instance into the user-scoped
 * namespace (`custom-<id>Api:<userId>`) that turn-start already isolates on. */
export function userCustomInstanceConfigs(
  dataDir: string,
  userId: string,
  apiKeyOf: (vaultProviderId: string) => string | undefined,
): InstanceConfigMap {
  const global = customProviderInstances(listUserCustomProviders(dataDir, userId), (id) =>
    apiKeyOf(customKeyProviderId(id)),
  );
  const out: InstanceConfigMap = {};
  for (const [instanceId, entry] of Object.entries(global)) {
    out[userInstanceId(instanceId, userId)] = entry;
  }
  return out;
}

/** Every user's custom-provider instances (boot path). Iterates the union
 * of users in this file and the vault — a user can hold keys for providers
 * they deleted, but instances only build from listed metadata. */
export function allUserCustomInstanceConfigs(
  dataDir: string,
  userIds: Iterable<string>,
  apiKeyOf: (userId: string, vaultProviderId: string) => string | undefined,
): InstanceConfigMap {
  const out: InstanceConfigMap = {};
  for (const userId of new Set(userIds)) {
    Object.assign(out, userCustomInstanceConfigs(dataDir, userId, (vid) => apiKeyOf(userId, vid)));
  }
  return out;
}

/** User ids present in the store — for the boot union. */
export function userCustomProviderUsers(dataDir: string): string[] {
  return Object.keys(readStore(dataDir));
}

/** Validate a wire body into a provider input; issues joined for display. */
export function parseUserCustomProviderInput(body: JsonValue | Record<string, unknown> | undefined) {
  return customProviderSchema.omit({ id: true }).safeParse(body ?? {});
}
