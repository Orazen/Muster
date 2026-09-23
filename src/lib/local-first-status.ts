import { z } from "zod";

import { workspaceCapabilitySchema } from "./workspace-capability";

const configStatusSchema = z.object({
  storageGate: z.object({
    required: z.boolean(),
    satisfied: z.boolean(),
  }),
});

type WorkspaceCapability = z.infer<typeof workspaceCapabilitySchema>;

export interface LocalFirstStatus {
  capability: WorkspaceCapability;
  storageGate: z.infer<typeof configStatusSchema>["storageGate"];
}

const statusPath = "/api/workspace/google/status";
const configPath = "/api/config";

async function readJson<T>(
  fetcher: typeof fetch,
  path: string,
  signal: AbortSignal,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetcher(path, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error("Local-first status is unavailable.");

  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Local-first status is unavailable.");
  return parsed.data;
}

/** Read the two existing, read-only status contracts used by Settings. */
export async function readLocalFirstStatus(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LocalFirstStatus> {
  const [capability, config] = await Promise.all([
    readJson(fetcher, statusPath, signal, workspaceCapabilitySchema),
    readJson(fetcher, configPath, signal, configStatusSchema),
  ]);
  return { capability, storageGate: config.storageGate };
}
