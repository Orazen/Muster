// Brain facts: the correction-chain memory the fleet brain keeps about
// people, companies, projects and decisions. The shared api() helper already
// rejects non-2xx replies with the server's error string, so these functions
// only need to guard the shape of a 200 body.

import { z } from "zod";
import { api } from "@/state/store";

const factKindSchema = z.enum(["person", "company", "project", "decision", "note"]);

// The brain stores epoch-ms timestamps internally while the wire contract
// promises ISO strings; accept either so a fact survives whichever
// serialization an endpoint sends. Normalized here and nowhere else.
const instantSchema = z.union([
  z.number().transform((ms) => new Date(ms).toISOString()),
  z.string(),
]);

const brainFactSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: factKindSchema,
  source: z.string().min(1),
  origin: z.string().optional(),
  withdrawnAt: instantSchema.optional(),
  createdAt: instantSchema,
});

export type BrainFact = z.infer<typeof brainFactSchema>;

export interface FactHistory {
  ancestors: BrainFact[];
  fact: BrainFact | undefined;
  descendants: BrainFact[];
}

const factListSchema = z.object({ facts: z.array(brainFactSchema) });
// The server wraps the chain in `{ history }` and answers actions with their
// own named confirmations (`{ withdrawn: true }`, `{ restored: true }`) —
// decoded against the envelopes the routes actually send.
const factHistorySchema = z.object({
  history: z.object({
    ancestors: z.array(brainFactSchema),
    fact: brainFactSchema.nullable().optional(),
    descendants: z.array(brainFactSchema),
  }),
});
const withdrawSchema = z.object({ withdrawn: z.literal(true) });
const restoreSchema = z.object({ restored: z.literal(true) });
const revertSchema = z.object({ fact: brainFactSchema });

const factPath = (id: string) => `/api/brain/facts/${encodeURIComponent(id)}`;

/** Withdrawn facts stay in the list on purpose — they carry the provenance
 * a later reader needs; the withdrawn state travels in `withdrawnAt`. */
export async function listBrainFacts(): Promise<BrainFact[]> {
  const parsed = factListSchema.safeParse(await api("/api/brain/facts"));
  if (!parsed.success) throw new Error("Brain facts came back in an unexpected shape.");
  return parsed.data.facts;
}

export async function factHistory(id: string): Promise<FactHistory> {
  const parsed = factHistorySchema.safeParse(await api(`${factPath(id)}/history`));
  if (!parsed.success) throw new Error("Fact history came back in an unexpected shape.");
  // spread instead of pass-through: the decoded `fact` key is nullable, the
  // contract type keeps it present-but-possibly-undefined
  return {
    ancestors: parsed.data.history.ancestors,
    fact: parsed.data.history.fact ?? undefined,
    descendants: parsed.data.history.descendants,
  };
}

export async function withdrawFact(id: string): Promise<void> {
  const parsed = withdrawSchema.safeParse(await api(`${factPath(id)}/withdraw`, { method: "POST" }));
  if (!parsed.success) throw new Error("The server did not confirm the withdrawal.");
}

export async function restoreFact(id: string): Promise<void> {
  const parsed = restoreSchema.safeParse(await api(`${factPath(id)}/restore`, { method: "POST" }));
  if (!parsed.success) throw new Error("The server did not confirm the restore.");
}

export async function revertFact(id: string, text: string): Promise<BrainFact> {
  // A revert mints a NEW fact superseding the chain head — history is never
  // rewritten — so the reply carries the replacement fact in `fact`.
  const parsed = revertSchema.safeParse(
    await api(`${factPath(id)}/revert`, { method: "POST", body: JSON.stringify({ text }) }),
  );
  if (!parsed.success) throw new Error("The reverted fact came back in an unexpected shape.");
  return parsed.data.fact;
}
