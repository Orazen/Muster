// The replay ring's shaping rule (performance-heavy-users-study, slice A3)
// plus the resume math it feeds, end to end.
//
// Two layers, because the rule has two halves:
//   - unit: retainForReplay keeps a screen frame's sequence slot but not its
//     picture (identity fields only, frame: null so the replay loop skips
//     it), and passes every other kind through as the very same references —
//     no copy on the broadcast hot path;
//   - booted: a real reconnect still gets resumed: true and exactly the
//     frames it missed, in order — proving the ring built through the new
//     shaping path answers "what did I miss?" with the same honest gaps it
//     always did. A live screen frame e2e would need a configured box and a
//     running turn (the frame is emitted mid-turn from the box stream), so
//     the screen half is pinned at the unit layer instead — deliberately,
//     not by omission.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JsonValue } from "./schema.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";
import { retainForReplay } from "./sse-replay.ts";

describe("retainForReplay", () => {
  it("keeps a screen frame's sequence slot but not its picture", () => {
    const frame = 'id: deadbeef:42\ndata: {"kind":"screen","png":"aGVsbG8="}\n\n';
    const payload = { kind: "screen", botId: "bot-1", png: "aGVsbG8=", mime: "image/png", at: 7 };
    const slot = retainForReplay(42, "screen", frame, payload);
    // the slot keeps its sequence number — resume-gap detection stays honest
    expect(slot.seq).toBe(42);
    expect(slot.kind).toBe("screen");
    // null makes the replay loop skip it; the client hydrates that gap the
    // same way it does a frame it declined with ?screens=off
    expect(slot.frame).toBeNull();
    // identity survives so visibleToClient can still filter the slot
    expect(slot.payload).toEqual({ kind: "screen", botId: "bot-1", at: 7 });
    expect(slot.payload).not.toHaveProperty("png");
    expect(slot.payload).not.toHaveProperty("mime");
  });

  it("keeps every other kind verbatim — same frame, same payload reference", () => {
    const frame = "id: deadbeef:7\ndata: {\"kind\":\"bot\"}\n\n";
    const payload = { kind: "bot", bot: { id: "bot-1", name: "Ada" } };
    const slot = retainForReplay(7, "bot", frame, payload);
    expect(slot.seq).toBe(7);
    expect(slot.kind).toBe("bot");
    expect(slot.frame).toBe(frame);
    // identity, not equality: the broadcast hot path must not clone payloads
    expect(slot.payload).toBe(payload);
    expect(slot.frame).toBe(frame);
  });

  it("decides by kind, not by whether a picture happens to be there", () => {
    // a screen frame whose payload is already slim still becomes a
    // slot-only entry — the ring's rule is keyed on the kind alone, so the
    // retention decision can't drift per call site
    const slot = retainForReplay(9, "screen", "frame", { kind: "screen", botId: "bot-2" });
    expect(slot.seq).toBe(9);
    expect(slot.frame).toBeNull();
    expect(slot.payload).toEqual({ kind: "screen", botId: "bot-2" });
  });
});

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("resumed stream over the shaped ring", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: JsonValue): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  /** any request that makes the server broadcast exactly one frame */
  const nudge = async (botId: string) => {
    const res = await api("PATCH", `/api/bots/${botId}`, { unread: true });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-sse-replay-test-"));
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
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("replays exactly what a disconnected client missed, in order", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const botId = created.body.bot.id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((f) => f.kind === "hello");
    await nudge(botId);
    const seen = await first.until((f) => f.kind === "bot");
    first.close();

    // ...two things happen while the client is away...
    await nudge(botId);
    await nudge(botId);

    const cursor = `${hello.cursor.split(":")[0]}:${seen.seq}`;
    const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      const back = await resumed.until((f) => f.kind === "hello");
      // true — the ring still reaches back to this cursor, so no hydrate
      expect(back.resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot" && f.seq === seen.seq + 2);
      const replayed = resumed.frames.filter((f) => f.kind === "bot").map((f) => f.seq);
      // in order, nothing replayed twice, nothing skipped across the gap
      expect(replayed).toEqual([seen.seq + 1, seen.seq + 2]);
      // the shaped ring stores no screen pictures, so none can leak back
      expect(resumed.frames.some((f) => f.kind === "screen")).toBe(false);
    } finally {
      resumed.close();
    }
  });
});
