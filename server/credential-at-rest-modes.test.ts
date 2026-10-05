// Credential files at rest: the mode the server itself creates them with.
//
// The defect this pins: three credential-bearing data-dir files were written
// by raw writeFileSync + renameSync (or writeFileAtomic without a mode) and
// so landed at the process umask's default — typically 0644, readable by
// every other account on a shared machine:
//
//   pairing-codes.json — live pairing codes; the code IS the credential
//                        (server/pairing.ts, same trust model as the QR).
//   claim-codes.json   — self-host claim codes; "the code IS the credential"
//                        (server/claim.ts line 8), and the restore exclusion
//                        list already classifies it as credentials.
//   auth.secret        — the deployment signing secret: session signing AND
//                        the HKDF root of the drive-visible custody key
//                        (server/auth.ts resolveSecret). It was chmod'd only
//                        AFTER the atomic rename, so a crash in that window
//                        left it world-readable for good, and the temporary
//                        inode was broad too.
//
// Every other credential file in the data dir (config.json, user-keys.json,
// the installation authority, memory grants) is created 0600. These tests
// drive the real persist paths — a code minted, a secret resolved — and pin
// the mode the file actually lands with, so a revert to unmodeled writes
// fails here instead of silently reopening the files.
//
// POSIX modes only: the Windows runs skip, exactly like the Secure-cookie
// suite does, since the chmod catch in auth.ts already documents that story.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeInjectId } from "./drivers/local-inject.ts";
import { ensureDroidInjectModel } from "./drivers/acp/droid.ts";
import { ensureGrokInjectSlug } from "./drivers/acp/grok.ts";
import { ensureKimiInjectAlias } from "./drivers/acp/kimi.ts";
import { ensureOpenCodeInjectModel } from "./drivers/acp/opencode-go.ts";
import { ensureHermesInjectProvider } from "./drivers/acp/hermes.ts";

const T0 = 1_700_000_000_000;
const posixOnly = describe.skipIf(process.platform === "win32");

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "muster-credential-modes-"));
  // DATA_DIR is captured at module-import time (server/data-root-path.ts),
  // so the env must be set before the first dynamic import below. Each
  // test resets the module registry, which re-reads it — the same seam
  // auth.test.ts uses for SELF_HOSTED.
  process.env.OMB_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OMB_DATA_DIR;
});

const modeOf = (file: string): number => statSync(join(dataDir, file)).mode & 0o777;

posixOnly("credential files at rest", () => {
  it("creates pairing-codes.json 0600 through a real pairing-code mint", async () => {
    vi.resetModules();
    const pairing = await import("./pairing.ts");
    pairing.createCode("usr_atrestfixture", T0);
    expect(modeOf("pairing-codes.json")).toBe(0o600);
    // The write really happened through the persist path (the envelope is
    // the on-disk shape loadStore reads back), not a skipped best-effort.
    // SAFETY: the bytes were just written by pairing.ts's own persistStore,
    // whose StoreFile schema (version 1, pending of {userId, expiresAt}) is
    // the only shape this module ever writes.
    const stored = JSON.parse(readFileSync(join(dataDir, "pairing-codes.json"), "utf8")) as {
      version: number;
      pending: Record<string, { userId: string; expiresAt: number }>;
    };
    expect(stored.version).toBe(1);
    expect(Object.values(stored.pending)[0]?.userId).toBe("usr_atrestfixture");
    // A second mint rewrites OVER the existing file (the rename replaces the
    // inode) — the mode must survive a rewrite, not just first creation.
    pairing.createCode("usr_atrestfixture", T0 + 1000);
    expect(modeOf("pairing-codes.json")).toBe(0o600);
  });

  it("creates claim-codes.json 0600 through a real claim-code mint", async () => {
    vi.resetModules();
    const claim = await import("./claim.ts");
    claim.createClaimCode(T0);
    expect(modeOf("claim-codes.json")).toBe(0o600);
    // SAFETY: the bytes were just written by claim.ts's own persistStore,
    // whose StoreFile schema (version 1, pending of {expiresAt}) is the
    // only shape this module ever writes.
    const stored = JSON.parse(readFileSync(join(dataDir, "claim-codes.json"), "utf8")) as {
      version: number;
      pending: Record<string, { expiresAt: number }>;
    };
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.pending)).toHaveLength(1);
    claim.createClaimCode(T0 + 1000);
    expect(modeOf("claim-codes.json")).toBe(0o600);
  });

  it("creates auth.secret 0600 at generation, with 32 bytes of base64 inside", async () => {
    // The generation path only runs on a desktop install (SELF_HOSTED false
    // at import time) with no env secret — the exact conditions under which
    // resolveSecret persists the file this test pins.
    const saved = { ...process.env };
    try {
      delete process.env.OMB_HOST;
      delete process.env.OMB_PUBLIC_HOST;
      delete process.env.BETTER_AUTH_SECRET;
      process.env.OMB_DATA_DIR = dataDir;
      vi.resetModules();
      const auth = await import("./auth.ts");
      const secret = auth.deploymentSigningSecret();
      expect(modeOf("auth.secret")).toBe(0o600);
      expect(secret).toBe(readFileSync(join(dataDir, "auth.secret"), "utf8").trim());
      expect(Buffer.from(secret, "base64").byteLength).toBe(32);
      // Resolution is restart-stable: a second call reads the same file.
      expect(auth.deploymentSigningSecret()).toBe(secret);
      expect(modeOf("auth.secret")).toBe(0o600);
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });

  it("repairs a legacy auth.secret left broad by an older build", async () => {
    // The review's P2: the early-return path never chmod'd, so a file an
    // older build left at 0644 stayed broad forever on upgraded installs.
    const saved = { ...process.env };
    try {
      delete process.env.OMB_HOST;
      delete process.env.OMB_PUBLIC_HOST;
      delete process.env.BETTER_AUTH_SECRET;
      process.env.OMB_DATA_DIR = dataDir;
      chmodSync(join(dataDir, "auth.secret"), 0o644);
      vi.resetModules();
      const auth = await import("./auth.ts");
      const secret = auth.deploymentSigningSecret();
      expect(secret).toBe(readFileSync(join(dataDir, "auth.secret"), "utf8").trim());
      expect(modeOf("auth.secret")).toBe(0o600);
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });
});

// The five ACP BYOK drivers write real provider API keys into each driver's
// own config file through the shared discipline in
// server/drivers/acp/credential-write.ts: first creation lands 0600 and a
// pre-existing broad file tightens. These drive the real upsert entries.
const driverFixtures: string[] = [];
afterAll(() => {
  for (const dir of driverFixtures) rmSync(dir, { recursive: true, force: true });
});
const fixtureEnv = (override: Record<string, string>): Record<string, string> => ({
  ...override, PATH: process.env.PATH ?? "",
});
const fixtureHome = (label: string): string => {
  const home = mkdtempSync(join(tmpdir(), label));
  driverFixtures.push(home);
  return home;
};
const driverModes = describe.skipIf(process.platform === "win32");

driverModes("ACP driver BYOK config files", () => {
  const host = "omlx";
  const first = encodeInjectId(host, "fixture-model-a");
  const second = encodeInjectId(host, "fixture-model-b");

  it("creates the droid settings.json 0600 and tightens a broad legacy file", () => {
    const home = fixtureHome("muster-acp-droid-");
    ensureDroidInjectModel(first, fixtureEnv({ FACTORY_HOME_OVERRIDE: home }));
    const file = join(home, ".factory", "settings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    expect(ensureDroidInjectModel(second, fixtureEnv({ FACTORY_HOME_OVERRIDE: home }))).not.toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("fixture-model-b");
  });

  it("creates the grok config.toml 0600", () => {
    const home = fixtureHome("muster-acp-grok-");
    // The grok driver writes into an existing ~/.grok (its CLI creates it);
    // mirror that precondition instead of changing driver semantics.
    mkdirSync(join(home, ".grok"), { recursive: true });
    ensureGrokInjectSlug(first, fixtureEnv({ GROK_HOME: join(home, ".grok") }));
    expect(statSync(join(home, ".grok", "config.toml")).mode & 0o777).toBe(0o600);
  });

  it("creates the kimi config.toml 0600 with a private data root", () => {
    const home = fixtureHome("muster-acp-kimi-");
    ensureKimiInjectAlias(first, fixtureEnv({ KIMI_CODE_HOME: join(home, ".kimi-code") }));
    expect(statSync(join(home, ".kimi-code", "config.toml")).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777 & 0o070).toBe(0);
  });

  it("creates the opencode config.json 0600", () => {
    const home = fixtureHome("muster-acp-opencode-");
    ensureOpenCodeInjectModel(first, fixtureEnv({ XDG_CONFIG_HOME: join(home, ".config"), HOME: home }));
    expect(statSync(join(home, ".config", "opencode", "opencode.json")).mode & 0o777).toBe(0o600);
  });

  it("creates the hermes config.yaml 0600", () => {
    const home = fixtureHome("muster-acp-hermes-");
    ensureHermesInjectProvider(first, fixtureEnv({ HERMES_HOME: join(home, ".hermes") }));
    expect(statSync(join(home, ".hermes", "config.yaml")).mode & 0o777).toBe(0o600);
  });
});
