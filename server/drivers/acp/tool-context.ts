import { z } from "zod";
import type { JsonValue } from "../../schema.ts";
const update = z.object({
  toolCallId: z.string().min(1).max(1000).optional(),
  title: z.string().max(16000).optional(),
  kind: z.string().max(100).optional(),
  rawInput: z.object({ command: z.string().max(60000).optional() }).optional().catch(undefined),
});
export type AcpToolContext = z.infer<typeof update>;

/** Per-turn, bounded metadata for ACP permission callbacks that contain only
 * an id. Explicit fields on a later update replace previous fields. */
export class AcpToolContexts {
  private entries = new Map<string, AcpToolContext>();
  remember(payload: JsonValue): AcpToolContext {
    const parsed = update.safeParse(payload);
    if (!parsed.success) return {};
    const current = parsed.data;
    const previous = current.toolCallId ? this.entries.get(current.toolCallId) : undefined;
    const merged = { ...previous, ...current };
    if (current.toolCallId) {
      this.entries.delete(current.toolCallId);
      this.entries.set(current.toolCallId, merged);
      if (this.entries.size > 512) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return merged;
  }
}
