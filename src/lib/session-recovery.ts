import { z } from "zod";

const date = z.union([z.iso.datetime(), z.date()]).transform((value) => new Date(value));
const payloadSchema = z.object({
  user: z.object({
    id: z.string().min(1), name: z.string(), email: z.string(), emailVerified: z.boolean(),
    createdAt: date, updatedAt: date, image: z.string().nullish(),
  }),
  session: z.object({
    id: z.string().min(1), userId: z.string().min(1), expiresAt: date,
    token: z.string().min(1), ipAddress: z.string().nullish(), userAgent: z.string().nullish(),
  }),
}).refine(({ user, session }) => user.id === session.userId);

export type SessionPayload = z.infer<typeof payloadSchema>;
export type SessionSnapshot = {
  user: SessionPayload["user"] | null;
  session: SessionPayload["session"] | null;
  status: "loading" | "ready" | "unavailable";
};
export const INITIAL_SESSION: SessionSnapshot = { user: null, session: null, status: "loading" };
export const SESSION_UNAVAILABLE = "Muster couldn’t check your sign-in. Try again to reconnect to your workspace.";

/** Only a successful, explicit null means signed out. A proxy error,
 * malformed response or unreachable server says nothing about the cookie. */
export async function readSession(signal: AbortSignal): Promise<SessionPayload | null> {
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 8_000);
  try {
    const response = await fetch("/api/auth/get-session", { credentials: "include", signal: request.signal });
    if (!response.ok) throw new Error(SESSION_UNAVAILABLE);
    const body: unknown = await response.json();
    if (body === null) return null;
    return payloadSchema.parse(body);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

/** Fence late responses across retries, account changes and unmounts.
 * Cancellation never converts an unknown session into a signed-out one. */
export function createSessionRecovery(
  onChange: (snapshot: SessionSnapshot) => void,
  request: (signal: AbortSignal) => Promise<SessionPayload | null> = readSession,
) {
  let snapshot = INITIAL_SESSION;
  let generation = 0;
  let controller: AbortController | null = null;
  function cancel() {
    generation += 1;
    controller?.abort();
    controller = null;
  }
  function publish(next: SessionSnapshot) {
    snapshot = next;
    onChange(next);
  }
  return {
    cancel,
    clear() {
      cancel();
      publish({ user: null, session: null, status: "ready" });
    },
    async refresh(): Promise<SessionSnapshot | null> {
      cancel();
      const current = generation;
      controller = new AbortController();
      publish({ ...snapshot, status: "loading" });
      try {
        const payload = await request(controller.signal);
        if (generation !== current) return null;
        publish({ user: payload?.user ?? null, session: payload?.session ?? null, status: "ready" });
      } catch {
        if (generation !== current) return null;
        publish({ ...snapshot, status: "unavailable" });
      } finally {
        if (generation === current) controller = null;
      }
      return snapshot;
    },
  };
}
