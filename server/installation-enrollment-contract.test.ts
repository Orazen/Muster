// W1b enrollment contract — synthetic, discriminating, default-off.
//
// Written against the INDEPENDENT REVIEW of 2 October 2026, which reproduced
// five P1 blockers and three P2 gaps against an earlier draft that passed 39
// of its own tests. Every one of those nine findings has a regression here,
// named after the finding it pins. Passing this suite is not evidence those
// defects are gone — the point is that each one now fails loudly if it
// returns.
//
// No network, no real account, no real protected storage, no route. Every
// identity is synthetic and every store is an in-memory fake.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { FileFencePersistence } from "./installation-fence-persistence.ts";
import {
  ENROLLMENT_INTENT_TTL_MS,
  ENROLLMENT_PROTOCOL_VERSION,
  MemoryAttemptStore,
  MemoryProtectedStore,
  cancelEnrollment,
  createEnrollmentEngine,
  endEnrollmentContext,
  enrollmentEnabled,
  invalidateEnrollmentContext,
  fenceEnrollmentKey,
  isEnrollmentKeyFenced,
  resetEnrollmentFences,
  setEnrollmentFencePersistence,
  mintEnrollmentVerifier,
  ordinaryLoginEffect,
  secretsMatch,
  verifyEnrollmentProof,
} from "./installation-enrollment-contract.ts";
import type {
  CustodyRead,
  EnrollmentBinding,
  EnrollmentContext,
  EnrollmentDeps,
  EnrollmentRedirectPolicy,
  EnrollmentRequest,
  TrustedCloudConfig,
  UpstreamExchange,
  UpstreamHeaders,
} from "./installation-enrollment-contract.ts";

const NOW = 1_760_000_000_000;
const STATE = "state-synthetic-0123456789abcdef";
const CLIENT_KEY = "client-key-synthetic-0001";
const REDIRECT = "loopback://127.0.0.1:53411/oauth/finish";
const FOREIGN_REDIRECT = "https://foreign.fixture.invalid/callback";

/** The deployment's server-owned cloud configuration. */
const TRUSTED: TrustedCloudConfig = {
  issuer: "https://cloud.synthetic.invalid",
  approvedRedirects: {
    macos: REDIRECT,
    ios: "muster://oauth/finish",
    watchos: "muster://watch/oauth/finish",
    android: "muster://android/oauth/finish",
    windows: "http://127.0.0.1:53412/oauth/finish",
    linux: "http://127.0.0.1:53413/oauth/finish",
    cli: "http://127.0.0.1:53414/oauth/finish",
    web: "https://app.synthetic.invalid/oauth/finish",
  } satisfies EnrollmentRedirectPolicy,
};

/** The shared fence registry persists by default under the data dir, so this
 * suite points it at an ISOLATED temp file before any engine is constructed:
 * tests neither touch a real data dir nor observe fences from another run.
 * The suite's own persistence instance stays reachable so cases can swap a
 * different store in through the seam and restore this one afterwards. */
const fenceDirectory = mkdtempSync(join(tmpdir(), "muster-enrollment-fence-"));
const suiteFencePersistence = new FileFencePersistence({
  path: join(fenceDirectory, "enrollment-fence.json"),
});
setEnrollmentFencePersistence(suiteFencePersistence);
afterAll(() => {
  rmSync(fenceDirectory, { recursive: true, force: true });
});

/** Shipped posture: inert. */
const inert = createEnrollmentEngine({ enabled: enrollmentEnabled, trusted: TRUSTED });
/** Opted-in, so the rules can actually be driven. */
const active = createEnrollmentEngine({ enabled: true, trusted: TRUSTED });

const CONTEXT: EnrollmentContext = {
  ownerId: "local-owner-synthetic-a",
  sessionId: "local-session-synthetic-a",
  endpoint: REDIRECT.replace("/oauth/finish", ""),
};

const BINDING: EnrollmentBinding = {
  cloudSubject: "cloud-subject-synthetic-a",
  cloudIssuer: TRUSTED.issuer,
  cloudAuthority: TRUSTED.issuer,
  workspaceId: "workspace-synthetic-a",
  clientKey: CLIENT_KEY,
  localOwnerId: CONTEXT.ownerId,
  localSessionId: CONTEXT.sessionId,
  cloudSessionValid: true,
};

const OTHER_ACCOUNT: EnrollmentBinding = {
  cloudSubject: "cloud-subject-synthetic-b",
  cloudIssuer: TRUSTED.issuer,
  cloudAuthority: TRUSTED.issuer,
  workspaceId: "workspace-synthetic-b",
  clientKey: CLIENT_KEY,
  localOwnerId: "local-owner-synthetic-b",
  localSessionId: "local-session-synthetic-b",
  cloudSessionValid: true,
};

const CREDENTIAL = "credential-issued-by-upstream";

/** A complete, valid request. Cases vary one field through `withRequest`. */
function validRequest(): EnrollmentRequest {
  const { challenge } = mintEnrollmentVerifier();
  return {
    protocolVersion: ENROLLMENT_PROTOCOL_VERSION,
    purpose: "add-device",
    platform: "macos",
    label: "Synthetic Test Machine",
    clientKey: CLIENT_KEY,
    deviceConfirmed: true,
    state: STATE,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    redirect: REDIRECT,
    expiresAt: NOW + 120_000,
  } satisfies EnrollmentRequest;
}

function withRequest(overrides: Partial<EnrollmentRequest>): EnrollmentRequest {
  return { ...validRequest(), ...overrides };
}

/** A deferred, so a test can hold one awaited stage open deterministically. */
function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Deps plus the concrete fakes and the live-state seams a test drives. */
type Harness = Omit<EnrollmentDeps, "attempts" | "store"> & {
  store: MemoryProtectedStore;
  attempts: MemoryAttemptStore;
  exchangeCalls: () => number;
  setLiveContext(next: EnrollmentContext): void;
  setLiveCloudSessionValid(next: boolean): void;
  setClock(next: number): void;
  clock: () => number;
};

function makeDeps(overrides: Partial<Omit<EnrollmentDeps, "attempts" | "store">> = {}): Harness {
  const store = new MemoryProtectedStore();
  const attempts = new MemoryAttemptStore();
  // Live state a test mutates mid-flight. Held by the harness rather than
  // captured at call time: the whole point of the post-await guards is to
  // observe a change that happens while an awaited stage is open.
  let liveContext: EnrollmentContext = { ...CONTEXT };
  let liveCloudSessionValid = true;
  let clock = NOW;
  let calls = 0;

  const deps: Harness = {
    attempts,
    store,
    exchangeCalls: () => calls,
    setLiveContext: (next) => {
      liveContext = next;
    },
    setLiveCloudSessionValid: (next) => {
      liveCloudSessionValid = next;
    },
    setClock: (next) => {
      clock = next;
    },
    clock: () => clock,
    currentContext: () => liveContext,
    cloudSessionValid: () => liveCloudSessionValid,
    now: () => clock,
    noteGeneration: (clientKey, generation) => store.noteGeneration(clientKey, generation),
    exchange: async (binding): Promise<UpstreamExchange> => {
      calls += 1;
      return {
        headers: {
          installationId: "installation-synthetic-0001",
          cloudSubject: binding.cloudSubject,
          authority: binding.cloudAuthority,
          capability: "workspace",
          credentialExpiresAt: NOW + 86_400_000,
        },
        credential: CREDENTIAL,
      };
    },
    mintInstallationId: () => "installation-synthetic-0001",
    ...overrides,
  };
  return deps;
}

const opts = (
  verifier: string,
  state = STATE,
  over: Partial<Parameters<typeof active.complete>[1]> = {},
) => ({
  context: { ...CONTEXT },
  cloudSessionValid: true as const,
  verifier,
  state,
  deviceConfirmed: true,
  ...over,
});

type ClientProof = { verifier: string; request: EnrollmentRequest; state: string };

/** A client-side PKCE pair. The verifier belongs to the client and the server
 * never holds one. */
function clientProof(overrides: Partial<EnrollmentRequest> = {}): ClientProof {
  const { verifier, challenge } = mintEnrollmentVerifier();
  return { verifier, state: STATE, request: withRequest({ codeChallenge: challenge, ...overrides }) };
}

async function beginOk(
  deps: Harness,
  pair?: ClientProof,
  binding: EnrollmentBinding = BINDING,
  context: EnrollmentContext = CONTEXT,
): Promise<{ intentId: string; verifier: string; state: string }> {
  const proof = pair ?? clientProof();
  const started = await active.begin(proof.request, binding, context, deps);
  if (!started.ok) throw new Error(`begin unexpectedly failed: ${started.reason}`);
  return { intentId: started.value.intentId, verifier: proof.verifier, state: proof.state };
}

/** Let queued microtasks run so an awaited stage is genuinely in flight. */
const settle = () => new Promise((r) => setImmediate(r));

describe("W1b enrollment contract", () => {
  describe("shipped posture: disabled, and nothing is reachable", () => {
    it("ships with enrollment off", () => {
      expect(enrollmentEnabled).toBe(false);
    });

    it("refuses to begin while disabled and mints nothing", async () => {
      let announcements = 0;
      const deps = makeDeps({ noteGeneration: () => { announcements += 1; } });
      expect(await inert.begin(validRequest(), BINDING, CONTEXT, deps)).toEqual({ ok: false, reason: "disabled" });
      expect(deps.attempts.rows.size).toBe(0);
      expect(deps.store.keys()).toEqual([]);
      expect(deps.exchangeCalls()).toBe(0);
      expect(announcements).toBe(0);
    });

    it("refuses to complete while disabled, spending nothing", async () => {
      const deps = makeDeps();
      expect(await inert.complete("never-existed", opts("x" in {} ? "" : "v"), deps)).toEqual({
        ok: false,
        reason: "disabled",
      });
      expect(deps.exchangeCalls()).toBe(0);
    });

    it("no longer exports a reattachment path", async () => {
      // Review P1: the self-issued reattach accepted a caller-minted proof for
      // a caller-supplied record with no registry lookup. It is removed rather
      // than patched, because recovery needs the full authenticated exchange.
      const module = await import("./installation-enrollment-contract.ts");
      expect("reattachEnrollment" in module).toBe(false);
      expect("reattach" in active).toBe(false);
    });

    it("records the ordinary-login intent as SYNTHETIC, not as HTTP evidence", () => {
      // Review: this helper returns constants and proves nothing about a real
      // route. It is retained as a declaration, and the naming says so.
      expect(ordinaryLoginEffect()).toEqual({ registrations: 0, authority: 0, permissions: 0 });
    });
  });

  describe("awaited generation announcement", () => {
    afterEach(() => resetEnrollmentFences());

    it("does not return a successful begin before a held announcement finishes", async () => {
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      deps.noteGeneration = async (clientKey, generation) => {
        entered.release();
        await held.promise;
        deps.store.noteGeneration(clientKey, generation);
      };
      const proof = clientProof();
      let returned = false;
      const pending = active.begin(proof.request, BINDING, CONTEXT, deps).then((result) => {
        returned = true;
        return result;
      });
      await entered.promise;
      await settle();
      try {
        expect(returned).toBe(false);
        expect(deps.exchangeCalls()).toBe(0);
        expect(deps.store.keys()).toEqual([]);
      } finally {
        held.release();
      }
      const started = await pending;
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error("current begin failed");
      expect(await active.complete(started.value.intentId, opts(proof.verifier), deps)).toMatchObject({ ok: true });
      expect(deps.exchangeCalls()).toBe(1);
      expect(deps.store.credential(CLIENT_KEY)).toBe(CREDENTIAL);
    });

    it.each(["synchronous", "omitted"] as const)("retains a %s announcement adapter", async (kind) => {
      resetEnrollmentFences();
      const deps = makeDeps(kind === "omitted" ? { noteGeneration: undefined } : {});
      const started = await beginOk(deps);
      expect(await active.complete(started.intentId, opts(started.verifier), deps)).toMatchObject({ ok: true });
      expect(deps.exchangeCalls()).toBe(1);
    });

    it.each(["throw", "reject-after-write"] as const)("fences a failed %s announcement and retires its intent", async (kind) => {
      resetEnrollmentFences();
      const deps = makeDeps();
      deps.noteGeneration = kind === "throw"
        ? () => { throw new Error("synthetic announcement failed"); }
        : async (clientKey, generation) => {
          deps.store.noteGeneration(clientKey, generation);
          throw new Error("synthetic announcement wrote then failed");
        };
      const proof = clientProof();
      expect(await active.begin(proof.request, BINDING, CONTEXT, deps)).toEqual({ ok: false, reason: "custody-unresolved" });
      const intent = deps.attempts.listIntents()[0];
      expect(intent.invalidatedAt).toBe(NOW);
      expect(await active.complete(intent.id, opts(proof.verifier), deps)).toMatchObject({ ok: false });
      expect(deps.exchangeCalls()).toBe(0);
      expect(deps.store.keys()).toEqual([]);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
      expect(suiteFencePersistence.read()).toContain(CLIENT_KEY);
      expect(await active.begin(clientProof().request, BINDING, CONTEXT, deps)).toEqual({ ok: false, reason: "custody-unresolved" });

      // A key-local failure does not cancel another device's enrollment.
      deps.noteGeneration = (clientKey, generation) => deps.store.noteGeneration(clientKey, generation);
      const otherKey = "client-key-synthetic-unrelated";
      const otherProof = clientProof({ clientKey: otherKey });
      const other = await beginOk(deps, otherProof, { ...BINDING, clientKey: otherKey });
      expect(await active.complete(other.intentId, opts(other.verifier), deps)).toMatchObject({ ok: true });
      expect(deps.store.keys()).toEqual([otherKey]);
    });

    const invalidators = [
      { kind: "cancel", reason: "cancelled" },
      { kind: "end-context", reason: "cancelled" },
      { kind: "owner", reason: "local-owner" },
      { kind: "session", reason: "session-changed" },
      { kind: "endpoint", reason: "endpoint-changed" },
      { kind: "cloud-session", reason: "subject" },
      { kind: "expiry", reason: "expired" },
      { kind: "fence", reason: "custody-unresolved" },
    ] as const;

    it.each(invalidators)("rechecks $kind after a held announcement", async ({ kind, reason }) => {
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      deps.noteGeneration = async (clientKey, generation) => {
        entered.release();
        await held.promise;
        deps.store.noteGeneration(clientKey, generation);
      };
      const proof = clientProof();
      const pending = active.begin(proof.request, BINDING, CONTEXT, deps);
      await entered.promise;
      const intent = deps.attempts.listIntents()[0];
      try {
        switch (kind) {
          case "cancel": await cancelEnrollment(intent.id, deps); break;
          case "end-context": await endEnrollmentContext(CONTEXT, deps); break;
          case "owner": deps.setLiveContext({ ...CONTEXT, ownerId: "owner-replacement" }); break;
          case "session": deps.setLiveContext({ ...CONTEXT, sessionId: "session-replacement" }); break;
          case "endpoint": deps.setLiveContext({ ...CONTEXT, endpoint: "https://replacement.synthetic.invalid" }); break;
          case "cloud-session": deps.setLiveCloudSessionValid(false); break;
          case "expiry": deps.setClock(NOW + ENROLLMENT_INTENT_TTL_MS); break;
          case "fence": fenceEnrollmentKey(CLIENT_KEY); break;
        }
      } finally {
        held.release();
      }
      expect(await pending).toEqual({ ok: false, reason });
      expect((await deps.attempts.peekIntent(intent.id))?.invalidatedAt).not.toBeNull();
      expect(await active.complete(intent.id, opts(proof.verifier), deps)).toMatchObject({ ok: false });
      expect(deps.exchangeCalls()).toBe(0);
      expect(deps.store.keys()).toEqual([]);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(kind === "fence");
    });

    it("a held older announcement cannot report success or erase a committed newer winner", async () => {
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      deps.noteGeneration = async (clientKey, generation) => {
        if (generation === "1") {
          entered.release();
          await held.promise;
        }
        deps.store.noteGeneration(clientKey, generation);
      };
      const olderProof = clientProof();
      const older = active.begin(olderProof.request, BINDING, CONTEXT, deps);
      await entered.promise;
      const olderIntent = deps.attempts.listIntents()[0];
      let winner: CustodyRead | undefined;
      try {
        const newer = await beginOk(deps);
        expect(await active.complete(newer.intentId, opts(newer.verifier), deps)).toMatchObject({ ok: true });
        winner = await deps.store.read(CLIENT_KEY);
        expect(winner).toMatchObject({ kind: "present", record: { storedGeneration: "2" } });
      } finally {
        held.release();
      }
      expect(await older).toEqual({ ok: false, reason: "superseded" });
      expect(await deps.store.read(CLIENT_KEY)).toEqual(winner);
      expect(deps.store.credential(CLIENT_KEY)).toBe(CREDENTIAL);
      expect(await active.complete(olderIntent.id, opts(olderProof.verifier), deps)).toEqual({ ok: false, reason: "superseded" });
      expect(deps.exchangeCalls()).toBe(1);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(false);
    });

    it.each(["refused", "rejected", "read-rejected"] as const)("fences %s intent retirement instead of claiming cleanup", async (fault) => {
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      deps.noteGeneration = async (clientKey, generation) => {
        entered.release();
        await held.promise;
        deps.store.noteGeneration(clientKey, generation);
      };
      const pending = active.begin(clientProof().request, BINDING, CONTEXT, deps);
      await entered.promise;
      deps.setLiveContext({ ...CONTEXT, sessionId: "session-replacement" });
      if (fault === "refused") deps.attempts.invalidateIntent = async () => false;
      if (fault === "rejected") deps.attempts.invalidateIntent = async () => { throw new Error("synthetic invalidation failed"); };
      if (fault === "read-rejected") {
        const peek = deps.attempts.peekIntent.bind(deps.attempts);
        let reads = 0;
        deps.attempts.peekIntent = async (id) => {
          if (++reads === 2) throw new Error("synthetic retirement read failed");
          return peek(id);
        };
      }
      held.release();
      expect(await pending).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
      expect(suiteFencePersistence.read()).toContain(CLIENT_KEY);
      expect(deps.exchangeCalls()).toBe(0);
      expect(deps.store.keys()).toEqual([]);
      expect(await active.begin(clientProof().request, BINDING, CONTEXT, deps)).toEqual({ ok: false, reason: "custody-unresolved" });
    });

    it("a failing older announcement fences uncertainty while retaining the newer credential", async () => {
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      deps.noteGeneration = async (clientKey, generation) => {
        if (generation === "1") {
          entered.release();
          await held.promise;
          throw new Error("synthetic older announcement failed");
        }
        deps.store.noteGeneration(clientKey, generation);
      };
      const older = active.begin(clientProof().request, BINDING, CONTEXT, deps);
      await entered.promise;
      let winner: CustodyRead | undefined;
      try {
        const newer = await beginOk(deps);
        expect(await active.complete(newer.intentId, opts(newer.verifier), deps)).toMatchObject({ ok: true });
        winner = await deps.store.read(CLIENT_KEY);
      } finally {
        held.release();
      }
      expect(await older).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(await deps.store.read(CLIENT_KEY)).toEqual(winner);
      expect(deps.store.credential(CLIENT_KEY)).toBe(CREDENTIAL);
      expect(deps.exchangeCalls()).toBe(1);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
      expect(suiteFencePersistence.read()).toContain(CLIENT_KEY);
    });
  });

  describe("P1 — cancellation and supersession keep custody", () => {
    it("cancellation during a HELD exchange prevents the credential being stored", async () => {
      // Review P1.1: cancel used to return false for an in-flight attempt and
      // the completion went on to store a credential.
      const held = gate();
      const deps = makeDeps({
        exchange: async (binding) => {
          await held.promise;
          return {
            headers: {
              installationId: "installation-synthetic-0001",
              cloudSubject: binding.cloudSubject,
              authority: binding.cloudAuthority,
              capability: "workspace",
              credentialExpiresAt: NOW + 86_400_000,
            },
            credential: CREDENTIAL,
          };
        },
      });
      const { intentId, verifier } = await beginOk(deps);

      const completing = active.complete(intentId, opts(verifier), deps);
      await settle();
      const cancelled = await cancelEnrollment(intentId, deps);
      held.release();
      const result = await completing;

      expect(cancelled).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("cancelled");
      // The critical assertion: nothing usable was written.
      expect(deps.store.keys()).toEqual([]);
      expect(deps.store.credential(CLIENT_KEY)).toBeNull();
    });

    it("cancellation during a HELD protected commit inactivates the stale record", async () => {
      // Review P1.2: a write landing after invalidation is still usable after a
      // restart, so the record is inactivated rather than left in place.
      const held = gate();
      const deps = makeDeps();
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await held.promise;
        return result;
      };
      const { intentId, verifier } = await beginOk(deps);

      const completing = active.complete(intentId, opts(verifier), deps);
      await settle();
      await cancelEnrollment(intentId, deps);
      held.release();
      const result = await completing;

      expect(result.ok).toBe(false);
      // Not merely refused: the record that was already written is gone, so a
      // restart cannot resurrect it.
      expect(deps.store.keys()).toEqual([]);
      expect(deps.store.credential(CLIENT_KEY)).toBeNull();
    });

    it("a new begin SUPERSEDES the previous attempt for the same device", async () => {
      // Review P1.1: two same-device begins left the older one completable.
      const deps = makeDeps();
      const first = await beginOk(deps);
      await beginOk(deps);

      const result = await active.complete(first.intentId, opts(first.verifier), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("superseded");
      expect(deps.store.keys()).toEqual([]);
    });

    it("the newest attempt for a device still completes", async () => {
      // Supersession must not break the winner — that is the whole point of
      // ordering by generation rather than deleting the older row.
      const deps = makeDeps();
      await beginOk(deps);
      const second = await beginOk(deps);
      const result = await active.complete(second.intentId, opts(second.verifier), deps);
      expect(result.ok).toBe(true);
    });

    it("shutdown/sign-out invalidation stops an in-flight attempt with unchanged identity", async () => {
      // Review P1.1: cancellation and shutdown must invalidate even when the
      // identity fields are identical — the SESSION changed underneath.
      const held = gate();
      const deps = makeDeps({
        exchange: async (binding) => {
          await held.promise;
          return {
            headers: {
              installationId: "installation-synthetic-0001",
              cloudSubject: binding.cloudSubject,
              authority: binding.cloudAuthority,
              capability: "workspace",
              credentialExpiresAt: NOW + 86_400_000,
            },
            credential: CREDENTIAL,
          };
        },
      });
      const { intentId, verifier } = await beginOk(deps);
      const completing = active.complete(intentId, opts(verifier), deps);
      await settle();
      // Same owner, same session id, same endpoint: only the SESSION's
      // validity changed, which is what a shutdown looks like.
      deps.setLiveCloudSessionValid(false);
      held.release();
      const result = await completing;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("subject");
      expect(deps.store.keys()).toEqual([]);
    });
  });

  describe("P1 — binding ownership and canonical authority are enforced", () => {
    it("refuses a binding whose owner is not the authenticated owner", async () => {
      // Review P1.3: binding owner A completed under live owner B and stored
      // owner A.
      const deps = makeDeps();
      const live: EnrollmentContext = { ...CONTEXT, ownerId: "local-owner-synthetic-b" };
      const started = await active.begin(validRequest(), BINDING, live, deps);
      expect(started).toEqual({ ok: false, reason: "local-owner" });
      expect(deps.attempts.rows.size).toBe(0);
    });

    it("refuses a binding whose session is not the authenticated session", async () => {
      const deps = makeDeps();
      const live: EnrollmentContext = { ...CONTEXT, sessionId: "local-session-synthetic-b" };
      expect(await active.begin(validRequest(), BINDING, live, deps)).toEqual({
        ok: false,
        reason: "local-session",
      });
    });

    it("refuses an authority that is not the deployment's trusted issuer", async () => {
      // Review P1.3: `not-an-origin` was accepted as an authority.
      const deps = makeDeps();
      expect(await active.begin(validRequest(), { ...BINDING, cloudAuthority: "not-an-origin" }, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "authority",
      });
      expect(deps.attempts.rows.size).toBe(0);
    });

    it("refuses an upstream that answers with a different authority", async () => {
      const deps = makeDeps({
        exchange: async (binding) => ({
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: binding.cloudSubject,
            authority: "https://attacker.synthetic.invalid",
            capability: "workspace",
            credentialExpiresAt: NOW + 86_400_000,
          },
          credential: CREDENTIAL,
        }),
      });
      const { intentId, verifier } = await beginOk(deps);
      // Mutation: accept any authority header → this completes.
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({ ok: false, reason: "authority" });
      expect(deps.store.keys()).toEqual([]);
    });

    it("does not let an email stand in for the canonical cloud subject", async () => {
      const deps = makeDeps();
      // Refused AT THE BOUNDARY, so there is no later stage where a local
      // email could be promoted to a cloud identity.
      expect(await active.begin(validRequest(), { ...BINDING, cloudSubject: "someone@example.test" }, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "subject",
      });
      expect(deps.exchangeCalls()).toBe(0);
    });

    it("refuses an upstream that answers with an email subject", async () => {
      const deps = makeDeps({
        exchange: async () => ({
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: "someone@example.test",
            authority: BINDING.cloudAuthority,
            capability: "workspace",
            credentialExpiresAt: NOW + 86_400_000,
          },
          credential: CREDENTIAL,
        }),
      });
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({ ok: false, reason: "subject" });
      expect(deps.store.keys()).toEqual([]);
    });
  });

  describe("P1 — the issued credential reaches protected custody", () => {
    it("hands the exact issued credential to the custody adapter", async () => {
      // Review P1.5: the credential was checked for truthiness and then
      // discarded, so no conforming sealer could protect it.
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(true);
      // The round-trip: the secret survived protected persistence.
      expect(deps.store.credential(CLIENT_KEY)).toBe(CREDENTIAL);
    });

    it("never returns the credential in the outcome", async () => {
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Metadata only. A credential in the outcome would recreate the leak.
      expect(Object.keys(result.value).sort()).toEqual([
        "capabilities",
        "clientKey",
        "credentialExpiresAt",
        "envelopeVersion",
        "installationId",
        "platform",
      ]);
      expect(JSON.stringify(result.value)).not.toContain(CREDENTIAL);
    });

    it("the stored envelope carries no plaintext credential", async () => {
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      await active.complete(intentId, opts(verifier), deps);
      const row = deps.store.row(CLIENT_KEY);
      expect(row).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain(CREDENTIAL);
      // But it does carry the authenticated bindings an adapter needs.
      expect(row?.cloudAuthority).toBe(TRUSTED.issuer);
      expect(row?.localSessionId).toBe(CONTEXT.sessionId);
      expect(row?.credentialExpiresAt).toBe(NOW + 86_400_000);
    });

    it("leaves the credential unusable when custody fails, and says so", async () => {
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      deps.store.failCommitAt = 1;
      // Mutation: report success regardless of the commit → this goes ok.
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "credential-persist-failed",
      });
      expect(deps.store.keys()).toEqual([]);
    });
  });

  describe("P2 — expiry is rechecked at every boundary", () => {
    it("refuses when the intent expires DURING the exchange", async () => {
      // Review P2.1: expiry was checked once, before any await.
      const deps = makeDeps({
        exchange: async (binding) => {
          deps.setClock(NOW + ENROLLMENT_INTENT_TTL_MS + 1_000);
          return {
            headers: {
              installationId: "installation-synthetic-0001",
              cloudSubject: binding.cloudSubject,
              authority: binding.cloudAuthority,
              capability: "workspace",
              credentialExpiresAt: NOW + 86_400_000,
            },
            credential: CREDENTIAL,
          };
        },
      });
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({ ok: false, reason: "expired" });
      expect(deps.store.keys()).toEqual([]);
    });

    it("refuses a credential that arrives already expired", async () => {
      const deps = makeDeps({
        exchange: async (binding) => ({
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: binding.cloudSubject,
            authority: binding.cloudAuthority,
            capability: "workspace",
            credentialExpiresAt: NOW - 1,
          },
          credential: CREDENTIAL,
        }),
      });
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "credential-expired",
      });
      expect(deps.store.keys()).toEqual([]);
    });

    it("refuses a credential with no expiry at all", async () => {
      // `credentialExpiresAt` is required by the schema, so an upstream that
      // omits it cannot be represented without this assertion. Every present
      // field is well-formed; the omission is exactly what is under test.
      const withoutExpiry = {
        installationId: "installation-synthetic-0001",
        cloudSubject: "cloud-subject-synthetic-a",
        authority: TRUSTED.issuer,
        capability: "workspace",
      };
      const deps = makeDeps({
        exchange: async () => {
          // SAFETY: `withoutExpiry` above is a valid `UpstreamHeaders` MINUS the
          // one required field under test, which no typed value can express.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions
          const headers = withoutExpiry as unknown as UpstreamHeaders;
          return { headers, credential: CREDENTIAL };
        },
      });
      const { intentId, verifier } = await beginOk(deps);
      // A credential that never expires is a permanent credential.
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "credential-expired",
      });
    });

    it("refuses an already-expired request at begin", async () => {
      const deps = makeDeps();
      expect(await active.begin(withRequest({ expiresAt: NOW - 1 }), BINDING, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "expired",
      });
    });
  });

  describe("P2 — S256 proof bounds", () => {
    it("rejects a one-character verifier", async () => {
      // Review P2.2: a 1-character verifier satisfied the hash check.
      const deps = makeDeps();
      const verifier = "a";
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      const started = await active.begin(withRequest({ codeChallenge: challenge }), BINDING, CONTEXT, deps);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(await active.complete(started.value.intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "proof",
      });
      expect(deps.store.keys()).toEqual([]);
    });

    it("enforces the RFC 7636 length and alphabet bounds", () => {
      const { verifier, challenge } = mintEnrollmentVerifier();
      expect(verifyEnrollmentProof(verifier, challenge, "S256")).toBe(true);
      // Too short, too long, illegal characters, non-ASCII.
      expect(verifyEnrollmentProof("a".repeat(42), createHash("sha256").update("a".repeat(42)).digest("base64url"), "S256")).toBe(false);
      expect(verifyEnrollmentProof("a".repeat(129), challenge, "S256")).toBe(false);
      expect(verifyEnrollmentProof(`${"a".repeat(42)}+`, createHash("sha256").update(`${"a".repeat(42)}+`).digest("base64url"), "S256")).toBe(false);
      expect(verifyEnrollmentProof(`${"a".repeat(42)}é`, createHash("sha256").update(`${"a".repeat(42)}é`).digest("base64url"), "S256")).toBe(false);
      // Absent, plain method, wrong hash.
      expect(verifyEnrollmentProof("", challenge, "S256")).toBe(false);
      expect(verifyEnrollmentProof(verifier, challenge, "plain")).toBe(false);
      expect(verifyEnrollmentProof(verifier, createHash("sha256").update("other").digest("base64url"), "S256")).toBe(false);
    });
  });

  describe("P2 — the redirect is server-approved", () => {
    it("refuses a redirect the request chose for itself", async () => {
      // Review P2.3: both `redirect` and `approvedRedirect` were request
      // fields, so a request approved its own foreign callback.
      const deps = makeDeps();
      const pair = clientProof({ redirect: FOREIGN_REDIRECT });
      const started = await active.begin(pair.request, BINDING, CONTEXT, deps);
      expect(started).toEqual({ ok: false, reason: "redirect" });
      expect(deps.attempts.rows.size).toBe(0);
    });

    it("refuses a redirect approved for a DIFFERENT platform", async () => {
      const deps = makeDeps();
      // The iOS scheme redirect on a macos enrollment: not the allowlisted
      // value for this platform.
      expect(await active.begin(withRequest({ redirect: "muster://oauth/finish" }), BINDING, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "redirect",
      });
    });

    it("accepts the exact allowlisted redirect for the platform", async () => {
      const deps = makeDeps();
      const { intentId } = await beginOk(deps);
      expect(intentId).not.toBe("");
    });
  });

  describe("guards carried over from the first draft", () => {
    it("refuses an absent or false device confirmation", async () => {
      const deps = makeDeps();
      // SAFETY: `deviceConfirmed` is the literal `true`, so the typed signature
      // already forbids these; the case exists to prove the RUNTIME schema
      // refuses what the type forbids.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      const notConfirmed = { ...withRequest({}), deviceConfirmed: false } as unknown as EnrollmentRequest;
      // SAFETY: as above — an absent confirmation is the other half.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      const absent = { ...withRequest({}), deviceConfirmed: undefined } as unknown as EnrollmentRequest;
      expect(await active.begin(notConfirmed, BINDING, CONTEXT, deps)).toEqual({ ok: false, reason: "purpose" });
      expect(await active.begin(absent, BINDING, CONTEXT, deps)).toEqual({ ok: false, reason: "purpose" });
    });

    it("requires device confirmation to be RE-given at completion", async () => {
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier, STATE, { deviceConfirmed: false }), deps)).toEqual({
        ok: false,
        reason: "device-confirmation",
      });
      expect(deps.exchangeCalls()).toBe(0);
    });

    it("refuses a wrong verifier and spends no upstream call", async () => {
      const deps = makeDeps();
      const { intentId } = await beginOk(deps);
      expect(await active.complete(intentId, opts(mintEnrollmentVerifier().verifier), deps)).toEqual({
        ok: false,
        reason: "proof",
      });
      expect(deps.exchangeCalls()).toBe(0);
    });

    it("refuses a mismatched state echo", async () => {
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier, "a-different-state-value-0000000"), deps)).toEqual({
        ok: false,
        reason: "state",
      });
    });

    it("refuses an endpoint change between begin and complete", async () => {
      // The LIVE endpoint is what is checked — a caller-supplied context is
      // not evidence, which is exactly why the earlier snapshot comparison was
      // wrong. So the test moves the live endpoint, not just the argument.
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      deps.setLiveContext({ ...CONTEXT, endpoint: "loopback://127.0.0.1:59999" });
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "endpoint-changed",
      });
      expect(deps.store.keys()).toEqual([]);
    });

    it("re-checks the session AFTER a held exchange", async () => {
      // The caller's snapshot is unchanged; only the LIVE state moved.
      const deps = makeDeps({
        exchange: async (binding) => {
          deps.setLiveContext({ ...CONTEXT, sessionId: "session-after-signout" });
          return {
            headers: {
              installationId: "installation-synthetic-0001",
              cloudSubject: binding.cloudSubject,
              authority: binding.cloudAuthority,
              capability: "workspace",
              credentialExpiresAt: NOW + 86_400_000,
            },
            credential: CREDENTIAL,
          };
        },
      });
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "session-changed",
      });
      expect(deps.store.keys()).toEqual([]);
    });

    it("refuses a capability this build does not define", async () => {
      const deps = makeDeps({
        exchange: async (binding) => ({
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: binding.cloudSubject,
            authority: binding.cloudAuthority,
            capability: "superuser",
            credentialExpiresAt: NOW + 86_400_000,
          },
          credential: CREDENTIAL,
        }),
      });
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({ ok: false, reason: "capability" });
    });

    it("refuses a header set with no credential body", async () => {
      const deps = makeDeps({
        exchange: async (binding) => ({
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: binding.cloudSubject,
            authority: binding.cloudAuthority,
            capability: "workspace",
            credentialExpiresAt: NOW + 86_400_000,
          },
          credential: "",
        }),
      });
      const { intentId, verifier } = await beginOk(deps);
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({ ok: false, reason: "proof" });
    });

    it("refuses a header set missing a required field", async () => {
      // Every field is required by the schema, so a response missing any of
      // them is refused as an invalid credential response.
      const completeHeaders = (binding: EnrollmentBinding): UpstreamHeaders => ({
        installationId: "installation-synthetic-0001",
        cloudSubject: binding.cloudSubject,
        authority: binding.cloudAuthority,
        capability: "workspace",
        credentialExpiresAt: NOW + 86_400_000,
      });
      for (const field of ["installationId", "cloudSubject", "authority", "capability", "credentialExpiresAt"] as const) {
        const deps = makeDeps({
          exchange: async (binding) => ({
            // Built by omission rather than a conditional spread: a dropped
            // header must be visible rather than hidden behind an empty object.
            headers: { ...completeHeaders(binding), [field]: undefined },
            credential: CREDENTIAL,
          }),
        });
        const { intentId, verifier } = await beginOk(deps);
        expect(await active.complete(intentId, opts(verifier), deps)).toEqual({
          ok: false,
          reason: "credential-expired",
        });
        expect(deps.store.keys()).toEqual([]);
      }
    });

    it("isolates two synthetic accounts", async () => {
      // Account B is the LIVE context, and A's intent is presented to it. B
      // must be refused AND must not consume A's intent — otherwise anyone who
      // learned an intent id could burn a live enrollment with one attempt.
      const depsA = makeDeps();
      const { intentId, verifier } = await beginOk(depsA);
      depsA.setLiveContext({
        ...CONTEXT,
        ownerId: OTHER_ACCOUNT.localOwnerId,
        sessionId: OTHER_ACCOUNT.localSessionId,
      });
      const stolen = await active.complete(intentId, opts(verifier), depsA);
      expect(stolen.ok).toBe(false);
      expect(depsA.attempts.rows.size).toBe(1);
      expect(depsA.store.keys()).toEqual([]);

      // A is unaffected and still completes.
      depsA.setLiveContext({ ...CONTEXT });
      expect((await active.complete(intentId, opts(verifier), depsA)).ok).toBe(true);
    });

    it("mints nothing when the intent cannot be persisted BEFORE minting", async () => {
      const deps = makeDeps();
      deps.attempts.failPutAt = 1;
      expect(await active.begin(validRequest(), BINDING, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "intent-persist-failed",
      });
      expect(deps.exchangeCalls()).toBe(0);
      expect(deps.store.keys()).toEqual([]);
    });

    it("an intent is single-use: a replay finds nothing", async () => {
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      expect((await active.complete(intentId, opts(verifier), deps)).ok).toBe(true);
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({ ok: false, reason: "unknown-intent" });
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
    });

    it("invalidation leaves work under an UNCHANGED context alone", async () => {
      const deps = makeDeps();
      await beginOk(deps);
      expect(await invalidateEnrollmentContext(CONTEXT, deps)).toBe(0);
      expect(deps.attempts.rows.size).toBe(1);
    });

    it("invalidation stops outstanding work when the owner or session changes", async () => {
      const owner = makeDeps();
      const ownerIntent = await beginOk(owner);
      expect(await invalidateEnrollmentContext({ ...CONTEXT, ownerId: "someone-else" }, owner)).toBe(1);
      expect(await active.complete(ownerIntent.intentId, opts(ownerIntent.verifier), owner)).toEqual({
        ok: false,
        reason: "cancelled",
      });

      const session = makeDeps();
      const sessionIntent = await beginOk(session);
      expect(await invalidateEnrollmentContext({ ...CONTEXT, sessionId: "another-session" }, session)).toBe(1);
      expect(await active.complete(sessionIntent.intentId, opts(sessionIntent.verifier), session)).toEqual({
        ok: false,
        reason: "cancelled",
      });
    });
  });

  describe("R1–R6 — the seven interleavings the independent re-review reproduced", () => {
    // These seven were red against the repaired-but-unreviewed freeze
    // (`530856bf…` / `4511f77d…`) and are transferred here from
    // `.omb-scratch/w1b-regression-handoff-20261002/` so they stay gated.
    // Names and semantics are the review's; the harness is this file's.

    it("R1: overlapping begins for one device permit only one enrollment winner", async () => {
      // Two concurrent begins used to both supersede before either inserted,
      // both read generation 2, and both rows stayed live — so one device
      // enrolled twice and the upstream exchange ran twice.
      const deps = makeDeps();
      const first = clientProof();
      const second = clientProof();
      const [a, b] = await Promise.all([
        active.begin(first.request, BINDING, CONTEXT, deps),
        active.begin(second.request, BINDING, CONTEXT, deps),
      ]);
      expect([a, b].filter((result) => result.ok)).toHaveLength(1);
      expect([a, b].filter((result) => !result.ok)).toEqual([{ ok: false, reason: "superseded" }]);

      // No assumption about WHICH concurrent begin wins — only that exactly one
      // completion is allowed to succeed and issue.
      const results = await Promise.all([
        active.complete(a.ok ? a.value.intentId : "", opts(first.verifier), deps),
        active.complete(b.ok ? b.value.intentId : "", opts(second.verifier), deps),
      ]);
      expect(results.filter((r) => r.ok).length).toBe(1);
      expect(deps.exchangeCalls()).toBe(1);
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
    });

    it("R2a: concurrent completions of one intent issue only one upstream credential", async () => {
      // `claimIntent` used to overwrite `claimedBy` unconditionally, so both
      // completions passed the earlier unclaimed guard and both called the
      // exchange; one was refused only AFTER a credential had been minted.
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      const results = await Promise.all([
        active.complete(intentId, opts(verifier), deps),
        active.complete(intentId, opts(verifier), deps),
      ]);
      expect(results.filter((r) => r.ok).length).toBe(1);
      expect(deps.exchangeCalls()).toBe(1);
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
    });

    it("R3: supersession while a committed write awaits return removes the older stored credential", async () => {
      // The fake compared an invalidation against the newest ANNOUNCED
      // generation rather than the generation of the row actually stored, so a
      // newer intent protected an older stored record and its material stayed.
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        entered.release();
        await held.promise;
        return result;
      };
      const { intentId, verifier } = await beginOk(deps);
      const pending = active.complete(intentId, opts(verifier), deps);
      await entered.promise;
      // Begin a replacement for the same device, which never completes.
      try {
        await beginOk(deps);
      } finally {
        held.release();
      }
      const result = await pending;
      // The replacement has not committed, so the only possible row is stale.
      expect(result.ok).toBe(false);
      expect(deps.store.keys()).toEqual([]);
      expect(deps.store.credential(CLIENT_KEY)).toBeNull();
      expect(deps.store.storedGenerationFor(CLIENT_KEY)).toBeNull();
    });

    it("R5: a credential expiring during commit is refused and inactivated", async () => {
      // Expiry was only checked before the write, so a credential that expired
      // during a held commit was reported as a successful enrollment with an
      // already-expired secret in custody.
      const deps = makeDeps({
        exchange: async (binding): Promise<UpstreamExchange> => ({
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: binding.cloudSubject,
            authority: binding.cloudAuthority,
            capability: "workspace",
            credentialExpiresAt: NOW + 10,
          },
          credential: CREDENTIAL,
        }),
      });
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        deps.setClock(NOW + 11);
        return realCommit(request, generation);
      };
      const { intentId, verifier } = await beginOk(deps);
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("credential-expired");
      expect(deps.store.keys()).toEqual([]);
      expect(deps.store.credential(CLIENT_KEY)).toBeNull();
    });

    it("R4: mutating the same live context object cannot move an owner-A intent into owner B", async () => {
      // `begin` captured the caller's context BY REFERENCE, so in-place live
      // session mutation also mutated the intent's "original binding" and every
      // guard compared the new owner against itself.
      const deps = makeDeps();
      const live: EnrollmentContext = { ...CONTEXT };
      // The harness hands out the live object itself, as a real caller would.
      deps.currentContext = () => live;
      const { intentId, verifier } = await beginOk(deps, clientProof(), BINDING, live);

      // Normal in-place live-session mutation — not access to an intent row.
      live.ownerId = "local-owner-synthetic-b";
      live.sessionId = "local-session-synthetic-b";

      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(false);
      expect(deps.exchangeCalls()).toBe(0);
      expect(deps.store.keys()).toEqual([]);
    });

    it("R2b: cancellation during claim prevents the subsequent upstream issuance", async () => {
      // The claimed row was re-read but the re-peek was never GUARDED, so a
      // cancellation landing inside the claim's await still reached the exchange.
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      const claim = deps.attempts.claimIntent.bind(deps.attempts);
      deps.attempts.claimIntent = async (id, owner) => {
        await cancelEnrollment(id, deps);
        return claim(id, owner);
      };
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(false);
      expect(deps.exchangeCalls()).toBe(0);
      expect(deps.store.keys()).toEqual([]);
    });

    it("R6: ending an unchanged context must invalidate its held work before shutdown", async () => {
      // `invalidateEnrollmentContext` documented shutdown but skipped exactly
      // matching contexts, so it was a no-op for the case it advertised.
      // Shutdown now has its own operation.
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      deps.exchange = async (binding): Promise<UpstreamExchange> => {
        entered.release();
        await held.promise;
        return {
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: binding.cloudSubject,
            authority: binding.cloudAuthority,
            capability: "workspace",
            credentialExpiresAt: NOW + 86_400_000,
          },
          credential: CREDENTIAL,
        };
      };
      const { intentId, verifier } = await beginOk(deps);
      const pending = active.complete(intentId, opts(verifier), deps);
      await entered.promise;
      let invalidated: number;
      try {
        // Same owner, session and endpoint: only the SESSION ended.
        invalidated = await endEnrollmentContext({ ...CONTEXT }, deps);
      } finally {
        held.release();
      }
      const result = await pending;
      expect(invalidated).toBe(1);
      expect(result.ok).toBe(false);
      expect(deps.store.keys()).toEqual([]);
    });

    it("R6b: shutdown invalidation is distinct from retaining a matching context", async () => {
      // The two requirements are opposites, so they must not share one function.
      const keep = makeDeps();
      await beginOk(keep);
      expect(await invalidateEnrollmentContext({ ...CONTEXT }, keep)).toBe(0);
      expect(keep.attempts.rows.size).toBe(1);

      const end = makeDeps();
      await beginOk(end);
      expect(await endEnrollmentContext({ ...CONTEXT }, end)).toBe(1);
    });
    it("M2/M3: the claim itself refuses an invalidated or already-claimed row", async () => {
      // The post-claim guard would also catch these, so asserting only through
      // `complete` leaves the store's own compare-and-claim untested. Asserted
      // at the seam: the claim is the last thing before anything is minted.
      const deps = makeDeps();
      const first = await beginOk(deps);
      expect(await deps.attempts.claimIntent(first.intentId, "owner-token-1")).not.toBeNull();
      // Replayed: already claimed by a different completion.
      expect(await deps.attempts.claimIntent(first.intentId, "owner-token-2")).toBeNull();

      const second = await beginOk(deps, clientProof(), BINDING, CONTEXT);
      await cancelEnrollment(second.intentId, deps);
      expect(await deps.attempts.claimIntent(second.intentId, "owner-token-3")).toBeNull();
    });

    it("M7: a session change that lands after the claim is caught before issuance", async () => {
      // The claim succeeds on a row that is unclaimed, live and newest — so its
      // own checks all pass — and the owner changes immediately afterwards.
      // Only the post-claim revalidation can stop the exchange here.
      const deps = makeDeps();
      const live: EnrollmentContext = { ...CONTEXT };
      deps.currentContext = () => live;
      const { intentId, verifier } = await beginOk(deps, clientProof(), BINDING, live);
      const claim = deps.attempts.claimIntent.bind(deps.attempts);
      deps.attempts.claimIntent = async (id, owner) => {
        const claimed = await claim(id, owner);
        // The live session ends DURING the claim, after its comparison passed.
        live.ownerId = "local-owner-synthetic-b";
        return claimed;
      };
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(false);
      expect(deps.exchangeCalls()).toBe(0);
      expect(deps.store.keys()).toEqual([]);
    });
  });

  describe("B1–B3 — cleanup certainty, rejection containment, generation monotonicity", () => {
    // These pin the second independent review's three remaining blockers. The
    // fence registry is process-wide, so every case resets it: otherwise one
    // unresolved case would silently refuse the next case's begin.

    it("B1: a failed invalidation is reported as unresolved custody, not as cancellation", async () => {
      // invalidate returns false WITHOUT removing the row. The old code
      // discarded the cleanup result and returned "cancelled", so the caller
      // was told the attempt was withdrawn while the credential stayed usable.
      resetEnrollmentFences();
      const deps = makeDeps();
      const realInvalidate = deps.store.invalidate.bind(deps.store);
      deps.store.invalidate = async () => false;
      const { intentId, verifier } = await beginOk(deps);
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        return result;
      };
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      // The credential is genuinely still there — which is exactly why the
      // outcome must not read as an ordinary refusal.
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
      expect(deps.store.credential(CLIENT_KEY)).not.toBeNull();
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
      deps.store.invalidate = realInvalidate;
    });

    it("B1: an indeterminate readback is unresolved even when invalidate succeeded", async () => {
      // A failed read is NOT proof of absence. Mapping it to null is what made
      // an I/O fault look like successful cleanup.
      resetEnrollmentFences();
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        return result;
      };
      // The first explicit read faults.
      deps.store.failReadAt = 1;
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    });

    it("B1: cleanup compares the committed GENERATION, not a timestamp", async () => {
      // The old discriminator compared `createdAt`. The stored row's timestamp
      // comes from credential issuance while the intent's comes from begin, so
      // for the SAME generation they normally differ — which made a retained
      // own-row read as a newer winner and reported success. Here the clock
      // moves so issuance and begin differ by 100ms; removal must still be
      // recognised as removal rather than mistaken for a winner to keep.
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        entered.release();
        await held.promise;
        return result;
      };
      const { intentId, verifier } = await beginOk(deps);
      const pending = active.complete(intentId, opts(verifier), deps);
      await entered.promise;
      // Issue at T+100, then cancel: the two timestamps now differ.
      deps.setClock(NOW + 100);
      try {
        await cancelEnrollment(intentId, deps);
      } finally {
        held.release();
      }
      const result = await pending;
      // Removal genuinely happened, so this is an ordinary cancellation and the
      // key is NOT fenced.
      expect(result).toEqual({ ok: false, reason: "cancelled" });
      expect(deps.store.keys()).toEqual([]);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(false);
    });

    it("B1: a RETAINED own-row is unresolved even when its timestamp differs", async () => {
      // The discriminating case the timestamp comparator got wrong. The row
      // does NOT go away (invalidate returns false), and its `createdAt` comes
      // from credential issuance at T+100 while the intent's came from begin at
      // T. A timestamp comparator therefore reads our OWN surviving row as "a
      // different generation, keep it" and reports ordinary cancellation while
      // the credential is still usable. Only the generation proves whose it is.
      resetEnrollmentFences();
      const deps = makeDeps();
      // Removal silently fails: the row survives.
      deps.store.invalidate = async () => false;
      const { intentId, verifier } = await beginOk(deps);
      const held = gate();
      const entering = gate();
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        entering.release();
        await held.promise;
        return result;
      };
      // The engine captures `now` for `issuedAt` BEFORE the commit, so the clock
      // has to move during the EXCHANGE. Advancing it inside commit is too
      // late: the envelope's createdAt is already fixed by then, and the two
      // timestamps would coincidentally match, which is precisely the case a
      // timestamp comparator gets right by accident.
      const realExchange = deps.exchange;
      deps.exchange = async (binding, intent) => {
        deps.setClock(NOW + 100);
        return realExchange(binding, intent);
      };
      const pending = active.complete(intentId, opts(verifier), deps);
      await entering.promise;
      held.release();
      const result = await pending;
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    });

    it("B1: an ALREADY-COMMITTED newer winner survives cleanup of the older generation", async () => {
      // Astra's coverage correction, and it was right: the previous version of
      // this case began the winner, released the OLD cleanup, and only then
      // completed the winner — so it proved a newer INTENT survives, not that an
      // already-committed newer RECORD does.
      //
      // Here generation 2 genuinely commits FIRST and is fully in the store.
      // Only then does generation 1's held cleanup run. The winner's row and
      // its exact credential must survive untouched.
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      const realCommit = deps.store.commit.bind(deps.store);
      let armed = true;
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        if (armed) {
          armed = false;
          entered.release();
          await held.promise;
        }
        return result;
      };
      const older = await beginOk(deps);
      const pendingOlder = active.complete(older.intentId, opts(older.verifier), deps);
      await entered.promise;

      // Generation 2 commits over the key and completes completely, so its
      // record is present in the store before generation 1 cleans up.
      const winner = await beginOk(deps);
      expect((await active.complete(winner.intentId, opts(winner.verifier), deps)).ok).toBe(true);
      const winnerRow = deps.store.row(CLIENT_KEY);
      const winnerCredential = deps.store.credential(CLIENT_KEY);
      const winnerGeneration = deps.store.storedGenerationFor(CLIENT_KEY);
      expect(winnerRow).not.toBeNull();

      // Now generation 1 resumes and its cleanup runs against that live winner.
      held.release();
      await pendingOlder;

      // The newer committed record is intact, by generation AND by exact secret.
      expect(deps.store.storedGenerationFor(CLIENT_KEY)).toBe(winnerGeneration);
      expect(deps.store.row(CLIENT_KEY)).toEqual(winnerRow);
      expect(deps.store.credential(CLIENT_KEY)).toBe(winnerCredential);
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
      // A preserved winner is a legitimate outcome, so the key is NOT fenced.
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(false);
    });

    it("B1: a custody read that REJECTS is unresolved, not treated as absent", async () => {
      // `failReadAt` yields `unknown`; a genuinely THROWING read must be
      // contained the same way. Without the catch around `read`, the rejection
      // escaped `complete` entirely and the landed credential was never cleaned.
      resetEnrollmentFences();
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        return result;
      };
      deps.store.read = async () => {
        throw new Error("synthetic: custody read failed");
      };
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    });

    it("FENCE: an intent begun BEFORE the fence is refused, with no new exchange", async () => {
      // Astra's source-derived scenario, which I reproduced first as a failing
      // standalone test and then pinned here. Ordering: A's write lands and its
      // return is held; B begins while A is held, so B exists before any fence;
      // A resumes and cannot confirm removal, establishing the fence; B then
      // completes. Before the fix B exchanged, committed and reported success.
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      const realCommit = deps.store.commit.bind(deps.store);
      let armed = false;
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        if (!armed) {
          armed = true;
          entered.release();
          await held.promise;
        }
        return result;
      };
      const older = await beginOk(deps);
      const pendingOlder = active.complete(older.intentId, opts(older.verifier), deps);
      await entered.promise;

      // Allocated while the older completion is held: before any fence exists.
      const later = await beginOk(deps);

      // The older completion cannot confirm removal.
      deps.store.invalidate = async () => false;
      try {
        await cancelEnrollment(older.intentId, deps);
      } finally {
        held.release();
      }
      expect(await pendingOlder).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);

      // The already-allocated intent must be refused, and must not exchange.
      const callsBefore = deps.exchangeCalls();
      const result = await active.complete(later.intentId, opts(later.verifier), deps);
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(deps.exchangeCalls() - callsBefore).toBe(0);
    });

    it("F3: a fence established AFTER the post-commit guard still blocks adoption", async () => {
      // The adoption check covers a window the post-commit guard cannot: a fence
      // can be established BETWEEN that guard and the outcome. This case is
      // built to DISCRIMINATE rather than merely pass — the pre-fix behaviour is
      // a different failure REASON, not the same one.
      //
      // A concurrent completion's cleanup establishes the fence at the exact
      // await boundary between the post-commit guard and adoption (the expiry
      // readback). This completion's own expiry cleanup then CONFIRMS removal,
      // so it does not fence and does not report unresolved on its own account —
      // without the adoption check it would report `credential-expired` and
      // finish, silently ignoring the fence the other completion established.
      resetEnrollmentFences();
      const deps = makeDeps({
        exchange: async (binding): Promise<UpstreamExchange> => ({
          headers: {
            installationId: "installation-synthetic-0001",
            cloudSubject: binding.cloudSubject,
            authority: binding.cloudAuthority,
            capability: "workspace",
            credentialExpiresAt: NOW + 10,
          },
          credential: CREDENTIAL,
        }),
      });
      const realCommit = deps.store.commit.bind(deps.store);
      const realRead = deps.store.read.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        // Expiry lands here: past the post-commit guard, before adoption.
        deps.setClock(NOW + 11);
        return result;
      };
      let injected = false;
      deps.store.read = async (clientKey) => {
        // At this readback — the last awaited boundary before adoption — another
        // completion's cleanup establishes the fence. Our own cleanup then
        // proceeds and confirms removal normally.
        if (!injected) {
          injected = true;
          fenceEnrollmentKey(CLIENT_KEY);
        }
        return realRead(clientKey);
      };
      const { intentId, verifier } = await beginOk(deps);
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(injected).toBe(true);
      // The fence, not our own expiry, is what refuses this completion.
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    });

    it("LATE-FENCE: a fence landing after the post-claim guard stops issuance", async () => {
      // Reproduced first as a standalone failing test, then pinned here.
      // The post-claim guard reads the fence inside its own SYNCHRONOUS tail,
      // so a microtask queued during that tail runs after the guard has already
      // compared and returned, but before the caller resumes at the exchange.
      // Measured: before the fix this reached `deps.exchange` with the key
      // already fenced. Arming from the guard's `currentContext()` call is the
      // only placement that opens exactly that window.
      resetEnrollmentFences();
      const deps = makeDeps();
      let exchangeCalls = 0;
      const realExchange = deps.exchange;
      deps.exchange = async (binding, intent) => {
        exchangeCalls += 1;
        // Record the fence state at the moment issuance is attempted.
        expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(false);
        return realExchange(binding, intent);
      };
      const { intentId, verifier } = await beginOk(deps);
      // Arm only AFTER begin: its awaited announcement also reads the live
      // context. Within complete, the SECOND call is the post-claim guard's;
      // queueing there lands the fence between that guard and the exchange.
      let contextCalls = 0;
      const realContext = deps.currentContext;
      deps.currentContext = () => {
        contextCalls += 1;
        if (contextCalls === 2) queueMicrotask(() => fenceEnrollmentKey(CLIENT_KEY));
        return realContext();
      };
      const result = await active.complete(intentId, opts(verifier), deps);
      // A RESULT, not a thrown error.
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      // And no credential was ever issued.
      expect(exchangeCalls).toBe(0);
      expect(contextCalls).toBe(2);
      expect(deps.store.keys()).toEqual([]);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    });

    it("COMMIT-WINDOW: a fence landing during the exchange stores nothing usable", async () => {
      // I went looking for a further window after the late-fence repair: the
      // engine's last fence read is before `deps.exchange`, and FOUR awaits
      // separate it from `store.commit`. A fence landing inside the exchange is
      // therefore observed only by the post-commit guard and cleanup.
      //
      // Result: no gap. Nothing usable is retained and the outcome is a refusal.
      // Pinned so a future change cannot quietly open it.
      resetEnrollmentFences();
      const deps = makeDeps({
        exchange: async (binding): Promise<UpstreamExchange> => {
          // The fence lands DURING the exchange.
          fenceEnrollmentKey(CLIENT_KEY);
          return {
            headers: {
              installationId: "installation-synthetic-0001",
              cloudSubject: binding.cloudSubject,
              authority: binding.cloudAuthority,
              capability: "workspace",
              credentialExpiresAt: NOW + 86_400_000,
            },
            credential: CREDENTIAL,
          };
        },
      });
      const { intentId, verifier } = await beginOk(deps);
      const result = await active.complete(intentId, opts(verifier), deps);
      // A refusal, never a success over unresolved custody.
      expect(result.ok).toBe(false);
      // And nothing usable survives in the store.
      expect(deps.store.keys()).toEqual([]);
      expect(deps.store.credential(CLIENT_KEY)).toBeNull();
    });

    it("POST-EXCHANGE: a fence landing during a held exchange stops the custody commit", async () => {
      // Astra's refreeze4 P1, reproduced first as a failing standalone test.
      // B passes the synchronous pre-exchange fence read, then awaits a VALID
      // response; older A's cleanup fences the same key while B waits. No
      // pre-exchange read can observe that fence, because it lands during the
      // exchange itself. Before the repair this made ONE custody commit over the
      // fenced key and reported `credential-persist-failed`.
      resetEnrollmentFences();
      const entered = gate();
      const held = gate();
      let exchanges = 0;
      let commits = 0;
      const deps = makeDeps({
        exchange: async (binding): Promise<UpstreamExchange> => {
          exchanges += 1;
          entered.release();
          await held.promise;
          return {
            headers: {
              installationId: "installation-synthetic-0001",
              cloudSubject: binding.cloudSubject,
              authority: binding.cloudAuthority,
              capability: "workspace",
              credentialExpiresAt: NOW + 86_400_000,
            },
            credential: CREDENTIAL,
          };
        },
      });
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        commits += 1;
        return realCommit(request, generation);
      };
      const { intentId, verifier } = await beginOk(deps);
      const pending = active.complete(intentId, opts(verifier), deps);
      await entered.promise;
      // The fence arrives while B's valid response is held.
      fenceEnrollmentKey(CLIENT_KEY);
      held.release();
      const result = await pending;
      // Exactly one exchange had already started; ZERO custody commits.
      expect(exchanges).toBe(1);
      expect(commits).toBe(0);
      // Unresolved custody stays VISIBLE, not relabelled as a persist failure.
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(deps.store.keys()).toEqual([]);
      expect(deps.store.credential(CLIENT_KEY)).toBeNull();
    });

    it("POST-EXCHANGE: a fence armed in the post-exchange guard's tail blocks the commit", async () => {
      // The continuation gap between the post-exchange guard's fence read and
      // the protected write. The guard's tail has no `await` after its fence
      // read, so a microtask queued from inside that tail can only run once the
      // guard has finished comparing — landing in the window the guard has
      // already passed and the caller has not yet reached.
      //
      // The previous version of this test armed the fence from `generationFor`,
      // which an ordered phase timeline showed fires in the POST-CLAIM guard:
      // `deps.exchange` was never invoked at all. It therefore asserted an
      // outcome for a boundary it never reached, which is why deleting the
      // pre-commit read left it passing. Arming is now gated on an OBSERVED
      // exchange having returned, so the fence provably lands post-exchange.
      resetEnrollmentFences();
      const deps = makeDeps();

      // Observable stages. The test asserts on these, so a regression that
      // stops short of the post-exchange boundary fails LOUDLY rather than
      // passing quietly on a refusal raised somewhere else entirely.
      const stages: string[] = [];
      const realExchange = deps.exchange;
      deps.exchange = async (binding, consumed) => {
        stages.push("exchange-entered");
        const upstream = await realExchange(binding, consumed);
        stages.push("exchange-response-returned");
        return upstream;
      };
      let commits = 0;
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        stages.push("commit-called");
        commits += 1;
        return realCommit(request, generation);
      };
      // `currentContext` is read by the guard AFTER its fence read, in the same
      // synchronous tail. Arming from there is therefore too late for that
      // guard to observe, and early enough to beat the caller's next `await`.
      // Gated on the exchange having returned so this can only be the
      // post-exchange guard.
      let armed = false;
      deps.currentContext = () => {
        if (!armed && stages.includes("exchange-response-returned")) {
          armed = true;
          queueMicrotask(() => fenceEnrollmentKey(CLIENT_KEY));
        }
        return { ...CONTEXT };
      };

      const { intentId, verifier } = await beginOk(deps);
      const result = await active.complete(intentId, opts(verifier), deps);

      // Preconditions first: the fence must actually have been armed, and the
      // exchange must actually have run and returned. Without these the result
      // assertions below could be satisfied by an unrelated early refusal.
      expect(armed).toBe(true);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
      expect(stages).toContain("exchange-entered");
      expect(stages).toContain("exchange-response-returned");
      // The intended boundary: exactly one exchange, and no write attempt.
      expect(deps.exchangeCalls()).toBe(1);
      expect(commits).toBe(0);
      expect(stages).not.toContain("commit-called");
      // Unresolved custody stays visible.
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
    });

    it("POST-EXCHANGE: an unresolved PREDECESSOR refuses a new begin on the same key", async () => {
      // Requested by the refreeze-5 review: custody already unresolved for this
      // key BEFORE any new work starts.
      //
      // The previous version of this test hand-set the fence on an EMPTY store.
      // That proved only that `begin` honours the fence, and its comment claimed
      // "no new work may be layered on top of a record nobody can prove was
      // removed" while no record existed — an assertion about a situation it
      // never created. Here the predecessor is REAL: a first enrollment lands a
      // row, its cleanup is made unconfirmable, and the resulting unremovable
      // row is snapshotted before anything else runs.
      resetEnrollmentFences();
      const deps = makeDeps();

      // Build the predecessor the way production would: a commit that really
      // lands, then an invalidation the adapter cannot confirm, leaving the row
      // in place with custody unresolved.
      const { intentId, verifier } = await beginOk(deps);
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        return result;
      };
      deps.store.rejectInvalidateAt = 1;
      const first = await active.complete(intentId, opts(verifier), deps);
      expect(first).toEqual({ ok: false, reason: "custody-unresolved" });

      // The predecessor now genuinely exists: a stored row whose credential is
      // still sealed, plus the unresolved marker. Snapshot it so preservation
      // can be MEASURED rather than assumed.
      // A STRUCTURED CLONE, not the live object. `row()` hands back the
      // store's own backing envelope, so comparing that reference to itself
      // could not detect an in-place mutation — expected and actual would move
      // together and the assertion would pass for the wrong reason. Cloning
      // makes "the row survived" an actual claim about preserved state.
      const predecessorRow = structuredClone(deps.store.row(CLIENT_KEY));
      const predecessorCredential = deps.store.credential(CLIENT_KEY);
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
      expect(predecessorRow).not.toBeNull();
      expect(predecessorCredential).not.toBeNull();
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);

      const exchangesBefore = deps.exchangeCalls();
      const generationBefore = deps.attempts.generationFor(CLIENT_KEY);

      // New work on that key must be refused with the distinct unresolved
      // reason.
      const proof = clientProof();
      const started = await active.begin(proof.request, BINDING, CONTEXT, deps);
      expect(started).toEqual({ ok: false, reason: "custody-unresolved" });

      // The refusal must not have advanced anything, and — the point of the
      // case — the UNREMOVABLE predecessor must still be there afterwards. A
      // final-empty-store check would be vacuous here, because there was
      // something to preserve to begin with; asserting the row SURVIVES is what
      // distinguishes this from the empty-store version.
      expect(deps.exchangeCalls()).toBe(exchangesBefore);
      expect(deps.attempts.generationFor(CLIENT_KEY)).toBe(generationBefore);
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
      expect(deps.store.row(CLIENT_KEY)).toEqual(predecessorRow);
      expect(deps.store.credential(CLIENT_KEY)).toBe(predecessorCredential);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);

      // CONTROL: the same begin against a clean store DOES succeed, so the
      // refusal above is caused by the unresolved predecessor and not by the
      // request being invalid. Compared within the control's OWN store: an
      // earlier draft compared across two stores, where both sides start from
      // their own generation 1 and the assertion could not mean anything.
      resetEnrollmentFences();
      const control = makeDeps();
      expect(control.attempts.generationFor(CLIENT_KEY)).toBe(0);
      const controlStarted = await active.begin(clientProof().request, BINDING, CONTEXT, control);
      expect(controlStarted.ok).toBe(true);
      expect(control.attempts.generationFor(CLIENT_KEY)).toBeGreaterThan(0);
    });

    it("POST-EXCHANGE: a fence-induced null commit during a HELD commit stays unresolved", async () => {
      // The adapter returns null for its own reasons while the key is fenced.
      // Unresolved custody must remain visible on that path too, rather than
      // being reported as an ordinary persistence failure.
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        entered.release();
        await held.promise;
        return realCommit(request, generation);
      };
      const { intentId, verifier } = await beginOk(deps);
      const pending = active.complete(intentId, opts(verifier), deps);
      await entered.promise;
      // Fenced while the write is pending; the adapter then refuses.
      fenceEnrollmentKey(CLIENT_KEY);
      deps.store.commit = async () => null;
      held.release();
      const result = await pending;
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
    });

    it("B2: a commit that lands and then REJECTS returns a result and cleans up", async () => {
      // The dangerous shape: the write DID land, then the call threw. A promise
      // rejection used to escape `complete` entirely with no cleanup attempt.
      resetEnrollmentFences();
      const deps = makeDeps();
      deps.store.rejectCommitAt = 1;
      const { intentId, verifier } = await beginOk(deps);
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(false);
      // Cleanup ran and confirmed removal, so this is an ordinary persistence
      // failure rather than an unresolved custody state.
      expect(result).toEqual({ ok: false, reason: "credential-persist-failed" });
      expect(deps.store.keys()).toEqual([]);
    });

    it("B2: a post-commit guard rejection returns a result instead of throwing", async () => {
      resetEnrollmentFences();
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      // The attempt-store read used by the POST-COMMIT guard faults. Armed by
      // the commit itself, so every earlier guard (pre-exchange, post-claim)
      // still reads normally and only the post-write boundary is hit.
      const peek = deps.attempts.peekIntent.bind(deps.attempts);
      const realCommit = deps.store.commit.bind(deps.store);
      let landed = false;
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        landed = true;
        return result;
      };
      deps.attempts.peekIntent = async (id) => {
        if (landed) throw new Error("synthetic: attempt store read failed");
        return peek(id);
      };
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result.ok).toBe(false);
      expect(deps.store.keys()).toEqual([]);
    });

    it("B2: an invalidation rejection yields unresolved custody, not a thrown error", async () => {
      resetEnrollmentFences();
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        return result;
      };
      deps.store.rejectInvalidateAt = 1;
      const result = await active.complete(intentId, opts(verifier), deps);
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    });

    it("B3: a delayed older begin return does not roll back the custody generation", async () => {
      // Concurrent begins persist in one order but can RETURN in another. The
      // first writes generation 1 and holds; the second writes generation 2 and
      // announces it; releasing the first then announced 1 and rolled custody
      // back, so the still-current generation-2 intent was refused by its own
      // store after the exchange had already run.
      resetEnrollmentFences();
      const deps = makeDeps();
      const entered = gate();
      const held = gate();
      const put = deps.attempts.putIntentWithGeneration.bind(deps.attempts);
      let first = true;
      deps.attempts.putIntentWithGeneration = async (intent) => {
        const generation = await put(intent);
        if (first) {
          first = false;
          entered.release();
          await held.promise;
        }
        return generation;
      };
      const a = clientProof();
      const b = clientProof();
      const slow = active.begin(a.request, BINDING, CONTEXT, deps);
      await entered.promise;
      const fast = await active.begin(b.request, BINDING, CONTEXT, deps);
      expect(fast.ok).toBe(true);
      held.release();
      const slowResult = await slow;
      // The held allocation no longer owns generation 1 when it returns. Begin
      // must refuse it before announcing custody or handing out a usable id.
      expect(slowResult).toEqual({ ok: false, reason: "superseded" });
      if (!fast.ok) throw new Error("fast begin failed");

      // The newest generation-2 intent must complete normally.
      const result = await active.complete(fast.value.intentId, opts(b.verifier), deps);
      expect(result.ok).toBe(true);
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(false);
    });

    it("fencing blocks a new begin on an unresolved key until reset", async () => {
      resetEnrollmentFences();
      const deps = makeDeps();
      deps.store.failReadAt = 1;
      const { intentId, verifier } = await beginOk(deps);
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        return result;
      };
      expect(await active.complete(intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "custody-unresolved",
      });
      // Recovery requires an explicit owner action, not a silent retry.
      expect(await active.begin(clientProof().request, BINDING, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "custody-unresolved",
      });
      resetEnrollmentFences();
      expect((await active.begin(clientProof().request, BINDING, CONTEXT, deps)).ok).toBe(true);
    });
  });

  describe("W2 — persisted restart fence and canonical issuer binding", () => {
    // The W2 register asked for a persisted restart fence, canonical issuer
    // provenance on the binding, and race tests for all of it. These cases
    // drive the SAME harness as the suites above — only the fence store and
    // the issuer fields are new.

    /** Begins on a SPECIFIC engine (the suites above always use `active`). */
    async function beginOn(
      engine: ReturnType<typeof createEnrollmentEngine>,
      deps: Harness,
      binding: EnrollmentBinding = BINDING,
    ): Promise<{ intentId: string; verifier: string; state: string }> {
      const proof = clientProof();
      const started = await engine.begin(proof.request, binding, CONTEXT, deps);
      if (!started.ok) throw new Error(`begin unexpectedly failed: ${started.reason}`);
      return { intentId: started.value.intentId, verifier: proof.verifier, state: proof.state };
    }

    /** Forces unresolved custody the way production reaches it: a commit that
     * really lands, then an invalidation the adapter cannot confirm. */
    function armUnresolvedCleanup(deps: Harness, intentId: string): void {
      const realCommit = deps.store.commit.bind(deps.store);
      deps.store.commit = async (request, generation) => {
        const result = await realCommit(request, generation);
        await cancelEnrollment(intentId, deps);
        return result;
      };
      deps.store.invalidate = async () => false;
    }

    it("(a) a fence survives a restart: a fresh engine instance observes what a prior instance persisted", async () => {
      const path = join(fenceDirectory, "restart-engine.json");
      const engineA = createEnrollmentEngine(
        { enabled: true, trusted: TRUSTED },
        { fencePersistence: new FileFencePersistence({ path }) },
      );
      const deps = makeDeps();
      const { intentId, verifier } = await beginOn(engineA, deps);
      armUnresolvedCleanup(deps, intentId);
      expect(await engineA.complete(intentId, opts(verifier), deps)).toEqual({
        ok: false,
        reason: "custody-unresolved",
      });

      // The fence is durable: an entirely new store over the same file reads
      // it back before any engine is constructed on top of it.
      const persistenceB = new FileFencePersistence({ path });
      expect(persistenceB.degraded).toBe(false);
      expect(persistenceB.read()).toContain(CLIENT_KEY);

      // RESTART: a new engine with EMPTY memory and the SAME persistence
      // file. Its begin is refused on the persisted fence alone.
      const engineB = createEnrollmentEngine(
        { enabled: true, trusted: TRUSTED },
        { fencePersistence: persistenceB },
      );
      const callsBefore = deps.exchangeCalls();
      expect(await engineB.begin(clientProof().request, BINDING, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "custody-unresolved",
      });
      expect(deps.exchangeCalls()).toBe(callsBefore);
      // The refusal happened BEFORE anything was allocated: the persisted
      // fence gates begin, not just completion.
      expect(deps.attempts.generationFor(CLIENT_KEY)).toBe(1);

      // Per-engine registries are ISOLATED: the module-level API reads the
      // shared registry, which this engine's fence never touched.
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(false);
    });

    it("(a) the module API observes a fence persisted by a prior registry (restart seam)", () => {
      resetEnrollmentFences();
      fenceEnrollmentKey(CLIENT_KEY, "prior-instance");
      // RESTART: replace the shared registry with a fresh instance over the
      // SAME file. Memory is gone; only what was persisted remains.
      const restarted = new FileFencePersistence({ path: suiteFencePersistence.filePath });
      setEnrollmentFencePersistence(restarted);
      try {
        expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
      } finally {
        setEnrollmentFencePersistence(suiteFencePersistence);
        resetEnrollmentFences();
      }
    });

    it("(b) a completion still holding the NEWEST generation after a restart still loses to the persisted fence", async () => {
      const path = join(fenceDirectory, "restart-newest-generation.json");
      const persistenceA = new FileFencePersistence({ path });
      const engineA = createEnrollmentEngine({ enabled: true, trusted: TRUSTED }, { fencePersistence: persistenceA });
      const deps = makeDeps();
      const { intentId, verifier } = await beginOn(engineA, deps);
      expect(deps.attempts.generationFor(CLIENT_KEY)).toBe(1);

      // The fence is established through the DURABLE store only — the way a
      // concurrent or prior instance's cleanup would — never through this
      // engine's memory.
      persistenceA.add(CLIENT_KEY, { reason: "concurrent-cleanup" });

      // RESTART: fresh engine, fresh memory, same attempt store (the intent
      // survived it, still live and still generation-newest), same file.
      const engineB = createEnrollmentEngine(
        { enabled: true, trusted: TRUSTED },
        { fencePersistence: new FileFencePersistence({ path }) },
      );
      const callsBefore = deps.exchangeCalls();
      const result = await engineB.complete(intentId, opts(verifier), deps);
      // The generation-conditional commit path re-reads the persisted fence
      // and refuses BEFORE the exchange runs: nothing minted, nothing stored.
      expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
      expect(deps.exchangeCalls()).toBe(callsBefore);
      expect(deps.store.keys()).toEqual([]);
      expect(deps.store.credential(CLIENT_KEY)).toBeNull();
    });

    it("(b) a superseded generation still loses to a newer one after a restart", async () => {
      const path = join(fenceDirectory, "restart-superseded.json");
      const engineA = createEnrollmentEngine(
        { enabled: true, trusted: TRUSTED },
        { fencePersistence: new FileFencePersistence({ path }) },
      );
      const deps = makeDeps();
      const first = await beginOn(engineA, deps);
      const second = await beginOn(engineA, deps);

      // RESTART: the attempt store (and its generations) persist in `deps`;
      // the engine does not.
      const engineB = createEnrollmentEngine(
        { enabled: true, trusted: TRUSTED },
        { fencePersistence: new FileFencePersistence({ path }) },
      );
      // The stale generation-1 completion loses to generation 2.
      expect(await engineB.complete(first.intentId, opts(first.verifier), deps)).toEqual({
        ok: false,
        reason: "superseded",
      });
      expect(deps.store.keys()).toEqual([]);
      // And the newest generation still completes — supersession must not
      // break the winner, across a restart any more than within one.
      expect((await engineB.complete(second.intentId, opts(second.verifier), deps)).ok).toBe(true);
      expect(deps.store.keys()).toEqual([CLIENT_KEY]);
    });

    it("(c) reset clears the DURABLE fence, not just memory", () => {
      resetEnrollmentFences();
      fenceEnrollmentKey(CLIENT_KEY, "reset-test");
      expect(suiteFencePersistence.read()).toContain(CLIENT_KEY);
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);

      resetEnrollmentFences();
      expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(false);
      expect(suiteFencePersistence.read()).not.toContain(CLIENT_KEY);
      // A brand-new instance over the same file sees the cleared state too.
      expect(new FileFencePersistence({ path: suiteFencePersistence.filePath }).read()).toEqual([]);
    });

    it("(d) a corrupt fence file fails closed until an explicit reset heals it", async () => {
      const corruptPath = join(fenceDirectory, "corrupt.json");
      writeFileSync(corruptPath, "{ not json at all", { mode: 0o600 });
      const corruptStore = new FileFencePersistence({ path: corruptPath });
      expect(corruptStore.degraded).toBe(true);
      expect(corruptStore.read()).toEqual([]);

      setEnrollmentFencePersistence(corruptStore);
      try {
        // Fail closed at the API level: a key nobody fenced counts as fenced,
        // because the store's contents are UNKNOWN.
        expect(isEnrollmentKeyFenced("key-never-fenced-by-anyone")).toBe(true);
        const deps = makeDeps();
        expect(await active.begin(clientProof().request, BINDING, CONTEXT, deps)).toEqual({
          ok: false,
          reason: "custody-unresolved",
        });
        // A degraded store accepts no writes: fencing does not silently heal
        // it by overwriting unknown contents with a known set.
        fenceEnrollmentKey("some-key", "while-degraded");
        expect(corruptStore.degraded).toBe(true);
        expect(corruptStore.read()).toEqual([]);
        // And a fresh instance over the corrupt file is degraded as well.
        expect(new FileFencePersistence({ path: corruptPath }).degraded).toBe(true);

        // Recovery is the explicit owner action — and it heals the file.
        resetEnrollmentFences();
        expect(corruptStore.degraded).toBe(false);
        expect(isEnrollmentKeyFenced("some-key")).toBe(false);
        expect((await active.begin(clientProof().request, BINDING, CONTEXT, deps)).ok).toBe(true);
      } finally {
        setEnrollmentFencePersistence(suiteFencePersistence);
        resetEnrollmentFences();
      }
    });

    it("(d) every unparseable or unvalidated shape is degraded, not just truncated JSON", async () => {
      const corruptPayloads: Array<[string, string]> = [
        ["truncated", '{"version":1,"fences":[{"key":"k","fencedAt":'],
        ["wrong-version", JSON.stringify({ version: 2, fences: [] })],
        ["wrong-field-type", JSON.stringify({ version: 1, fences: [{ key: 7, fencedAt: 1 }] })],
        ["not-an-object", "[1,2,3]"],
      ];
      for (const [name, bytes] of corruptPayloads) {
        const path = join(fenceDirectory, `corrupt-${name}.json`);
        writeFileSync(path, bytes, { mode: 0o600 });
        const store = new FileFencePersistence({ path });
        expect(store.degraded, name).toBe(true);
        // Fail closed through an engine built on it: begin refuses on every
        // key, because the store's contents are UNKNOWN.
        const engine = createEnrollmentEngine({ enabled: true, trusted: TRUSTED }, { fencePersistence: store });
        const deps = makeDeps();
        expect(await engine.begin(clientProof().request, BINDING, CONTEXT, deps), name).toEqual({
          ok: false,
          reason: "custody-unresolved",
        });
      }
    });

    it("(e) a binding whose canonical issuer is not the trusted one is refused", async () => {
      const deps = makeDeps();
      const foreign = "https://other.synthetic.invalid";
      expect(await active.begin(validRequest(), { ...BINDING, cloudIssuer: foreign }, CONTEXT, deps)).toEqual({
        ok: false,
        reason: "issuer",
      });
      expect(deps.attempts.rows.size).toBe(0);
      expect(deps.exchangeCalls()).toBe(0);
    });

    it("(e) a non-canonical issuer never reaches the trusted comparison at all", async () => {
      // Each of these is refused at the SCHEMA — the boundary demands the
      // canonical spelling, and never normalizes one into another issuer's
      // identity.
      const nonCanonical = [
        "http://cloud.synthetic.invalid",
        "https://cloud.synthetic.invalid/path",
        "https://CLOUD.synthetic.invalid",
        "https://cloud.synthetic.invalid/?x=1",
        "https://user@cloud.synthetic.invalid",
        "https://cloud.synthetic.invalid:443",
        "not-an-origin",
      ];
      for (const issuer of nonCanonical) {
        const deps = makeDeps();
        expect(await active.begin(validRequest(), { ...BINDING, cloudIssuer: issuer }, CONTEXT, deps), issuer).toEqual({
          ok: false,
          reason: "issuer",
        });
        expect(deps.attempts.rows.size).toBe(0);
      }
    });

    it("(e) a binding naming a different client key than the request is refused", async () => {
      const deps = makeDeps();
      expect(
        await active.begin(validRequest(), { ...BINDING, clientKey: "client-key-synthetic-other" }, CONTEXT, deps),
      ).toEqual({ ok: false, reason: "client-key" });
      expect(deps.attempts.rows.size).toBe(0);
    });

    it("(e) an enabled engine cannot be constructed against a non-canonical trusted issuer", () => {
      // Every downstream comparison treats the trusted issuer as the canonical
      // form, so a non-canonical configuration must fail LOUDLY at
      // construction rather than mismatch every legitimate binding.
      expect(() =>
        createEnrollmentEngine({ enabled: true, trusted: { ...TRUSTED, issuer: "http://cloud.synthetic.invalid" } }),
      ).toThrow();
      // The inert engine is unaffected: enabling is an explicit decision.
      expect(() =>
        createEnrollmentEngine({ enabled: false, trusted: { ...TRUSTED, issuer: "" } }),
      ).not.toThrow();
    });

    it("(f) a fence written to the durable store by ANOTHER instance stops a held commit", async () => {
      // The completing engine holds the newest generation and passes every
      // guard. While its commit is held, a DIFFERENT registry instance —
      // standing in for a concurrent completion's cleanup — writes the fence
      // to the DURABLE store only, never to this registry's memory. The
      // post-commit guard consults the persisted store and refuses adoption.
      resetEnrollmentFences();
      const crossInstance = new FileFencePersistence({ path: join(fenceDirectory, "cross-instance.json") });
      setEnrollmentFencePersistence(crossInstance);
      try {
        const deps = makeDeps();
        const entered = gate();
        const held = gate();
        const realCommit = deps.store.commit.bind(deps.store);
        deps.store.commit = async (request, generation) => {
          const result = await realCommit(request, generation);
          entered.release();
          await held.promise;
          return result;
        };
        const { intentId, verifier } = await beginOk(deps);
        const pending = active.complete(intentId, opts(verifier), deps);
        await entered.promise;
        // The concurrent instance fences through the durable store ONLY.
        crossInstance.add(CLIENT_KEY, { reason: "concurrent-cleanup" });
        held.release();
        const result = await pending;
        expect(result).toEqual({ ok: false, reason: "custody-unresolved" });
        // The landed record was cleaned up, and nothing usable survives.
        expect(deps.store.keys()).toEqual([]);
        expect(deps.store.credential(CLIENT_KEY)).toBeNull();
        // The fence is now visible through the module API too — via the
        // persisted store, since this registry's memory never held it until
        // the unresolved path fired.
        expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
      } finally {
        setEnrollmentFencePersistence(suiteFencePersistence);
        resetEnrollmentFences();
      }
    });
  });

  describe("helpers", () => {
    it("secretsMatch is length-safe and does not throw on a length mismatch", () => {
      expect(secretsMatch("abc", "abc")).toBe(true);
      expect(secretsMatch("abc", "abd")).toBe(false);
      // timingSafeEqual throws on unequal lengths; this guard is what stops a
      // comparison of different-length values from crashing a request.
      expect(secretsMatch("short", "much-longer-value")).toBe(false);
    });

    it("mintEnrollmentVerifier produces a verifier the proof check accepts", () => {
      const { verifier, challenge } = mintEnrollmentVerifier();
      expect(challenge).toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
      expect(verifyEnrollmentProof(verifier, challenge, "S256")).toBe(true);
    });

    it("the synthetic stores declare themselves non-conforming", () => {
      expect(new MemoryProtectedStore().conformsToProtectedCustody).toBe(false);
    });

    it("the envelope schema requires authority, session and credential expiry", async () => {
      // A record missing any of those is not a record this contract can
      // recognise — asserted against the schema itself rather than by
      // constructing an object and hoping.
      const deps = makeDeps();
      const { intentId, verifier } = await beginOk(deps);
      expect((await active.complete(intentId, opts(verifier), deps)).ok).toBe(true);
      const stored = deps.store.row(CLIENT_KEY);
      expect(stored).not.toBeNull();
      if (!stored) return;

      const envelopeWire = (await import("./installation-enrollment-contract.ts")).protectedEnvelopeWire;
      expect(envelopeWire.safeParse(stored).success).toBe(true);
      // Drop each authenticated binding in turn; the record stops parsing.
      for (const field of ["cloudAuthority", "localSessionId", "credentialExpiresAt"] as const) {
        const broken = { ...stored, [field]: undefined };
        expect(envelopeWire.safeParse(broken).success).toBe(false);
      }
    });
  });
});
