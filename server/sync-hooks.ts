// S2c producer seam — a leaf module on purpose: no imports, so the file
// side (workspace.ts) and the boot wiring (index.ts) can both reach it
// without forming an import cycle, and with no listener registered (unit
// tests, unwired builds) firing it is a no-op. The listener holds the
// journal handle, the local manifest store and the engine's notify —
// everything that must stay out of the file layer.

type MemoryWriteListener = (botId: string, text: string) => void;

let listener: MemoryWriteListener | null = null;

/** Boot wiring registers the real producer here; null unregisters. */
export function setMemoryWriteListener(next: MemoryWriteListener | null): void {
  listener = next;
}

/** Fired by workspace.ts AFTER a memory write is durable. */
export function memoryWasWritten(botId: string, text: string): void {
  listener?.(botId, text);
}

// P4 (local-first plan §8 P4 "Conversation sync", R4) — the same leaf seam
// for transcripts: message-db fires AFTER the transcript mutation commits,
// and the boot-registered producer turns one durable change into exactly
// one journal row (rev +1, live checksum). "delete" is carried as its own
// kind so the producer can publish the tombstone object the pass already
// knows how to carry — a deletion is data too, and silently dropping it
// would resurrect the thread on the next pull.
type ChatChangeListener = (threadId: string, kind: "write" | "delete") => void;

let chatListener: ChatChangeListener | null = null;

/** Boot wiring registers the real chat producer here; null unregisters. */
export function setChatChangeListener(next: ChatChangeListener | null): void {
  chatListener = next;
}

/** Fired by message-db.ts AFTER an append/update/leaf move is durable. */
export function chatWasWritten(threadId: string): void {
  chatListener?.(threadId, "write");
}

/** Fired by message-db.ts AFTER a thread delete commits. */
export function chatWasDeleted(threadId: string): void {
  chatListener?.(threadId, "delete");
}
