// Live acceptance for the workspace brain over the real harness routes:
// an email-signed-up primary writes facts, queries with gap analysis, and
// withdraws; a second account must never see the first account's slice
// (the gbrain company-brain invariant, enforced by ownerId filtering).
// Boot pattern mirrors server/account-drive-roundtrip.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe.skipIf(process.platform === "win32")("workspace brain over the live harness", () => {
  let dir = "";
  const children: ChildProcess[] = [];
  let url = "";
  let cookieA = "";
  let cookieB = "";

  type ApiBody = Record<string, string | number | boolean>;
  const api = (path: string, method = "GET", body?: ApiBody, session = cookieA) => {
    const request: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url, cookie: session },
    };
    if (body !== undefined) request.body = JSON.stringify(body);
    return fetch(`${url}${path}`, request);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muster-brain-live-"));
    const dataDirectory = join(dir, "data");
    const home = join(dir, "home"), companion = join(dir, "companion"), ui = join(dir, "ui");
    for (const p of [dataDirectory, home, companion, ui]) mkdirSync(p, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned brain fixture</title>");
    writeFileSync(join(dataDirectory, "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline brain fixture" } },
    }), { mode: 0o600 });
    const port = await freePortBlock([0, 1, 2], 46000, 9000);
    const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_ALLOW_SIGNUPS: "true" });
    const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);

    const signup = async (label: string) => {
      const res = await api("/api/auth/sign-up/email", "POST", {
        email: `${label}-${randomBytes(6).toString("hex")}@example.test`,
        password: randomBytes(24).toString("base64url"),
        name: `Brain ${label}`,
      }, "");
      expect(res.status).toBe(200);
      // SAFETY: better-auth always sets this cookie name on email signup.
      return (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    };
    cookieA = await signup("alpha");
    cookieB = await signup("beta");
    expect(cookieA).not.toBe("");
    expect(cookieB).not.toBe("");
  }, 30_000);

  afterAll(async () => {
    await Promise.all(children.map((c) => waitForExit(c, { signal: "SIGTERM" })));
    await removeTempDir(dir);
  });

  it("starts empty and reports stats", async () => {
    const res = await api("/api/brain");
    expect(res.status).toBe(200);
    const body = statsBody.parse(await res.json());
    expect(body.brain.facts).toBe(0);
    expect(body.brain.withdrawn).toBe(0);
  });

  it("rejects a fact without provenance", async () => {
    const res = await api("/api/brain/facts", "POST", { text: "Undated rumor" });
    expect(res.status).toBe(400);
  });

  // Boundary parsing: every response below is the harness's own /api/brain
  // route, parsed with zod instead of casts — the shape is also pinned by
  // server/workspace-brain.test.ts.
  const factSchema = z.object({ id: z.string(), text: z.string(), kind: z.string(), source: z.string() });
  const queryResultSchema = z.object({
    hits: z.array(z.object({ fact: factSchema, matched: z.array(z.string()), score: z.number() })),
    gaps: z.array(z.string()),
    unknownEntities: z.array(z.string()),
  });
  const queryBody = z.object({ result: queryResultSchema });
  const writeBody = z.object({ fact: factSchema });
  const statsBody = z.object({ brain: z.object({ facts: z.number(), withdrawn: z.number() }) });

  it("writes, queries with citations, and reports gaps", async () => {
    const write = await api("/api/brain/facts", "POST", {
      text: "Alice Chen runs engineering at Acme AI",
      source: "kickoff meeting 2026-09-17",
      kind: "person",
    });
    expect(write.status).toBe(201);
    const { fact } = writeBody.parse(await write.json());
    expect(fact.id).not.toBe("");

    const query = await api("/api/brain/query", "POST", { text: "who runs engineering at Acme?" });
    expect(query.status).toBe(200);
    const { result } = queryBody.parse(await query.json());
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].fact.text).toContain("Alice");
    expect(result.hits[0].matched).toContain("engineering");

    const miss = await api("/api/brain/query", "POST", { text: "what did Initech agree to?" });
    const missBody = queryBody.parse(await miss.json());
    expect(missBody.result.hits.length).toBe(0);
    expect(missBody.result.gaps.some((g) => g.includes("Nothing in the brain matches"))).toBe(true);
  });

  it("withdraws a fact and answers honestly about provenance", async () => {
    const write = await api("/api/brain/facts", "POST", {
      text: "The launch is planned for March 1",
      source: "planning doc",
    });
    const { fact } = writeBody.parse(await write.json());
    expect((await api(`/api/brain/facts/${fact.id}/withdraw`, "POST")).status).toBe(200);
    const live = queryBody.parse(await (await api("/api/brain/query", "POST", { text: "launch" })).json());
    expect(live.result.hits.length).toBe(0);
    const audit = queryBody.parse(await (await api("/api/brain/query", "POST", { text: "launch", includingWithdrawn: true })).json());
    expect(audit.result.hits.length).toBe(1);
  });

  it("keeps accounts isolated: beta never sees alpha's facts", async () => {
    const betaQuery = await fetch(`${url}/api/brain/query`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url, cookie: cookieB },
      body: JSON.stringify({ text: "Alice engineering Acme launch March" }),
    });
    const betaBody = queryBody.parse(await betaQuery.json());
    expect(betaBody.result.hits.length).toBe(0);
    // and beta writing works into its own slice
    const betaWrite = await fetch(`${url}/api/brain/facts`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url, cookie: cookieB },
      body: JSON.stringify({ text: "Beta team uses its own runbook", source: "beta standup" }),
    });
    expect(betaWrite.status).toBe(201);
    const alphaStill = queryBody.parse(await (await api("/api/brain/query", "POST", { text: "runbook" })).json());
    expect(alphaStill.result.hits.length).toBe(0);
  });
});
