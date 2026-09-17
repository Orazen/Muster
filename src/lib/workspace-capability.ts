import { z } from "zod";
import type { WorkspaceBackupCapability } from "../../server/contracts";

export const workspaceCapabilitySchema = z.object({
  capabilityVersion: z.literal(1),
  workspaceBackupAvailable: z.boolean(),
  unavailableReason: z.string().refine((value) => value.trim().length > 0).nullable(),
  drive: z.literal(false),
  installationDrive: z.object({ configured: z.boolean(), operationsAvailable: z.boolean() }).strict(),
  accountDrive: z.object({ available: z.boolean(), connected: z.boolean() }).strict(),
}).strict().refine((value) => (
  value.workspaceBackupAvailable
    ? value.unavailableReason === null && value.installationDrive.configured === value.installationDrive.operationsAvailable
    : value.unavailableReason !== null && !value.installationDrive.configured && !value.installationDrive.operationsAvailable
));

export type WorkspaceCapabilityState =
  | { kind: "loading" }
  | { kind: "ready"; value: WorkspaceBackupCapability }
  | { kind: "error"; message: string };

export interface WorkspaceRequest {
  signal: AbortSignal;
  current(): boolean;
  commit(effect: () => void): boolean;
  finish(): void;
}

interface PendingWorkspaceRequests {
  status: AbortController | null;
  operation: AbortController | null;
}

/** One mounted account/session's reads and explicit operation. Even when a
 * transport ignores abort, retirement invalidates every later side effect. */
export function createWorkspaceRequestScope() {
  let active = false;
  let generation = 0;
  const pending: PendingWorkspaceRequests = { status: null, operation: null };

  function begin(kind: "status" | "operation"): WorkspaceRequest | null {
    if (!active || (kind === "operation" && pending.operation)) return null;
    pending[kind]?.abort();
    const controller = new AbortController();
    const started = generation;
    pending[kind] = controller;
    const current = () => active && generation === started && pending[kind] === controller && !controller.signal.aborted;
    return {
      signal: controller.signal,
      current,
      commit(effect) {
        if (!current()) return false;
        effect();
        return true;
      },
      finish() {
        if (pending[kind] === controller) pending[kind] = null;
      },
    };
  }

  return {
    activate() { active = true; },
    dispose() {
      active = false;
      generation += 1;
      pending.status?.abort();
      pending.operation?.abort();
      pending.status = null;
      pending.operation = null;
    },
    get busy() { return pending.operation !== null; },
    beginStatus() { return begin("status"); },
    beginOperation() { return begin("operation"); },
  };
}

const errorSchema = z.object({ error: z.string() });

/** Unlike the app-wide api helper, an old 401 cannot navigate a new session.
 * Keep the server's error text, and check retirement after every body read. */
export async function workspaceResponse(
  request: WorkspaceRequest,
  path: string,
  body?: string,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  if (!request.current()) return null;
  const response = await fetcher(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal: request.signal,
    body,
  });
  if (!request.current()) return null;
  if (!response.ok) {
    const error = errorSchema.safeParse(await response.json().catch(() => null));
    if (!request.current()) return null;
    throw new Error(error.success ? error.data.error : `${response.status} ${response.statusText}`);
  }
  return response;
}

export async function readWorkspaceReply<T>(request: WorkspaceRequest, path: string, body: string | undefined, schema: z.ZodType<T>, fetcher: typeof fetch = fetch): Promise<T | null> {
  const response = await workspaceResponse(request, path, body, fetcher);
  if (!response) return null;
  const result = schema.safeParse(await response.json());
  if (!request.current()) return null;
  if (!result.success) throw new Error("The server returned an invalid backup response. Check backup status before trying again.");
  return result.data;
}

export async function readWorkspaceCapability(
  request: WorkspaceRequest,
  fetcher: typeof fetch = fetch,
): Promise<WorkspaceBackupCapability | null> {
  const response = await workspaceResponse(request, "/api/workspace/google/status", undefined, fetcher);
  if (!response) return null;
  const result = workspaceCapabilitySchema.safeParse(await response.json());
  if (!request.current()) return null;
  if (!result.success) throw new Error("This server did not return a supported backup capability. Update Muster and try again.");
  return result.data;
}
