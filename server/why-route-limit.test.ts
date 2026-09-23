// The why-journal read route's limit contract (performance-heavy-users-
// study, slice A4): a missing ?limit used to mean "the whole journal",
// which on a heavy fleet meant shipping the full 150-entry audit trail on
// every approval-card read. The default is now bounded to the same 100 a
// present param always was — and this suite pins that ONLY the absent-param
// case changed: ?limit=N is honored exactly as before (clamped to ≤100),
// a present-but-unusable value still falls back to no cap (the documented
// quirk, byte-for-byte the old code path), and the botId filter runs before
// the cap so one bot's journal can never eat another's budget or leak in.
//
// Boots the real server with a throwaway home and seeds the journal file
// directly — the route reads it lazily, so the fixture lands before the
// first why request.
//
// POSIX-gated like the other boot-a-real-server suites.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JsonValue } from "./schema.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

/** More own entries than the default cap, so both sides of the boundary
 * are observable: 100 proves the cap, 150 proves it is not the whole file. */
const OWN_ENTRIES = 150;
/** Newer than every own entry — if the cap ever ran before the botId
 * filter, these would be the first thing to leak into the answer. */
const STRANGER_ENTRIES = 40;

interface WhyEntryFixture {
  runId: string;
  botId: string;
  threadId: string;
  at: number;
  intent: string;
  decisions: string[];
  outcome: "done";
}

const entry = (runId: string, botId: string, threadId: string, at: number): WhyEntryFixture => ({
  runId,
  botId,
  threadId,
  at,
  intent: `why ${runId}`,
  decisions: ["kept the default"],
  outcome: "done",
});

posixOnly("why route default limit", () => {
  let child: ChildProcess;
  let home: string;
  let botId: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: JsonValue): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const readWhy = (query = "") => api("GET", `/api/bots/${botId}/why${query}`);

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-why-limit-test-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    writeFileSync(join(home, ".muster", "config.json"), JSON.stringify({ instances: {} }));

    const bin = join(home, "empty-bin");
    mkdirSync(bin);
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: bin, OMB_PORT: String(PORT) };
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }

    const created = await api("POST", "/api/bots");
    if (created.status !== 201) throw new Error(`could not create a fixture bot: ${created.status}`);
    botId = created.body.bot.id;
    // the journal only validates threadId as a nonempty string, so the
    // created bot's own thread (or a fixed stand-in) both satisfy the schema
    const threadId = created.body.bot.threadId ?? "why-fixture-thread";

    // Seed AFTER the bot exists (the route 404s unknown bots) and BEFORE
    // the first why request (the journal loads lazily and caches per path).
    const own = Array.from({ length: OWN_ENTRIES }, (_, i) => entry(`run-${i}`, botId, threadId, i));
    const stranger = Array.from({ length: STRANGER_ENTRIES }, (_, i) =>
      entry(`stranger-${i}`, "why-stranger-bot", "stranger-thread", 5_000 + i),
    );
    writeFileSync(
      join(home, ".muster", "why-journal.json"),
      JSON.stringify({ version: 1, entries: [...own, ...stranger] }),
    );
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("bounds an absent ?limit to 100, newest first, this bot only", async () => {
    const { status, body } = await readWhy();
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(100);
    expect(body.entries.every((e: { botId: string }) => e.botId === botId)).toBe(true);
    // newest first, and the boundary is the 100th own entry — not the
    // newer stranger rows, not the oldest own rows
    expect(body.entries[0].runId).toBe(`run-${OWN_ENTRIES - 1}`);
    expect(body.entries[99].runId).toBe(`run-${OWN_ENTRIES - 100}`);
  });

  it("honors a present ?limit exactly as before", async () => {
    const asked = await readWhy("?limit=50");
    expect(asked.status).toBe(200);
    expect(asked.body.entries).toHaveLength(50);
    expect(asked.body.entries[0].runId).toBe(`run-${OWN_ENTRIES - 1}`);

    // a present param was always hard-clamped to ≤100 — that ceiling did
    // not move with the new default
    const over = await readWhy("?limit=150");
    expect(over.status).toBe(200);
    expect(over.body.entries).toHaveLength(100);
  });

  it("still answers a present-but-unusable ?limit with the whole journal", async () => {
    // the old code fell back to "no cap" whenever a PRESENT value was not a
    // positive finite number; that path is untouched, quirk included
    for (const query of ["?limit=abc", "?limit=0"]) {
      const { status, body } = await readWhy(query);
      expect(status).toBe(200);
      // all of this bot's entries — the filter runs before any cap
      expect(body.entries).toHaveLength(OWN_ENTRIES);
      // and the newer stranger rows never leak in, no matter the limit
      expect(body.entries.every((e: { botId: string }) => e.botId === botId)).toBe(true);
      expect(body.entries[0].runId).toBe(`run-${OWN_ENTRIES - 1}`);
    }
  });
});
