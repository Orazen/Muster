// P4 (local-first plan §8 P4) — object-type routing for the pass's
// readObject / applyObject seam.
//
// Until P4 the pass had exactly one producer (memory), so index.ts passed
// readMemoryObject / applyMemoryObject straight in. Conversations are the
// second producer (server/sync-chats.ts) and the pass itself is
// object-type agnostic: it only knows "serialize the object this journal
// row names" and "hand this verified object to the local writer". Routing
// belongs at the injection point, not inside the engine — the pass stays
// byte-for-byte the S2b pass its tests pin.
//
// Unknown types deliberately fall through to the memory reader, whose
// object-id guard throws "not a memory object: <id>" — the same refusal a
// second reader would invent, without a second rule to keep in sync. A
// tombstone reaches the same route as its object type: only the applier
// inside that route knows tombstones mean "delete this thread".
import type { SyncPassDeps } from "./sync-pass.ts";
import type { SyncObject } from "./sync-objects.ts";
import { CHAT_OBJECT_TYPE, applyChatObject, readChatObject } from "./sync-chats.ts";
import { applyMemoryObject, readMemoryObject } from "./sync-memory.ts";

/** The pass's readObject over every registered producer. */
export function createObjectRead(): SyncPassDeps["readObject"] {
  const readMemory = readMemoryObject();
  const readChat = readChatObject();
  return (row) => (row.objectType === CHAT_OBJECT_TYPE ? readChat(row) : readMemory(row));
}

/** The pass's applyObject over every registered producer. */
export function createObjectApply(): SyncPassDeps["applyObject"] {
  const applyMemory = applyMemoryObject();
  const applyChat = applyChatObject();
  return (object: SyncObject) =>
    object.objectType === CHAT_OBJECT_TYPE ? applyChat(object) : applyMemory(object);
}
