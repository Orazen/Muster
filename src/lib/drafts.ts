// Unsent composer text, kept per thread. The Composer is keyed by bot/room
// id, so switching threads unmounts it and its local text state dies with
// it. Drafts live in localStorage, so coming back to a bot — in this
// session or after a restart — finds what you were typing still there.
import { useCallback, useState, useSyncExternalStore, type SetStateAction } from "react";
import { isAttachment, type Attachment } from "./composer-attachments.js";

const KEY = "omb-drafts";
const ATTACHMENTS_KEY = "omb-draft-attachments";

/** One thread's stored value: composer text or its attachment list. */
type DraftValue = string | Attachment[];
type Values = Record<string, DraftValue>;
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

// Keep only writes that storage could not persist in memory. Successful writes
// are read from storage so clearing/replacing persisted drafts cannot revive a
// stale module cache. Stores (including test stores) never share a namespace.
type LiveStore = { pending: Map<string, string>; listeners: Map<string, Set<() => void>> };
const liveStores = new WeakMap<NonNullable<Store>, LiveStore>();
const unavailableStore: LiveStore = { pending: new Map(), listeners: new Map() };
function liveStore(store: Store): LiveStore {
  if (!store) return unavailableStore;
  let live = liveStores.get(store);
  if (!live) {
    live = { pending: new Map(), listeners: new Map() };
    liveStores.set(store, live);
  }
  return live;
}

/** Same-tab draft updates, scoped to the exact storage and conversation. */
export function subscribeDraft(store: Store, id: string, listener: () => void): () => void {
  const live = liveStore(store);
  let listeners = live.listeners.get(id);
  if (!listeners) {
    listeners = new Set();
    live.listeners.set(id, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) live.listeners.delete(id);
  };
}

const isText = <T>(value: T): value is T & string => String(value) === value;

// Storage is best-effort: a full quota, a locked-down origin, or a garbled
// value must never cost a keystroke. Unreadable persisted values are ignored;
// failed text writes remain available in the session fallback above.
function read(store: Store, key: string): Values {
  try {
    const raw = store?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    // SAFETY: this file is written only by setDraft/setDraftAttachments below, so an
    // object payload maps ids to composer strings or attachment lists; readers
    // validate each entry before using it.
    return parsed instanceof Object && !Array.isArray(parsed) ? (parsed as Values) : {};
  } catch {
    return {};
  }
}

export function getDraft(store: Store, id: string): string {
  const pending = liveStore(store).pending;
  if (pending.has(id)) return pending.get(id)!;
  const text = read(store, KEY)[id];
  return isText(text) ? text : "";
}

export function setDraft(store: Store, id: string, text: string): void {
  const drafts = read(store, KEY);
  // an emptied composer drops its entry rather than storing "" forever
  if (text) drafts[id] = text;
  else delete drafts[id];
  const live = liveStore(store);
  live.pending.set(id, text);
  try {
    if (store) {
      store.setItem(KEY, JSON.stringify(drafts));
      live.pending.delete(id);
    }
  } catch {
    /* quota / private mode — retain the current value for this session */
  }
  live.listeners.get(id)?.forEach((listener) => listener());
}

export function getDraftAttachments(store: Store, id: string): Attachment[] {
  const attachments = read(store, ATTACHMENTS_KEY)[id];
  return Array.isArray(attachments) ? attachments.filter(isAttachment) : [];
}

export function setDraftAttachments(store: Store, id: string, attachments: Attachment[]): void {
  const drafts = read(store, ATTACHMENTS_KEY);
  if (attachments.length) drafts[id] = attachments;
  else delete drafts[id];
  try {
    store?.setItem(ATTACHMENTS_KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode — attachments remain in component state */
  }
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked merely touching the getter throws, and the draft must
// never take the composer down with it.
function getStore(): Store {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Programmatic overwrite for a newly created teammate's first task. */
export function seedDraft(key: string, text: string): void {
  setDraft(getStore(), key, text);
}

/** Add an explicitly prepared task to the latest unsent text. Attachments are
 * stored separately and remain untouched, including on a mounted composer. */
export function appendDraft(key: string, text: string): void {
  if (!text) return;
  const store = getStore();
  const current = getDraft(store, key);
  setDraft(store, key, current ? `${current}\n\n${text}` : text);
}

/** Composer text with same-tab notifications and best-effort persistence. */
export function useDraft(id: string): [string, (next: string) => void] {
  const store = getStore();
  const subscribe = useCallback((listener: () => void) => subscribeDraft(store, id, listener), [store, id]);
  const snapshot = useCallback(() => getDraft(store, id), [store, id]);
  const text = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((next: string) => setDraft(store, id, next), [store, id]);
  return [text, set];
}

/** A conversation's complete composer draft. Attachment storage is separate
 * from text so typing does not stringify a large pasted payload per keypress. */
export function useComposerDraft(
  id: string,
): [
  string,
  (next: string) => void,
  Attachment[],
  (next: SetStateAction<Attachment[]>) => void,
] {
  const store = getStore();
  const [text, setText] = useDraft(id);
  const [attachments, setAttachmentState] = useState(() => getDraftAttachments(store, id));
  const setAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      setAttachmentState((previous) => {
        // React's SetStateAction passes the setter either the next array or an
        // updater function; telling the two shapes apart needs a runtime check.
        // oxlint-disable-next-line anti-slop/no-runtime-typeof
        const value = typeof next === "function" ? next(previous) : next;
        setDraftAttachments(store, id, value);
        return value;
      });
    },
    [store, id],
  );
  return [text, setText, attachments, setAttachments];
}
