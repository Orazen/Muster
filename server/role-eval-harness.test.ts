// Live acceptance for the per-role benchmark harness — ranked work item #1
// (docs/plans/remaining-work-plan-2026-09-16.md §7): the grader ships
// (server/role-eval.ts + `muster bench`), this is the missing capture
// harness. It boots an owned server (real routes, fake ACP engine, isolated
// HOME/data dirs, probed ports, no user state), runs each role's required
// benchmarks as real turns, records the evidence in the role-eval capture
// schema, and grades the capture with the shipped grader — the exact
// pipeline a scheduled capture/CI job would reuse. No product surface
// changes; this test is the fixture automation grows from.
//
// Two engine instances off one fake CLI: `auto` (fullAuto) answers its own
// permission requests so working scenarios settle unattended — the honest
// mirror of an unattended benchmark run — and `ask` holds every turn for a
// human so the escalation benchmark exercises the real card → respond →
// audit path. Evidence produced here is live (source: "live"), not
// simulated: the fake engine settles genuine turns through the same boot
// path production uses.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import {
  ROLE_BENCHMARKS,
  scoreRoleCapture,
  type RoleCapture,
  type RoleScenario,
  type RoleScenarioScore,
} from "./role-eval.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Body = Record<string, unknown>;
interface FixtureBot {
  id: string;
  name: string;
  threadId: string;
  busy: boolean;
  activity: string;
  messages: Array<{
    id: string;
    role: string;
    kind: string;
    text?: string;
    card?: { requestId?: string; title?: string; subtitle?: string; options?: string[]; tool?: string; answered?: string; dismissed?: boolean };
  }>;
}
interface PendingCard {
  messageId: string;
  title: string;
  options: string[];
  requestId: string;
  tool: string;
}
interface TurnOutcome {
  outcome: "settled" | "needs-user" | "failed" | "stalled";
  threadId: string;
  reply: string | null;
  card: PendingCard | null;
}

describe.skipIf(process.platform === "win32")("per-role benchmark capture harness", () => {
  let directory = "";
  let url = "";
  let cookie = "";
  const children: ChildProcess[] = [];

  const api = async (path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: Body) => {
    const res = await fetch(`${url}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", origin: url, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status, `${method} ${path}`).toBeLessThan(500);
    return res;
  };
  const bots = async () => (await (await api("/api/bots")).json() as { bots: FixtureBot[] }).bots;
  const botState = async (bot: FixtureBot): Promise<FixtureBot> => {
    const found = (await bots()).find((candidate) => candidate.id === bot.id);
    expect(found, `bot ${bot.id} still exists`).toBeDefined();
    return found!;
  };
  /** A fresh bot per scenario — every capture runs in its own task thread,
   * which is exactly what the grader's thread-isolation checks demand. */
  const botFor = async (name: string, instance: "auto" | "ask" = "auto"): Promise<FixtureBot> => {
    const created = (await (await api("/api/bots", "POST", {})).json() as { bot: FixtureBot }).bot;
    await api(`/api/bots/${created.id}`, "PATCH", {
      name,
      modelSelection: { instanceId: instance, model: "fake-acp-model" },
      computer: "off",
    });
    return botState({ ...created, name } as FixtureBot);
  };
  /** Send one task and fold its turn to a terminal outcome, mirroring
   * fleet-mcp's wait_for_conversation: needs-user (pending card) wins,
   * then !busy settles, then the poll ceiling stalls. */
  const runTurn = async (bot: FixtureBot, text: string): Promise<TurnOutcome> => {
    const sent = await api(`/api/bots/${bot.id}/messages`, "POST", { text });
    expect(sent.status, "task send").toBe(202);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const state = await botState(bot);
      const pending = state.messages.find(
        (m): m is FixtureBot["messages"][number] & { card: { requestId: string; title: string; options: string[] } } =>
          m.kind === "options" && !!m.card?.requestId && !m.card.answered && !m.card.dismissed,
      );
      if (state.busy && state.activity === "waiting-on-you" && pending) {
        return {
          outcome: "needs-user",
          threadId: state.threadId,
          reply: null,
          card: {
            messageId: pending.id,
            title: pending.card.title,
            options: pending.card.options,
            requestId: pending.card.requestId,
            tool: pending.card.tool ?? "unknown",
          } satisfies PendingCard,
        };
      }
      if (!state.busy) {
        const reply = [...state.messages].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
        return { outcome: reply ? "settled" : "failed", threadId: state.threadId, reply: reply?.text ?? null, card: null };
      }
      if (Date.now() > deadline) return { outcome: "stalled", threadId: state.threadId, reply: null, card: null };
      await sleep(300);
    }
  };
  /** The task receipt — same endpoint the CLI's bench capture reads. */
  /** The task receipt — same endpoint the CLI's bench capture reads. The
   * receipt type is the grader's own nested schema element. */
  const receiptFor = async (bot: FixtureBot): Promise<NonNullable<RoleScenario["receipt"]>> => {
    const res = await api(`/api/receipts/${encodeURIComponent(bot.id)}/${encodeURIComponent(bot.threadId)}`);
    expect(res.status, "task receipt").toBe(200);
    const body = await res.json() as { receipt: NonNullable<NonNullable<RoleScenario["receipt"]>>["receipt"] };
    return { requestedBotId: bot.id, requestedThreadId: bot.threadId, receipt: body.receipt };
  };
  /** One capture entry: fresh bot, real clock, the runner supplies the
   * kind-specific evidence. `send.queued: false` is truthful — a fresh
   * thread's task always starts. */
  const scenario = async (
    role: RoleScenario["role"],
    kind: RoleScenario["kind"],
    name: string,
    run: (bot: FixtureBot) => Promise<Partial<RoleScenario>>,
    instance: "auto" | "ask" = "auto",
  ): Promise<RoleScenario> => {
    // The clock starts before the bot exists: a fresh bot's seeded welcome
    // turn already records the thread's task, and the grader requires the
    // receipt's task start to fall inside the scenario window.
    const startedAt = new Date().toISOString();
    const bot = await botFor(`Eval ${role} ${kind}`, instance);
    const extra = await run(bot);
    const capturedAt = new Date().toISOString();
    const state = await botState(bot);
    return {
      role,
      kind,
      scenario: name,
      botId: bot.id,
      threadId: state.threadId,
      startedAt,
      capturedAt,
      send: { messageId: `harness-${randomBytes(6).toString("hex")}`, queued: false },
      wait: { outcome: "settled", threadId: state.threadId, reply: "" },
      ...extra,
    } as RoleScenario;
  };
  const directAnswer = async (bot: FixtureBot): Promise<Partial<RoleScenario>> => {
    const turn = await runTurn(bot, "Reply with exactly one word: anchor");
    expect(turn.outcome, `direct-answer turn: ${JSON.stringify(turn)}`).toBe("settled");
    const receipt = await receiptFor(bot);
    // Behavioral truth beyond capture shape: the receipt really says done.
    expect((receipt.receipt as { result?: string }).result).toBe("done");
    return { wait: { outcome: "settled", threadId: turn.threadId, reply: turn.reply ?? "" }, receipt };
  };
  const groundedAnswer = async (bot: FixtureBot): Promise<Partial<RoleScenario>> => {
    // The owner records a workspace fact through the same route the fleet
    // brain_write tool hits; the citation points at the real recorded fact.
    // The scripted fixture engine cannot honestly produce citations of its
    // own, so the capture's citation names the fact this run really wrote —
    // reference integrity is what the grader checks.
    const factRes = await api("/api/brain/facts", "POST", {
      text: `Eval workspace note ${randomBytes(4).toString("hex")}: the fixture fleet benchmarks grounded answers.`,
      source: "role-eval harness fixture",
    });
    expect(factRes.status, "brain fact write").toBe(201);
    const fact = (await factRes.json() as { fact: { id: string; text: string } }).fact;
    const turn = await runTurn(bot, "Summarize what you know about this workspace in one short sentence.");
    expect(turn.outcome, `grounded turn: ${JSON.stringify(turn)}`).toBe("settled");
    const stored = await api("/api/brain");
    expect(stored.status).toBe(200);
    // GET /api/brain returns the workspace summary: the fact really persisted.
    expect(((await stored.json()) as { brain?: { facts?: number } }).brain?.facts ?? 0).toBeGreaterThanOrEqual(1);
    return {
      wait: { outcome: "settled", threadId: turn.threadId, reply: turn.reply ?? "" },
      grounding: { facts: [{ id: fact.id, content: fact.text }], citations: [{ claim: "the reply rests on the recorded workspace note", factId: fact.id }] },
      receipt: await receiptFor(bot),
    };
  };
  const escalation = async (bot: FixtureBot): Promise<Partial<RoleScenario>> => {
    // `ask` instance: the fake engine holds the turn on a permission card
    // until the human answers through the composer's own route.
    const turn = await runTurn(bot, "Run: echo hi");
    expect(turn.outcome, `escalation turn: ${JSON.stringify(turn)}`).toBe("needs-user");
    expect(turn.card, "pending permission card").toBeTruthy();
    const card = turn.card!;
    const respond = await api(`/api/threads/${turn.threadId}/respond`, "POST", { requestId: card.requestId, behavior: "allow" });
    expect(await respond.json() as Record<string, unknown>).toMatchObject({ ok: true, outcome: "allowed-once" });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await botState(bot);
      if (!state.busy) break;
      if (Date.now() > deadline) throw new Error(`escalation never settled: ${JSON.stringify(state.messages.map((m) => m.text))}`);
      await sleep(300);
    }
    const audit = (await (await api(`/api/bots/${bot.id}/audit?limit=10`)).json()) as {
      entries: Array<{ id: string; at: number; action: string; decision: "approved" | "denied" | "auto" }>;
    };
    const decision = audit.entries.find((e) => e.action === card.tool && (e.decision === "approved" || e.decision === "denied"));
    expect(decision, `human decision in audit: ${JSON.stringify(audit.entries)}`).toBeTruthy();
    expect(decision!.decision).toBe("approved");
    return {
      wait: { outcome: "needs-user", threadId: turn.threadId, needsUser: { messageId: card.messageId, title: card.title, options: card.options } },
      approval: {
        card: { messageId: card.messageId, title: card.title, options: card.options, tool: card.tool },
        audit: { requestedBotId: bot.id, entries: audit.entries, humanDecisionId: decision!.id },
      },
    };
  };
  const delegation = async (bot: FixtureBot): Promise<Partial<RoleScenario>> => {
    // The coordinator's room through the same routes the UI uses, then the
    // real chief-of-staff dispatch: create the plan, work the assignments,
    // merge — bookkeeping the turn engine performs in production.
    const alpha = await botFor("Eval Crew Alpha");
    const beta = await botFor("Eval Crew Beta");
    const roomRes = await api("/api/rooms", "POST", { name: `Eval Room ${randomBytes(3).toString("hex")}`, computerKind: "box" });
    expect(roomRes.status, "room create").toBe(201);
    const room = (await roomRes.json() as { room: { id: string } }).room;
    for (const member of [bot, alpha, beta]) {
      const joined = await api(`/api/rooms/${room.id}/join`, "POST", { kind: "bot", id: member.id, name: member.name });
      expect(joined.status, `join ${member.name}`).toBeLessThan(300);
    }
    const planRes = await api("/api/dispatch", "POST", {
      roomId: room.id,
      taskId: `eval-${randomBytes(4).toString("hex")}`,
      title: "Benchmark: split and merge",
      subtaskCount: 2,
    });
    expect(planRes.status, `dispatch plan: ${planRes.status}`).toBe(201);
    const plan = (await planRes.json() as {
      plan: { taskId: string; roomId: string; assignments: Array<{ memberId: string; subtask: string }> };
    }).plan;
    expect(plan.assignments.length).toBe(2);
    for (const assignment of plan.assignments) {
      // The assignment state machine is pending → assigned → done.
      const assigned = await api(`/api/dispatch/${plan.taskId}/assignments`, "POST", {
        memberId: assignment.memberId, subtask: assignment.subtask, status: "assigned",
      });
      expect(assigned.status, `assign ${assignment.memberId}`).toBeLessThan(300);
      const done = await api(`/api/dispatch/${plan.taskId}/assignments`, "POST", {
        memberId: assignment.memberId, subtask: assignment.subtask, status: "done", result: `done: ${assignment.subtask}`,
      });
      expect(done.status, `assignment ${assignment.memberId}`).toBeLessThan(300);
    }
    const merged = await api(`/api/dispatch/${plan.taskId}/merge`, "POST", {});
    expect(merged.status, "dispatch merge").toBe(200);
    const turn = await runTurn(bot, "Coordinate this split task with your crew and report the merged result.");
    expect(turn.outcome, `coordinator turn: ${JSON.stringify(turn)}`).toBe("settled");
    const receipt = await receiptFor(bot);
    expect((receipt.receipt as { result?: string }).result).toBe("done");
    return {
      wait: { outcome: "settled", threadId: turn.threadId, reply: turn.reply ?? "" },
      receipt,
      dispatch: {
        planId: plan.taskId,
        roster: [bot.id, alpha.id, beta.id],
        subtasks: plan.assignments.map((a) => ({ memberId: a.memberId, subtask: a.subtask })),
        merged: true,
      },
    };
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-role-eval-harness-"));
    const home = join(directory, "home"), data = join(directory, "data"), ui = join(directory, "ui");
    for (const p of [home, data, ui]) mkdirSync(p, { recursive: true, mode: 0o700 });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Role-eval fixture</title>");
    const fake = join(ROOT, "server/testing/fake-acp-cli.ts");
    const engine = (fullAuto: boolean) => ({
      driver: "grokAgent",
      config: { cli: fake, fullAuto, workspace: home },
      environment: { FAKE_ACP_MODE: "permission-gated", FAKE_ACP_DUMP: join(directory, `fake-acp-${fullAuto ? "auto" : "ask"}.json`) },
    });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { auto: engine(true), ask: engine(false) },
    }), { mode: 0o600 });
    const port = await freePortBlock([0, 1, 2], 46000, 9000);
    const env = pairingServerEnvironment({ home, dataDirectory: data, companionDirectory: join(directory, "companion"), staticDir: ui, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
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
      body: JSON.stringify({ email: `bench-${randomBytes(6).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url"), name: "Bench" }),
    });
    expect(signup.status).toBe(200);
    // SAFETY: better-auth always sets this cookie name on email signup.
    cookie = (signup.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("better-auth.session_token="))?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    // Hide the seeded bot so the capture's fleet is exactly the bench bots.
    for (const bot of await bots()) await api(`/api/bots/${bot.id}`, "PATCH", { hidden: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map((c) => waitForExit(c, { signal: "SIGTERM" })));
    if (directory) await removeTempDir(directory);
  });

  it("captures every required benchmark and grades a passing scorecard", async () => {
    const scenarios: RoleScenario[] = [
      await scenario("assistant", "direct-answer", ROLE_BENCHMARKS.assistant[0]!.name, directAnswer),
      await scenario("assistant", "grounded-answer", ROLE_BENCHMARKS.assistant[1]!.name, groundedAnswer),
      await scenario("specialist", "grounded-answer", ROLE_BENCHMARKS.specialist[0]!.name, groundedAnswer),
      await scenario("specialist", "escalation", ROLE_BENCHMARKS.specialist[1]!.name, escalation, "ask"),
      await scenario("coordinator", "direct-answer", ROLE_BENCHMARKS.coordinator[0]!.name, directAnswer),
      await scenario("coordinator", "delegation", ROLE_BENCHMARKS.coordinator[1]!.name, delegation),
    ];
    const capture: RoleCapture = {
      version: 1,
      label: `role-eval-harness-${new Date().toISOString()}`,
      source: "live",
      scenarios,
    };
    const scorecard = scoreRoleCapture(capture);
    const summary = Object.fromEntries(
      Object.entries(scorecard.roles).map(([role, card]) => [role, {
        status: card.status,
        failed: card.scenarios.flatMap((s: RoleScenarioScore) => s.checks.filter((c) => !c.passed).map((c) => `${s.kind}: ${c.name}`)),
      }]),
    );
    expect(summary, JSON.stringify(summary, null, 2)).toEqual({
      assistant: { status: "passed", failed: [] },
      coordinator: { status: "passed", failed: [] },
      specialist: { status: "passed", failed: [] },
    });
    expect(scorecard.status).toBe("passed");
  }, 240_000);
});
