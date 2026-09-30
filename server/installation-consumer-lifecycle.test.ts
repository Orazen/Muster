/** Device-local lifecycle races: deferred transports, real private temporary
 * files, no network or runtime wiring. A response must not outlive the local
 * attachment that authorized it, and an unstored secret must never be used. */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallationConsumer, installationConsumerPath, loadPersistedInstallation, type FetchLike } from "./installation-consumer.ts";

const NOW = 1_789_000_000_000;
const AUTHORITY = "https://owned-installation.test";
const directories: string[] = [];
const installation = {
  id: "installation-original",
  label: "Owned machine",
  platform: "macos",
  capabilities: ["workspace"],
  createdAt: NOW,
  lastSeenAt: NOW,
  revokedAt: null,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred response is not initialized"); };
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function json<T>(body: T, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function attached(credential = "original-secret", id = installation.id) {
  return { installation: { ...installation, id }, credential, credentialExpiresAt: NOW + 7_200_000, reactivated: false };
}

function renewed(credential = "renewed-secret") {
  return { credential, credentialExpiresAt: NOW + 14_400_000 };
}

async function outcome<T>(promise: Promise<T>) {
  const [result] = await Promise.allSettled([promise]);
  if (!result) throw new Error("Operation produced no settlement");
  return result;
}

function fixture(respond: FetchLike) {
  const directory = mkdtempSync(join(tmpdir(), "muster-installation-lifecycle-"));
  directories.push(directory);
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const consumer = new InstallationConsumer({
    dataDirectory: directory,
    baseUrl: AUTHORITY,
    fetchJson: async (url, init) => {
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return respond(url, init);
    },
  }, NOW);
  return {
    consumer,
    calls,
    directory,
    path: installationConsumerPath(directory),
    stored: () => loadPersistedInstallation(installationConsumerPath(directory), AUTHORITY),
    attach: () => consumer.registerThroughOwner("owned-session=fixture", {
      clientKey: consumer.clientKey, label: "Owned machine", platform: "macos",
    }, NOW),
  };
}

/** Deny replacement regardless of UID, without deleting the valid old file.
 * Atomic rename cannot replace a directory. Restore the original exact bytes
 * afterwards so restart assertions do not accidentally read a missing file. */
function blockCredentialReplacement(path: string) {
  const saved = `${path}.preserved`;
  const original = readFileSync(path, "utf8");
  renameSync(path, saved);
  mkdirSync(path, { mode: 0o700 });
  return () => {
    rmdirSync(path);
    renameSync(saved, path);
    expect(readFileSync(path, "utf8")).toBe(original);
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("installation consumer attachment lifecycle", () => {
  it("a registration body arriving after forget cannot reattach the machine", async () => {
    const body = deferred<ReturnType<typeof attached>>();
    const reading = deferred<void>();
    const f = fixture(async () => {
      const response = json({});
      vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return body.promise; });
      return response;
    });
    const key = f.consumer.clientKey;
    const pending = outcome(f.attach());
    await reading.promise;
    f.consumer.forget();
    body.resolve(attached("late-registration-secret"));
    await pending;
    expect(f.consumer.status).toBe("unregistered");
    expect(f.stored()).toMatchObject({ installationId: null, credential: null, clientKey: key });
  });

  it("a refresh response arriving after forget cannot restore its secret", async () => {
    const response = deferred<Response>();
    const f = fixture(async url => url.endsWith("/register") ? json(attached()) : response.promise);
    await f.attach();
    const pending = outcome(f.consumer.refreshCredential(NOW + 1_000));
    f.consumer.forget();
    response.resolve(json(renewed("late-refresh-secret")));
    await pending;
    expect(f.consumer.status).toBe("unregistered");
    expect(f.stored()).toMatchObject({ installationId: null, credential: null });
    const callsBeforeHeartbeat = f.calls.length;
    await outcome(f.consumer.heartbeat(NOW + 2_000));
    expect(f.calls.length).toBe(callsBeforeHeartbeat);
  });

  it("a refresh body arriving after forget cannot pass a fence checked before JSON parsing", async () => {
    const body = deferred<ReturnType<typeof renewed>>();
    const reading = deferred<void>();
    const f = fixture(async url => {
      if (url.endsWith("/register")) return json(attached());
      const response = json({});
      vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return body.promise; });
      return response;
    });
    await f.attach();
    const pending = outcome(f.consumer.refreshCredential(NOW + 1_000));
    await reading.promise;
    f.consumer.forget();
    body.resolve(renewed("late-parsed-refresh-secret"));
    await pending;
    expect(f.consumer.status).toBe("unregistered");
    expect(f.stored()).toMatchObject({ installationId: null, credential: null });
  });

  it("a late refresh body cannot overwrite a later explicit owner attachment", async () => {
    const body = deferred<ReturnType<typeof renewed>>();
    const reading = deferred<void>();
    let registrations = 0;
    const f = fixture(async url => {
      if (url.endsWith("/register")) {
        registrations += 1;
        return json(registrations === 1 ? attached() : attached("reattached-secret", "installation-reattached"));
      }
      const response = json({});
      vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return body.promise; });
      return response;
    });
    await f.attach();
    const pending = outcome(f.consumer.refreshCredential(NOW + 1_000));
    await reading.promise;
    f.consumer.forget();
    await f.attach();
    body.resolve(renewed("old-attachment-renewal"));
    await pending;
    expect(f.consumer.status).toBe("active");
    expect(f.stored()).toMatchObject({ installationId: "installation-reattached", credential: "reattached-secret" });
  });

  it("a late registration body cannot overwrite a later explicit owner attachment", async () => {
    const body = deferred<ReturnType<typeof attached>>();
    const reading = deferred<void>();
    let registrations = 0;
    const f = fixture(async () => {
      registrations += 1;
      if (registrations > 1) return json(attached("reattached-secret", "installation-reattached"));
      const response = json({});
      vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return body.promise; });
      return response;
    });
    const pending = outcome(f.attach());
    await reading.promise;
    f.consumer.forget();
    await f.attach();
    body.resolve(attached("old-attachment-secret"));
    await pending;
    expect(f.consumer.status).toBe("active");
    expect(f.stored()).toMatchObject({ installationId: "installation-reattached", credential: "reattached-secret" });
  });

  it("a stale refresh 401 cannot clear a later explicit owner attachment", async () => {
    const stale = deferred<Response>();
    let registrations = 0;
    const f = fixture(async url => {
      if (url.endsWith("/register")) {
        registrations += 1;
        return json(registrations === 1 ? attached() : attached("reattached-secret", "installation-reattached"));
      }
      return stale.promise;
    });
    await f.attach();
    const pending = outcome(f.consumer.refreshCredential(NOW + 1_000));
    f.consumer.forget();
    await f.attach();
    stale.resolve(new Response(null, { status: 401 }));
    await pending;
    expect(f.stored()).toMatchObject({ installationId: "installation-reattached", credential: "reattached-secret" });
    expect(f.consumer.status).toBe("active");
  });

  it("a heartbeat body arriving after forget cannot report the old identity active", async () => {
    const body = deferred<{ installation: typeof installation }>();
    const reading = deferred<void>();
    const f = fixture(async url => {
      if (url.endsWith("/register")) return json(attached());
      const response = json({});
      vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return body.promise; });
      return response;
    });
    await f.attach();
    const pending = outcome(f.consumer.heartbeat(NOW + 1_000));
    await reading.promise;
    f.consumer.forget();
    body.resolve({ installation });
    const result = await pending;
    if (result.status === "fulfilled") {
      expect(result.value.status).not.toBe("active");
      expect(result.value.installationId).toBeNull();
    }
    expect(f.stored()).toMatchObject({ installationId: null, credential: null });
  });

  it("an old heartbeat success cannot claim the identity of a superseded attachment", async () => {
    const stale = deferred<Response>();
    let registrations = 0;
    const f = fixture(async url => {
      if (url.endsWith("/register")) {
        registrations += 1;
        return json(registrations === 1 ? attached() : attached("second-secret", "installation-second"));
      }
      return stale.promise;
    });
    await f.attach();
    const pending = outcome(f.consumer.heartbeat(NOW + 1_000));
    f.consumer.forget();
    await f.attach();
    stale.resolve(json({ installation }));
    const result = await pending;
    if (result.status === "fulfilled") expect(result.value.installationId).not.toBe(installation.id);
    expect(f.stored()).toMatchObject({ installationId: "installation-second", credential: "second-secret" });
  });

  it("overlapping refresh calls share one request and preserve the single winning credential", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let refreshRequests = 0;
    const f = fixture(async url => {
      if (url.endsWith("/register")) return json(attached());
      refreshRequests += 1;
      return refreshRequests === 1 ? first.promise : second.promise;
    });
    await f.attach();
    const a = outcome(f.consumer.refreshCredential(NOW + 1_000));
    const b = outcome(f.consumer.refreshCredential(NOW + 1_000));
    const observedRequests = refreshRequests;
    first.resolve(json(renewed()));
    const resultA = await a;
    second.resolve(new Response(null, { status: 401 }));
    const resultB = await b;
    expect(observedRequests).toBe(1);
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
    expect(f.stored()?.credential).toBe("renewed-secret");
  });

  it("an old heartbeat 401 waits for an already minted refresh body without clearing its winner", async () => {
    const body = deferred<ReturnType<typeof renewed>>();
    const reading = deferred<void>();
    const selfResponse = deferred<Response>();
    let selfRequests = 0;
    let refreshRequests = 0;
    const f = fixture(async url => {
      if (url.endsWith("/register")) return json(attached());
      if (url.endsWith("/refresh")) {
        refreshRequests += 1;
        const response = json({});
        vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return body.promise; });
        return response;
      }
      selfRequests += 1;
      return selfResponse.promise;
    });
    await f.attach();
    const heartbeat = outcome(f.consumer.heartbeat(NOW + 999));
    const refresh = outcome(f.consumer.refreshCredential(NOW + 1_000));
    await reading.promise;
    selfResponse.resolve(new Response(null, { status: 401 }));
    // Drain response handlers without waiting for heartbeat: the correct
    // implementation may wait for renewal before classifying this old 401.
    await new Promise<void>(resolve => setImmediate(resolve));
    body.resolve(renewed());
    const refreshResult = await refresh;
    const heartbeatResult = await heartbeat;
    expect(selfRequests).toBe(1);
    expect(refreshRequests).toBe(1);
    expect(refreshResult.status).toBe("fulfilled");
    if (heartbeatResult.status === "fulfilled") {
      expect(["active", "expiring"]).toContain(heartbeatResult.value.status);
      expect(heartbeatResult.value.installationId).toBe(installation.id);
    }
    expect(f.consumer.status).toBe("active");
    expect(f.stored()).toMatchObject({ installationId: installation.id, credential: "renewed-secret" });
  });

  it("a current heartbeat 401 is still authoritative when its overlapping refresh fails", async () => {
    const selfResponse = deferred<Response>();
    const refreshResponse = deferred<Response>();
    let selfRequests = 0;
    let refreshRequests = 0;
    const f = fixture(async url => {
      if (url.endsWith("/register")) return json(attached());
      if (url.endsWith("/refresh")) {
        refreshRequests += 1;
        return refreshResponse.promise;
      }
      selfRequests += 1;
      return selfResponse.promise;
    });
    await f.attach();
    const heartbeat = outcome(f.consumer.heartbeat(NOW + 999));
    const refresh = outcome(f.consumer.refreshCredential(NOW + 1_000));
    selfResponse.resolve(new Response(null, { status: 401 }));
    await new Promise<void>(resolve => setImmediate(resolve));
    refreshResponse.resolve(new Response(null, { status: 503 }));
    const refreshResult = await refresh;
    const heartbeatResult = await heartbeat;
    expect(selfRequests).toBe(1);
    expect(refreshRequests).toBe(1);
    expect(refreshResult.status).toBe("rejected");
    if (heartbeatResult.status === "fulfilled") {
      expect(["active", "expiring"]).not.toContain(heartbeatResult.value.status);
    }
    expect(f.stored()).toMatchObject({ installationId: null, credential: null });
    const callsBeforeRetry = f.calls.length;
    await outcome(f.consumer.heartbeat(NOW + 2_000));
    expect(f.calls.length).toBe(callsBeforeRetry);
  });

  it("a heartbeat waiting on an existing refresh cannot report unchecked active after transport failure", async () => {
    const failRefresh = deferred<void>();
    let refreshRequests = 0;
    const f = fixture(async url => {
      if (url.endsWith("/register")) return json(attached());
      if (url.endsWith("/refresh")) {
        refreshRequests += 1;
        await failRefresh.promise;
        throw new Error("simulated offline authority");
      }
      return new Response(null, { status: 401 });
    });
    await f.attach();
    const refresh = outcome(f.consumer.refreshCredential(NOW + 1_000));
    const heartbeat = outcome(f.consumer.heartbeat(NOW + 1_001));
    failRefresh.resolve();
    const refreshResult = await refresh;
    const heartbeatResult = await heartbeat;
    expect(refreshRequests).toBe(1);
    expect(refreshResult.status).toBe("rejected");
    if (heartbeatResult.status === "fulfilled") {
      expect(["active", "expiring"]).not.toContain(heartbeatResult.value.status);
    }
  });

  it.each([
    { label: "missing installation", body: {} },
    { label: "different installation", body: { installation: { ...installation, id: "installation-foreign" } } },
    { label: "revoked installation", body: { installation: { ...installation, revokedAt: NOW + 1_000 } } },
  ])("does not report active for a $label heartbeat", async ({ body }) => {
    const f = fixture(async url => url.endsWith("/register") ? json(attached()) : json(body));
    await f.attach();
    const result = await outcome(f.consumer.heartbeat(NOW + 1_000));
    if (result.status === "fulfilled") {
      expect(["active", "expiring"]).not.toContain(result.value.status);
    }
    expect(f.stored()?.installationId).not.toBe("installation-foreign");
  });

  it.each(["registration", "refresh"])("does not report or send a minted credential after %s storage fails", async phase => {
    let restore: (() => void) | undefined;
    let mintRequests = 0;
    const f = fixture(async url => {
      if ((phase === "registration" && url.endsWith("/register")) || (phase === "refresh" && url.endsWith("/refresh"))) {
        mintRequests += 1;
        // The request reached the authority before local persistence fails.
        // Blocking before register would only exercise its stable-key preflight.
        restore ??= blockCredentialReplacement(f.path);
      }
      if (url.endsWith("/register")) return json(attached());
      if (url.endsWith("/refresh")) return json(renewed());
      return json({ installation });
    });
    if (phase === "refresh") await f.attach();
    const callsBeforeMint = f.calls.length;
    try {
      const result = phase === "registration"
        ? await outcome(f.attach())
        : await outcome(f.consumer.refreshCredential(NOW + 1_000));
      const statusAfterFailure = f.consumer.status;
      const callsAfterFailure = f.calls.length;
      expect(mintRequests).toBe(1);
      expect(callsAfterFailure - callsBeforeMint).toBe(1);
      await outcome(f.consumer.heartbeat(NOW + 2_000));
      await outcome(f.consumer.refreshCredential(NOW + 2_000));
      expect(result.status).toBe("rejected");
      expect(f.consumer.isDurable).toBe(false);
      expect(["active", "expiring"]).not.toContain(statusAfterFailure);
      expect(f.calls.length).toBe(callsAfterFailure);
    } finally {
      restore?.();
    }
  });

  it("does not send registration when its stable attachment intent cannot be persisted", async () => {
    const f = fixture(async () => json(attached()));
    const restore = blockCredentialReplacement(f.path);
    try {
      const result = await outcome(f.attach());
      expect(result.status).toBe("rejected");
      expect(f.calls).toHaveLength(0);
      expect(f.consumer.isDurable).toBe(false);
      expect(["active", "expiring"]).not.toContain(f.consumer.status);
    } finally {
      restore();
    }
  });

  it("explicit attachment to a different authority survives restart without sharing either secret", async () => {
    const f = fixture(async () => json(attached()));
    await f.attach();
    const key = f.consumer.clientKey;
    const nextAuthority = "https://second-owned-installation.test";
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchJson: FetchLike = async (url, init) => {
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/register")) return json(attached("second-authority-secret", "second-authority-installation"));
      return json({ installation: { ...installation, id: "second-authority-installation" } });
    };
    const changed = new InstallationConsumer({ dataDirectory: f.directory, baseUrl: nextAuthority, fetchJson }, NOW);
    expect(changed.clientKey).toBe(key);
    expect(changed.status).toBe("unregistered");
    await changed.registerThroughOwner("second-owned-session=fixture", {
      clientKey: changed.clientKey, label: "Owned machine", platform: "macos",
    }, NOW + 1_000);
    const restarted = new InstallationConsumer({ dataDirectory: f.directory, baseUrl: nextAuthority, fetchJson }, NOW + 2_000);
    expect(restarted.clientKey).toBe(key);
    expect(restarted.status).toBe("active");
    const report = await restarted.heartbeat(NOW + 2_000);
    expect(report.installationId).toBe("second-authority-installation");
    expect(calls).toEqual([
      { url: `${nextAuthority}/api/installations/register`, authorization: null },
      { url: `${nextAuthority}/api/installations/self`, authorization: "Bearer second-authority-secret" },
    ]);
    expect(loadPersistedInstallation(f.path, nextAuthority)).toMatchObject({
      authority: nextAuthority, clientKey: key, installationId: "second-authority-installation", credential: "second-authority-secret",
    });
    expect(f.stored()).toMatchObject({ clientKey: key, installationId: null, credential: null });
  });
});
