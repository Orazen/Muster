import type { WebhookCredential } from "./webhooks.js";

const KEY = "omb-webhook-credentials";

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

// Stored payloads only ever reach this module through JSON.parse on the
// localStorage string below, so membership in the JSON tree is decided by
// these predicates exactly as a primitive representation test would.
const isText = <T>(v: T): v is T & string => Object.is(String(v), v);
interface JsonRecord {
  [key: string]: JsonValue;
}
type JsonValue = string | number | boolean | null | JsonRecord | JsonValue[];

// A stored credential doubles as a JSON record, so the predicate narrows to
// the intersection and slots straight back into the parsed entry tuple.
function isCredential(value: JsonValue): value is WebhookCredential & JsonRecord {
  if (!(value instanceof Object) || Array.isArray(value)) return false;
  const row: JsonRecord = value;
  return (
    isText(row.endpointUrl) &&
    row.endpointUrl.length > 0 &&
    isText(row.secret) &&
    row.secret.length > 0 &&
    isText(row.url) &&
    row.url.length > 0
  );
}

/** Private webhook URLs are returned only when created or rotated. Keep that
 * one-time value in this app's local browser storage so changing tabs or
 * relaunching the desktop app does not force a surprise secret rotation. */
export function loadWebhookCredentials(store: Store): Record<string, WebhookCredential> {
  try {
    const raw = store?.getItem(KEY);
    const parsed: JsonValue | null = raw ? JSON.parse(raw) : null;
    if (!(parsed instanceof Object) || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, WebhookCredential & JsonRecord] => isCredential(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function saveWebhookCredential(store: Store, webhookId: string, credential: WebhookCredential): void {
  const credentials = loadWebhookCredentials(store);
  credentials[webhookId] = credential;
  try {
    store?.setItem(KEY, JSON.stringify(credentials));
  } catch {
    // Storage is best-effort. The URL remains usable for this mount.
  }
}

export function removeWebhookCredential(store: Store, webhookId: string): void {
  const credentials = loadWebhookCredentials(store);
  delete credentials[webhookId];
  try {
    store?.setItem(KEY, JSON.stringify(credentials));
  } catch {
    // A failed cleanup must not block deleting the webhook itself.
  }
}

export function webhookCredentialStore(): Store {
  try {
    // Absent globals read as undefined off globalThis, so this is the
    // same availability test as a declaration check without one.
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}
