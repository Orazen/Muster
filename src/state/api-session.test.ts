import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./store";
import { sessionRecheck } from "../lib/session-recheck";
import { createSessionRecovery, type SessionPayload, type SessionSnapshot } from "../lib/session-recovery";

const identity: SessionPayload = {
  user: { id: "owned-account", name: "Fixture", email: "fixture@example.invalid", emailVerified: true,
    createdAt: new Date(), updatedAt: new Date() },
  session: { id: "owned-session", userId: "owned-account", token: "fixture-token", expiresAt: new Date(Date.now() + 60_000) },
};
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

async function fixture(next: () => Promise<SessionPayload | null>) {
  const states: SessionSnapshot[] = [];
  const request = vi.fn<() => Promise<SessionPayload | null>>().mockResolvedValueOnce(identity).mockImplementation(next);
  const recovery = createSessionRecovery(snapshot => states.push(snapshot), request);
  await recovery.refresh();
  states.length = 0;
  cleanups.push(sessionRecheck.register(async () => { await recovery.refresh({ background: true }); }));
  const location = { pathname: "/app", search: "?drive=connected", href: "/app?drive=connected" };
  vi.stubGlobal("window", { location });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Provider credential rejected" }), { status: 401 })));
  return { states, request, location };
}

describe("API authorization and browser identity", () => {
  it("keeps a valid browser session after a provider route returns 401", async () => {
    const f = await fixture(async () => identity);
    await expect(api("/api/user-keys", { method: "PUT", body: "{}" })).rejects.toThrow("Provider credential rejected");
    expect(f.location.href).toBe("/app?drive=connected");
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.states.at(-1)?.status).toBe("ready"));
    expect(f.states.every(state => state.user?.id === identity.user.id && state.status === "ready")).toBe(true);
  });
  it("publishes confirmed expiry for AuthGate instead of navigating from the API helper", async () => {
    const f = await fixture(async () => null);
    await expect(api("/api/config")).rejects.toThrow();
    await vi.waitFor(() => expect(f.states.at(-1)).toEqual({ status: "ready", user: null, session: null }));
    expect(f.location.href).toBe("/app?drive=connected");
  });
  it("keeps known account state when the session check is unavailable", async () => {
    const f = await fixture(async () => { throw new Error("Session service unavailable"); });
    await expect(api("/api/user-keys", { method: "PUT" })).rejects.toThrow();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    expect(f.states).toEqual([]);
    expect(f.location.href).toBe("/app?drive=connected");
  });
});
