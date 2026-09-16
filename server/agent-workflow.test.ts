import { describe, expect, it } from "vitest";

import {
  AGENT_OPS,
  WEBAGENTS_SCHEMA,
  WORKFLOW_MAX_OPS,
  executeWorkflow,
  webagentsMarkdown,
  webagentsManifest,
  type WorkflowContext,
} from "./agent-workflow.ts";

const ctx: WorkflowContext = {
  health: () => ({ app: "muster" }),
  bots: () => [{ id: "b1", name: "Ranger", title: "Web Scout", busy: false }],
  tasks: (botId) => (botId === "b1" ? [{ threadId: "t1", title: "scout run", createdAt: 5 }] : null),
  receipt: (botId, threadId) => (botId === "b1" && threadId === "t1" ? { signed: true } : null),
  directory: () => ({ agents: [{ handle: "ranger" }] }),
};

describe("executeWorkflow", () => {
  it("rejects structural problems as a whole batch", () => {
    expect(executeWorkflow({}, ctx).status).toBe(400);
    expect(executeWorkflow({ ops: [] }, ctx).status).toBe(400);
    expect(executeWorkflow({ ops: Array.from({ length: WORKFLOW_MAX_OPS + 1 }, () => ({ id: "x", op: "health" })) }, ctx).status).toBe(400);
    expect(executeWorkflow({ ops: [{ id: "a", op: "health" }, { id: "a", op: "health" }] }, ctx).status).toBe(400);
  });

  it("runs ops in order and answers per-op, never one-for-all", () => {
    const { status, results } = executeWorkflow(
      {
        ops: [
          { id: "first", op: "health" },
          { id: "second", op: "no-such-op" },
          { id: "third", op: "bots.tasks", args: { botId: "missing" } },
          { id: "fourth", op: "bots.list" },
        ],
      },
      ctx,
    );
    expect(status).toBe(200);
    expect(results!.map((r) => r.id)).toEqual(["first", "second", "third", "fourth"]);
    expect(results![0]).toMatchObject({ ok: true, result: { app: "muster" } });
    expect(results![1]!.ok).toBe(false);
    expect(results![1]!.error).toMatch(/allowlist/);
    expect(results![2]!.ok).toBe(false);
    expect(results![2]!.error).toBe("no such bot");
    expect(results![3]!.ok).toBe(true);
  });

  it("validates args against the op schema at the boundary", () => {
    const { results } = executeWorkflow({ ops: [{ id: "a", op: "bots.tasks", args: { botId: 42 } }] }, ctx);
    expect(results![0]!.ok).toBe(false);
    expect(results![0]!.error).toMatch(/schema/);
    // strict: unknown keys are refused, not silently ignored
    const extra = executeWorkflow({ ops: [{ id: "a", op: "health", args: { sudo: true } }] }, ctx);
    expect(extra.results![0]!.ok).toBe(false);
  });

  it("caps every string arg and exposes only the allowlist", () => {
    expect(Object.keys(AGENT_OPS)).toEqual([
      "health",
      "bots.list",
      "bots.tasks",
      "receipt.get",
      "directory.agents",
    ]);
    const long = executeWorkflow({ ops: [{ id: "a", op: "bots.tasks", args: { botId: "x".repeat(200) } }] }, ctx);
    expect(long.results![0]!.ok).toBe(false);
  });
});

describe("discovery manifest", () => {
  it("markdown embeds the exact JSON the well-known route serves", () => {
    const manifest = webagentsManifest();
    const fenced = webagentsMarkdown().match(/```json\n([\s\S]*?)\n```/);
    expect(fenced).not.toBeNull();
    // the spec's own checker compares mirror equality — one source, no drift
    expect(JSON.parse(fenced![1]!)).toEqual(manifest);
  });

  it("declares the schema, the cap, and read-only honestly", () => {
    const manifest = webagentsManifest();
    expect(manifest.schema).toBe(WEBAGENTS_SCHEMA);
    const endpoint = manifest.endpoints[0]!;
    expect(endpoint.readOnly).toBe(true);
    expect(endpoint.maxOps).toBe(WORKFLOW_MAX_OPS);
    expect(endpoint.actions.map((a) => a.name)).toEqual(Object.keys(AGENT_OPS));
  });
});
