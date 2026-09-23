// Live acceptance for DESIGN §38 M1–M2 over real HTTP: one hosted fixture,
// two real email accounts (owner + grantee), and every route in
// server/memory-routes.ts — the session gate, default deny, the grant
// lifecycle (issue → serve → withdraw, immediate), validation, real-time
// expiry, and the existing audit ledger's entries. Boot pattern mirrors
// server/team-ownership-harness.test.ts; owned files only, all child
// outbound traffic never started from here.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import type { JsonValue } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const errorSchema = z.object({ error: z.string() }).passthrough();
const botSchema = z.object({ id: z.string() }).passthrough();
const provenanceSchema = z.object({ kind: z.enum(["memory", "fact"]) }).passthrough();
const hitSchema = z.object({
  id: z.string(),
  kind: z.enum(["fact", "memory"]),
  title: z.string(),
  score: z.number(),
  matched: z.array(z.string()),
  components: z.object({ bm25: z.number(), recency: z.number() }),
  createdAt: z.number(),
  provenance: provenanceSchema,
}).passthrough();
const searchSchema = z.object({
  mode: z.enum(["search", "browse"]),
  limit: z.number().int(),
  hits: z.array(hitSchema),
  via: z.enum(["owner", "desktop", "grant"]),
}).passthrough();
const grantSchema = z.object({
  id: z.string(),
  grantorId: z.string().optional(),
  grantee: z.object({ kind: z.enum(["bot", "user"]), id: z.string() }),
  botId: z.string(),
  resource: z.enum(["memory", "facts"]),
  permission: z.enum(["read", "read-write"]),
  createdAt: z.number(),
  expiresAt: z.number().optional(),
  revokedAt: z.number().optional(),
}).passthrough();
const grantListSchema = z.object({ grants: z.array(grantSchema) }).passthrough();
const grantOneSchema = z.object({ grant: grantSchema }).passthrough();
const auditSchema = z.object({
  entries: z.array(z.object({
    id: z.string(),
    at: z.number(),
    action: z.string(),
    decision: z.enum(["approved", "denied", "auto"]),
    summary: z.string(),
  }).passthrough()),
}).passthrough();

describe.skipIf(process.platform === "win32")("memory access over the live harness", () => {
  let dir = "";
  let url = "";
  const children: ChildProcess[] = [];
  let ownerCookie = "";
  let ownerId = "";
  let granteeCookie = "";
  let granteeId = "";
  let botId = "";

  const api = (path: string, method = "GET", body?: JsonValue, session = ownerCookie) => {
    const headers = new Headers({ origin: url, "content-type": "application/json", cookie: session });
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${url}${path}`, init);
  };
  const searchPath = (query = ""): string => `/api/bots/${botId}/memory/search${query}`;
  const grantsPath = (suffix = ""): string => `/api/bots/${botId}/memory/grants${suffix}`;
  const grantBody = () => ({
    grantee: { kind: "user", id: granteeId },
    resource: "memory",
    permission: "read",
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muster-memory-access-"));
    const dataDirectory = join(dir, "data");
    const home = join(dir, "home");
    const companion = join(dir, "companion");
    const ui = join(dir, "ui");
    for (const path of [dataDirectory, home, companion, ui]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned memory fixture</title>");
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      profile: { name: "Memory fixture operator" },
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline memory fixture" } },
    }), { mode: 0o600 });
    // Lapsed trial, no license: creation runs on the FREE tier — the mirror
    // of the team-ownership fixture so POST /api/bots is never tier-gated.
    writeFileSync(join(dataDirectory, "license.json"), JSON.stringify({
      firstLaunchAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      license: null,
    }), { mode: 0o600 });
    const port = await freePortBlock([0, 1, 2], 31_000, 10_000);
    const env = pairingServerEnvironment({
      home,
      dataDirectory,
      companionDirectory: companion,
      staticDir: ui,
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    // Hosted mode: OMB_PUBLIC_HOST flips SELF_HOSTED on, so the session
    // gate 401s anonymous /api/* — the exact gate these routes mount behind.
    Object.assign(env, {
      OMB_PUBLIC_HOST: `127.0.0.1:${port}`,
      OMB_ALLOW_SIGNUPS: "true",
      GOOGLE_CLIENT_ID: randomBytes(24).toString("hex"),
      GOOGLE_CLIENT_SECRET: randomBytes(24).toString("hex"),
    });
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);

    const signUp = async (label: string): Promise<{ cookie: string; id: string }> => {
      const response = await api("/api/auth/sign-up/email", "POST", {
        name: `Memory ${label}`,
        email: `${label}-${randomBytes(8).toString("hex")}@example.test`,
        password: randomBytes(24).toString("base64url"),
      }, "");
      expect(response.status).toBe(200);
      const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
      const header = response.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
      if (!header) throw new Error("signup did not return a session");
      // Hosted storage-sovereignty gate: open for this fresh account.
      seedConnectedGoogleRow(dataDirectory, user.id);
      return { cookie: header.split(";")[0], id: user.id };
    };
    const owner = await signUp("owner");
    const grantee = await signUp("grantee");
    ownerCookie = owner.cookie;
    ownerId = owner.id;
    granteeCookie = grantee.cookie;
    granteeId = grantee.id;
    expect(ownerCookie).not.toBe("");
    expect(granteeCookie).not.toBe("");
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    const exited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    if (dir && exited) await removeTempDir(dir);
    const rootRemoved = !dir || !existsSync(dir);
    console.info(JSON.stringify({
      scope: "memory access cleanup",
      pids: children.map((child) => child.pid),
      exited,
      rootRemoved,
    }));
    expect({ exited, rootRemoved }).toEqual({ exited: true, rootRemoved: true });
  }, 20_000);

  it("refuses every memory route without a session", async () => {
    const routes: Array<[string, string, JsonValue | undefined]> = [
      ["GET", "/api/bots/any-bot/memory/search?q=x", undefined],
      ["GET", "/api/bots/any-bot/memory/grants", undefined],
      ["POST", "/api/bots/any-bot/memory/grants", { grantee: { kind: "user", id: "someone" }, resource: "memory", permission: "read" }],
      ["DELETE", "/api/bots/any-bot/memory/grants/some-id", undefined],
    ];
    for (const [method, path, body] of routes) {
      const response = await api(path, method, body, "");
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("answers the guard's 404 for an unknown bot", async () => {
    const unknown = "/api/bots/no-such-bot-404/memory/search?q=x";
    const search = await api(unknown);
    expect(search.status).toBe(404);
    expect(errorSchema.parse(await search.json()).error).toBe("no such bot");
    expect((await api("/api/bots/no-such-bot-404/memory/grants")).status).toBe(404);
    const issue = await api("/api/bots/no-such-bot-404/memory/grants", "POST", {
      grantee: { kind: "user", id: granteeId },
      resource: "memory",
      permission: "read",
    });
    expect(issue.status).toBe(404);
  });

  it("creates the owner's bot and seeds memory plus one fact", async () => {
    const created = await api("/api/bots", "POST", {});
    expect(created.status).toBe(201);
    botId = z.object({ bot: botSchema }).parse(await created.json()).bot.id;
    const memory = await api(`/api/bots/${botId}/memory`, "PUT", {
      text: "Owner private note: staging deploy checklist for the release.",
    });
    expect(memory.status).toBe(200);
    const fact = await api("/api/brain/facts", "POST", {
      text: "deploy pipeline owner is finance-team",
      source: "memory harness",
    });
    expect(fact.status).toBe(201);
  });

  it("lets the owner search both corpora with provenance and clamps limits", async () => {
    const response = await api(searchPath("?q=deploy"));
    expect(response.status).toBe(200);
    const body = searchSchema.parse(await response.json());
    expect(body.via).toBe("owner");
    expect(body.mode).toBe("search");
    expect(body.limit).toBe(8); // default cap applied
    expect(body.hits.length).toBeGreaterThan(0);
    expect(new Set(body.hits.map((hit) => hit.kind))).toEqual(new Set(["memory", "fact"]));
    for (const hit of body.hits) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.matched).toContain("deploy");
      expect(hit.components.recency).toBeGreaterThanOrEqual(1);
      expect(hit.provenance.kind === "memory" || hit.provenance.kind === "fact").toBe(true);
    }

    const clamped = searchSchema.parse(await (await api(searchPath("?q=deploy&limit=999"))).json());
    expect(clamped.limit).toBe(50);
    const floored = searchSchema.parse(await (await api(searchPath("?q=deploy&limit=0"))).json());
    expect(floored.limit).toBe(1);
    const emptyParam = searchSchema.parse(await (await api(searchPath("?q=deploy&limit="))).json());
    expect(emptyParam.limit).toBe(8);

    const browse = searchSchema.parse(await (await api(searchPath())).json());
    expect(browse.mode).toBe("browse");
    expect(browse.hits.every((hit) => hit.score === 0)).toBe(true);
    const whitespace = searchSchema.parse(await (await api(searchPath("?q=%20%20"))).json());
    expect(whitespace.mode).toBe("browse");
  });

  it("denies a non-owner by default on search, grants, and the write path", async () => {
    const denied = await api(searchPath("?q=deploy"), "GET", undefined, granteeCookie);
    expect(denied.status).toBe(404);
    expect(errorSchema.parse(await denied.json()).error).toBe("no such bot");
    expect((await api(grantsPath(), "GET", undefined, granteeCookie)).status).toBe(404);
    expect((await api(grantsPath(), "POST", grantBody(), granteeCookie)).status).toBe(404);
    expect((await api(grantsPath("/some-id"), "DELETE", undefined, granteeCookie)).status).toBe(404);
    // The write path below this family is the shared guard's 404 too.
    const overwrite = await api(`/api/bots/${botId}/memory`, "PUT", { text: "grantee overwrite" }, granteeCookie);
    expect(overwrite.status).toBe(404);
  });

  it("issues a grant, serves the grantee through it, and withdraws it immediately", async () => {
    const issue = await api(grantsPath(), "POST", grantBody());
    expect(issue.status).toBe(201);
    const grant = grantOneSchema.parse(await issue.json()).grant;
    expect(grant.botId).toBe(botId);
    expect(grant).toMatchObject({ resource: "memory", permission: "read" });
    expect(grant.grantorId).toBe(ownerId);

    const list = grantListSchema.parse(await (await api(grantsPath())).json());
    expect(list.grants.map((entry) => entry.id)).toContain(grant.id);
    // The grantee probing the list still sees the guard's 404, never the rows.
    expect((await api(grantsPath(), "GET", undefined, granteeCookie)).status).toBe(404);

    const granted = await api(searchPath("?q=deploy"), "GET", undefined, granteeCookie);
    expect(granted.status).toBe(200);
    const grantedBody = searchSchema.parse(await granted.json());
    expect(grantedBody.via).toBe("grant");
    expect(grantedBody.hits.length).toBeGreaterThan(0);
    expect(grantedBody.hits.every((hit) => hit.kind === "memory")).toBe(true);
    expect(grantedBody.hits.every((hit) => hit.provenance.kind === "memory")).toBe(true);

    const ownerView = searchSchema.parse(await (await api(searchPath("?q=deploy"))).json());
    expect(new Set(ownerView.hits.map((hit) => hit.kind))).toEqual(new Set(["memory", "fact"]));

    const revoke = await api(grantsPath(`/${grant.id}`), "DELETE");
    expect(revoke.status).toBe(200);
    expect(grantOneSchema.parse(await revoke.json()).grant.revokedAt).toBeGreaterThan(0);
    expect((await api(searchPath("?q=deploy"), "GET", undefined, granteeCookie)).status).toBe(404);
    expect((await api(grantsPath(`/${grant.id}`), "DELETE")).status).toBe(404); // double revoke misses
    expect((await api(grantsPath("/no-such-grant"), "DELETE")).status).toBe(404);
  });

  it("rejects malformed grant payloads with 400", async () => {
    const schemaFailures: Array<[string, JsonValue]> = [
      ["traversal grantee id", { grantee: { kind: "user", id: "../../etc/passwd" }, resource: "memory", permission: "read" }],
      ["unknown grantee kind", { grantee: { kind: "group", id: "ok" }, resource: "memory", permission: "read" }],
      ["unknown resource", { grantee: { kind: "user", id: "ok" }, resource: "everything", permission: "read" }],
      ["unknown permission", { grantee: { kind: "user", id: "ok" }, resource: "memory", permission: "admin" }],
      ["missing grantee", { resource: "memory", permission: "read" }],
      ["oversized grantee id", { grantee: { kind: "user", id: "a".repeat(129) }, resource: "memory", permission: "read" }],
    ];
    for (const [label, body] of schemaFailures) {
      const response = await api(grantsPath(), "POST", body);
      expect(response.status, label).toBe(400);
      expect(errorSchema.parse(await response.json()).error, label).toContain("invalid grant");
    }
    const pastExpiry = await api(grantsPath(), "POST", {
      grantee: { kind: "user", id: granteeId },
      resource: "memory",
      permission: "read",
      expiresAt: Date.now() - 10_000,
    });
    expect(pastExpiry.status).toBe(400);
    expect(errorSchema.parse(await pastExpiry.json()).error).toContain("expiry must be in the future");
  });

  it("honors expiry in real time and accepts a read-write grant for a read", async () => {
    const expiresAt = Date.now() + 2_500;
    const issue = await api(grantsPath(), "POST", { ...grantBody(), expiresAt });
    expect(issue.status).toBe(201);
    expect(grantOneSchema.parse(await issue.json()).grant.expiresAt).toBe(expiresAt);
    expect((await api(searchPath("?q=deploy"), "GET", undefined, granteeCookie)).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 3_100));
    expect((await api(searchPath("?q=deploy"), "GET", undefined, granteeCookie)).status).toBe(404);

    // A read-write grant satisfies a read — the ladder only upgrades.
    const upgrade = await api(grantsPath(), "POST", { ...grantBody(), permission: "read-write" });
    expect(upgrade.status).toBe(201);
    const upgraded = await api(searchPath("?q=deploy"), "GET", undefined, granteeCookie);
    expect(upgraded.status).toBe(200);
    expect(searchSchema.parse(await upgraded.json()).via).toBe("grant");
    const withdraw = await api(grantsPath(`/${grantOneSchema.parse(await upgrade.json()).grant.id}`), "DELETE");
    expect(withdraw.status).toBe(200);
    expect((await api(searchPath("?q=deploy"), "GET", undefined, granteeCookie)).status).toBe(404);
  }, 25_000);

  it("records grant and revoke changes in the existing audit ledger", async () => {
    // Explicit limit: queryAudit's missing-param path clamps to 1 today, so
    // the default page would show only the newest verdict — not the family's
    // full grant/revoke history (decision-log.ts is outside this slice).
    const response = await api(`/api/bots/${botId}/audit?limit=50`);
    expect(response.status).toBe(200);
    const { entries } = auditSchema.parse(await response.json());
    const issued = entries.filter((entry) => entry.action === "memory_grant");
    const revoked = entries.filter((entry) => entry.action === "memory_grant_revoke");
    expect(issued.length).toBeGreaterThanOrEqual(3); // lifecycle + expiry + read-write
    expect(issued.every((entry) => entry.decision === "approved")).toBe(true);
    expect(revoked.length).toBeGreaterThanOrEqual(2); // lifecycle + read-write
    expect(revoked.every((entry) => entry.decision === "denied")).toBe(true);
    expect(issued.some((entry) => entry.summary.includes(`user ${granteeId}`))).toBe(true);
    expect(revoked.some((entry) => entry.summary.includes(`user ${granteeId}`))).toBe(true);
    // The audit surface itself stays owner-scoped behind the shared guard.
    expect((await api(`/api/bots/${botId}/audit`, "GET", undefined, granteeCookie)).status).toBe(404);
  });
});
