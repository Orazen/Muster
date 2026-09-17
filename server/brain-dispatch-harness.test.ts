// Live acceptance for brain-backed dispatch: the workspace brain and the
// Jev ranking, integrated. Facts recorded by the owner via /api/brain (the
// same route the fleet-MCP brain_write tool hits) must flip the
// recommend_team ranking toward the bot the brain cites — institutional
// memory over profile keywords, over the real booted server with a real
// peer lease. Boot and lease minting mirror
// server/peer-capabilities-harness.test.ts (held turn → session receipt →
// OMB_COMMS_TOKEN), but recommend_team is read-only, so no release dance:
// the token works for the whole TTL.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import type { JsonObject } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe.skipIf(process.platform === "win32")("brain-backed dispatch over the live harness", () => {
  let directory = "";
  let data = "";
  let receipts = "";
  let url = "";
  let cookie = "";
  let token = "";
  const children: ChildProcess[] = [];
  const createdBot = z.object({ bot: z.object({ id: z.string(), name: z.string() }) });

  const api = (path: string, method = "GET", body?: JsonObject, bearer = token) => {
    const request: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url, ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }) },
    };
    if (body !== undefined) request.body = JSON.stringify(body);
    return fetch(`${url}${path}`, request);
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-brain-dispatch-"));
    data = join(directory, "data"); receipts = join(directory, "receipts");
    const home = join(directory, "home"), companion = join(directory, "companion"), ui = join(directory, "ui");
    for (const p of [data, receipts, home, companion, ui]) mkdirSync(p, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned brain-dispatch fixture</title>");
    const fake = join(ROOT, "server/testing/fake-acp-cli.ts");
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { held: { driver: "grokAgent", config: { cli: fake, fullAuto: true }, environment: { FAKE_ACP_MODE: "peer-capability", FAKE_ACP_PEER_DIRECTORY: receipts } } },
    }), { mode: 0o600 });
    const port = await freePortBlock([0, 1, 2], 46000, 9000);
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: companion, staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
    Object.assign(env, { OMB_ALLOW_SIGNUPS: "true" });
    const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);

    const signup = await fetch(`${url}/api/auth/sign-up/email`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ email: `bd-${randomBytes(6).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url"), name: "Brain Dispatch" }),
    });
    expect(signup.status).toBe(200);
    // SAFETY: better-auth always sets this cookie name on email signup.
    cookie = (signup.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    // Hide the seeded bot, then create the caller, one visible peer (the
    // agents integration only mounts when a rankable teammate exists), and
    // start the caller's held turn — the dispatch receipt carries the
    // agents integration's comms token.
    for (const bot of z.object({ bots: z.array(z.object({ id: z.string() })) }).parse(await (await api("/api/bots")).json()).bots) {
      await api(`/api/bots/${bot.id}`, "PATCH", { hidden: true });
    }
    const created = createdBot.parse(await (await api("/api/bots", "POST", {})).json()).bot;
    await api(`/api/bots/${created.id}`, "PATCH", { name: "Router", modelSelection: { instanceId: "held", model: "fake-acp-model" }, computer: "off" });
    const peer = createdBot.parse(await (await api("/api/bots", "POST", {})).json()).bot;
    await api(`/api/bots/${peer.id}`, "PATCH", { name: "Peer", title: "placeholder", computer: "off" });
    const known = new Set(readdirSync(receipts).filter((n) => n.endsWith(".session.json")));
    const send = await api(`/api/bots/${created.id}/messages`, "POST", { text: "Owned held turn" });
    expect(send.status).toBe(202);
    const deadline = Date.now() + 25_000;
    for (;;) {
      const fresh = readdirSync(receipts).filter((n) => n.endsWith(".session.json") && !known.has(n));
      if (fresh.length && existsSync(join(receipts, fresh[0].replace(".session.json", ".prompt.json")))) {
        const receipt = z.object({
          pid: z.number(),
          servers: z.array(z.object({ name: z.string(), env: z.array(z.object({ name: z.string(), value: z.string() })) })),
        }).parse(JSON.parse(readFileSync(join(receipts, fresh[0]), "utf8")));
        const agents = receipt.servers.find((s) => s.name === "agents");
        const values = Object.fromEntries((agents?.env ?? []).map((e) => [e.name, e.value]));
        token = values.OMB_COMMS_TOKEN ?? "";
        break;
      }
      if (Date.now() > deadline) throw new Error("held turn never minted a dispatch receipt");
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(token).not.toBe("");
  }, 45_000);

  afterAll(async () => {
    for (const pid of readdirSync(receipts).filter((n) => n.endsWith(".session.json")).map((n) => n.replace(".session.json", ""))) {
      if (!existsSync(join(receipts, `${pid}.release`))) writeFileSync(join(receipts, `${pid}.release`), "release", { mode: 0o600 });
    }
    await Promise.all(children.map((c) => waitForExit(c, { signal: "SIGTERM" })));
    await removeTempDir(directory);
  });

  const dispatchResult = z.object({
    dispatch: z.object({
      handleSelf: z.boolean(),
      picks: z.array(z.object({ botId: z.string(), name: z.string(), reason: z.string() })),
      advisory: z.string(),
    }),
  });

  it("ranks the keyword-stronger bot while the brain holds no roster facts", async () => {
    const a = createdBot.parse(await (await api("/api/bots", "POST", {})).json()).bot;
    await api(`/api/bots/${a.id}`, "PATCH", { name: "Archivist", title: "records and archives" });
    const b = createdBot.parse(await (await api("/api/bots", "POST", {})).json()).bot;
    await api(`/api/bots/${b.id}`, "PATCH", { name: "Ledger", title: "database pipelines" });

    const res = await api("/api/internal/recommend-team", "POST", {
      task: "run the database migration review",
    });
    expect(res.status).toBe(200);
    const { dispatch } = dispatchResult.parse(await res.json());
    expect(dispatch.handleSelf).toBe(false);
    expect(dispatch.picks[0].name).toBe("Ledger");
    expect(dispatch.picks[0].reason).not.toContain("workspace brain cites");
  });

  it("flips the ranking to the brain-cited bot after facts are recorded", async () => {
    // Same roster; now the owner records facts naming Archivist as the one
    // who actually did the database work — exactly what a settled turn or
    // the fleet-MCP brain_write tool would leave behind.
    for (const text of [
      "Ledger walked Archivist through the database migration review checklist",
      "Archivist filed the database migration review notes",
    ]) {
      const write = await api("/api/brain/facts", "POST", { text, source: `Archivist log ${randomBytes(4).toString("hex")}` });
      expect(write.status).toBe(201);
    }
    const res = await api("/api/internal/recommend-team", "POST", {
      task: "run the database migration review",
    });
    expect(res.status).toBe(200);
    const { dispatch } = dispatchResult.parse(await res.json());
    expect(dispatch.picks[0].name).toBe("Archivist");
    expect(dispatch.picks[0].reason).toContain("workspace brain cites");
  });
});
