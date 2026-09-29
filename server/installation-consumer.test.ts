/** Unit coverage for the machine-side credential consumer. HTTP is a stub,
 * the clock is injected, and every door (attach, prove, renew, revoke,
 * transport failure, corrupt file, unwritable file) is exercised against
 * real filesystem persistence — the same 0600 file real machines will hold. */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InstallationConsumer, loadPersistedInstallation, installationConsumerPath } from "./installation-consumer.ts";

const NOW = 1_789_000_000_000;

const installationView = {
  id: "inst-abc12345",
  label: "This machine",
  platform: "macos",
  capabilities: ["workspace"],
  createdAt: NOW - 1_000,
  lastSeenAt: NOW - 1_000,
  revokedAt: null,
};

/** Stub fetch: routes by URL, records calls, answers from a mutable script. */
function stubFetch(responder: (url: string, init: RequestInit | undefined) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchJson = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init });
    const { status, body } = responder(input, init);
    return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
  };
  return { calls, fetchJson };
}

function newConsumer(dataDirectory: string, responder: Parameters<typeof stubFetch>[0], now = NOW) {
  const { calls, fetchJson } = stubFetch(responder);
  const consumer = new InstallationConsumer({ dataDirectory, baseUrl: "https://cloud.test", fetchJson }, now);
  return { calls, consumer };
}

describe("InstallationConsumer", () => {
  it("a heartbeat 401 that arrives after a refresh does NOT erase the new credential", async () => {
    // A6. The heartbeat sends one credential and, on a 401, cleared whatever
    // was in state when the response landed. A refresh that completed while
    // the heartbeat was in flight was therefore erased by the older 401: the
    // machine reported "unregistered" while holding a working new secret, and
    // nothing but a restart or a manual re-attach recovered it. A 401 is a
    // statement about the credential that was SENT.
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-a6-"));
    try {
      let release401: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release401 = resolve; });
      let refreshCalls = 0;

      // Built by hand rather than through newConsumer: the shared stub's
      // responder is synchronous, so it cannot hold a response open. The
      // ordering being tested IS a response arriving late.
      const consumer = new InstallationConsumer({
        dataDirectory,
        baseUrl: "https://cloud.test",
        fetchJson: async (input: string): Promise<Response> => {
          if (input.includes("/api/installations/register")) {
            return new Response(JSON.stringify({ installation: installationView, credential: "secret-one", reactivated: false, credentialExpiresAt: NOW + 7_200_000 }), { status: 200 });
          }
          if (input.includes("/api/installations/refresh")) {
            refreshCalls += 1;
            return new Response(JSON.stringify({ credential: "secret-two-rotated", credentialExpiresAt: NOW + 7_200_000 }), { status: 200 });
          }
          // The heartbeat is in flight and will be told, eventually, that the
          // credential it carried is no good.
          await gate;
          return new Response(undefined, { status: 401 });
        },
      }, NOW);

      await consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" }, NOW);
      expect(consumer.status).not.toBe("unregistered");

      // Hold the heartbeat open, refresh, and only then let the 401 land.
      const heartbeat = consumer.heartbeat(NOW);
      const renewed = await consumer.refreshCredential(NOW + 1_000);
      expect(refreshCalls).toBe(1);
      expect(renewed.credential).toBe("secret-two-rotated");
      expect(loadPersistedInstallation(installationConsumerPath(dataDirectory))?.credential).toBe("secret-two-rotated");

      release401();
      const report = await heartbeat;

      const after = loadPersistedInstallation(installationConsumerPath(dataDirectory));
      expect(after?.credential, "a stale 401 erased a working credential").toBe("secret-two-rotated");
      expect(after?.installationId).toBe(installationView.id);
      expect(report.status, "a stale answer about an old credential was believed").not.toBe("out-of-sync");
      expect(consumer.status).not.toBe("unregistered");
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("still goes out-of-sync when the 401 belongs to the credential it is answering for", async () => {
    // The fence must not become a way to keep a genuinely dead credential.
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-a6b-"));
    try {
      const { consumer } = newConsumer(dataDirectory, (url) =>
        url.includes("/register")
          ? { status: 200, body: { installation: installationView, credential: "secret-one", reactivated: false, credentialExpiresAt: NOW + 7_200_000 } }
          : url.includes("/self")
            ? { status: 401 }
            : { status: 500 });
      await consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" }, NOW);
      const report = await consumer.heartbeat(NOW);
      expect(report.status, "a real 401 must still unregister the machine").toBe("out-of-sync");
      expect(consumer.status).toBe("unregistered");
      expect(loadPersistedInstallation(installationConsumerPath(dataDirectory))?.credential).toBeNull();
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("starts unregistered with a stable client key persisted before any credential exists", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const { consumer } = newConsumer(dataDirectory, () => ({ status: 500 }));
      expect(consumer.status).toBe("unregistered");
      expect(consumer.clientKey).toMatch(/^inst-/);
      const stored = loadPersistedInstallation(installationConsumerPath(dataDirectory));
      expect(stored?.clientKey).toBe(consumer.clientKey);
      expect(stored?.credential).toBeNull();
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("registers through the owner's session, stores the credential 0600, and returns the stable id", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const { calls, consumer } = newConsumer(dataDirectory, (url) => {
        expect(url).toContain("/api/installations/register");
        return { status: 201, body: { installation: installationView, reactivated: false, credential: "secret-1", credentialExpiresAt: NOW + 24 * 60 * 60_000 } };
      });
      const result = await consumer.registerThroughOwner("session=1", {
        clientKey: consumer.clientKey,
        label: "Desk machine",
        platform: "macos",
      });
      expect(result).toEqual({ installationId: "inst-abc12345", reactivated: false });
      expect(calls[0]?.init?.headers).toMatchObject({ cookie: "session=1" });
      const path = installationConsumerPath(dataDirectory);
      expect((statSync(path).mode & 0o777) === 0o600).toBe(true);
      const stored = loadPersistedInstallation(path);
      expect(stored?.credential).toBe("secret-1");
      expect(stored?.installationId).toBe("inst-abc12345");
      expect(stored?.credentialExpiresAt).toBe(NOW + 24 * 60 * 60_000);
      expect(consumer.status).toBe("active");
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("presents the bearer on heartbeat and reports active while the credential is fresh", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const { calls, consumer } = newConsumer(dataDirectory, (url) => {
        if (url.includes("/register")) {
          return { status: 201, body: { installation: installationView, reactivated: false, credential: "secret-1", credentialExpiresAt: NOW + 24 * 60 * 60_000 } };
        }
        return { status: 200, body: { installation: installationView } };
      });
      await consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" }, NOW);
      const report = await consumer.heartbeat(NOW);
      const selfCall = calls.find((call) => call.url.includes("/api/installations/self"));
      expect(selfCall?.init?.headers).toMatchObject({ authorization: "Bearer secret-1" });
      expect(report.status).toBe("active");
      expect(report.installationId).toBe("inst-abc12345");
      expect(report.refreshed).toBe(false);
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("reports expiring as the credential nears expiry, from the server-stated clock", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const { consumer } = newConsumer(dataDirectory, () => ({
        status: 201,
        body: { installation: installationView, reactivated: false, credential: "s", credentialExpiresAt: NOW + 30 * 60_000 },
      }));
      await consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" }, NOW);
      const report = await consumer.heartbeat(NOW);
      expect(report.status).toBe("expiring");
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("treats a heartbeat 401 as definitive out-of-sync: the secret is dropped, never re-registered", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      let selfCalls = 0;
      const { calls, consumer } = newConsumer(dataDirectory, (url) => {
        if (url.includes("/register")) {
          return { status: 201, body: { installation: installationView, reactivated: false, credential: "secret-1", credentialExpiresAt: NOW + 24 * 60 * 60_000 } };
        }
        selfCalls += 1;
        return selfCalls === 1
          ? { status: 200, body: { installation: installationView } }
          : { status: 401, body: { error: "revoked" } };
      });
      await consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" });
      await consumer.heartbeat();
      const report = await consumer.heartbeat();
      expect(report.status).toBe("out-of-sync");
      expect(consumer.status).toBe("unregistered");
      expect(loadPersistedInstallation(installationConsumerPath(dataDirectory))?.credential).toBeNull();
      // No register call may ever appear without the owner driving it.
      expect(calls.filter((call) => call.url.includes("/register")).length).toBe(1);
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("refreshCredential exchanges the current credential for a fresh one and persists it", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const { calls, consumer } = newConsumer(dataDirectory, (url, init) => {
        if (url.includes("/register")) {
          return { status: 201, body: { installation: installationView, reactivated: false, credential: "old-secret", credentialExpiresAt: NOW + 30 * 60_000 } };
        }
        // SAFETY: the consumer sets plain string headers on every refresh call.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.authorization).toBe("Bearer old-secret");
        return { status: 200, body: { credential: "new-secret", credentialExpiresAt: NOW + 24 * 60 * 60_000 } };
      });
      await consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" }, NOW);
      const renewed = await consumer.refreshCredential(NOW);
      expect(renewed).toEqual({ credential: "new-secret", expiresAt: NOW + 24 * 60 * 60_000 });
      expect(calls.filter((call) => call.url.includes("/refresh")).length).toBe(1);
      expect(loadPersistedInstallation(installationConsumerPath(dataDirectory))?.credential).toBe("new-secret");
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("a refresh 401 drops the secret and points at the owner; transport failure surfaces as a transport error", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const { consumer } = newConsumer(dataDirectory, (url) => {
        if (url.includes("/register")) {
          return { status: 201, body: { installation: installationView, reactivated: false, credential: "s", credentialExpiresAt: NOW + 60 * 60_000 } };
        }
        return { status: 401, body: { error: "revoked" } };
      });
      await consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" });
      await expect(consumer.refreshCredential()).rejects.toThrow("re-register through the owner");
      expect(consumer.status).toBe("unregistered");
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }

    const offlineDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const offline = newConsumer(offlineDirectory, (url) => {
        if (url.includes("/register")) {
          return { status: 201, body: { installation: installationView, reactivated: false, credential: "s2", credentialExpiresAt: NOW + 24 * 60 * 60_000 } };
        }
        throw new Error("ECONNREFUSED");
      });
      await offline.consumer.registerThroughOwner("session=1", { clientKey: offline.consumer.clientKey, label: "L", platform: "macos" });
      // Offline is DEGRADED (a thrown transport error), not out-of-sync: the
      // secret survives and the next successful heartbeat proves it again.
      await expect(offline.consumer.heartbeat()).rejects.toThrow("transport failed");
      expect(offline.consumer.status).toBe("active");
    } finally {
      rmSync(offlineDirectory, { recursive: true, force: true });
    }
  });

  it("a corrupt local file means no standing: nothing presents a secret it cannot vouch for", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      writeFileSync(installationConsumerPath(dataDirectory), "{ not json", { mode: 0o600 });
      const { consumer } = newConsumer(dataDirectory, () => ({ status: 500 }));
      expect(consumer.status).toBe("unregistered");
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("an unwritable data directory fails registration loudly instead of pretending to hold a secret", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inst-consumer-"));
    try {
      const ro = join(dataDirectory, "ro");
      const { consumer } = newConsumer(ro, () => ({ status: 201, body: { installation: installationView, reactivated: false, credential: "s", credentialExpiresAt: NOW } }));
      await expect(consumer.registerThroughOwner("session=1", { clientKey: consumer.clientKey, label: "L", platform: "macos" })).rejects.toThrow("could not be stored");
      expect(existsSync(installationConsumerPath(ro))).toBe(false);
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
