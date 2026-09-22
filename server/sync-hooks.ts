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
