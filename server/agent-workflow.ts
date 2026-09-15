// WebAgents-style discovery for Muster's own API (BetterWright/WebAgents
// v0.1 spec, MIT — concept ported, not vendored).
//
// The point of a site-published action manifest: an agent that finds
// /webagents.md can do one bounded batch call instead of many model round
// trips against the ordinary REST surface. Muster's bots drive this same
// API through engine loops, so the cheapest honest win is read-only
// composition: health, roster, task list, a receipt, the public directory.
//
// v1 is deliberately READ-ONLY. Every write stays behind the human
// approval cards — a batch endpoint that could send tasks would just be a
// faster way to do the thing Muster gates on purpose. The manifest says so
// in the open; `readOnly: true` is part of the contract, not a footnote.
//
// Security posture (mirrors the local-computer lifecycle routes): the
// POST requires content-type application/json, which makes it a
// non-simple cross-origin request; the server emits no CORS permission, so
// a hostile page cannot submit it. Under self-hosting it additionally sits
// behind the session gate; on desktop the loopback boundary is the
// credential, same as every other /api route.

import { z } from "zod";

export const WORKFLOW_MAX_OPS = 8;
export const WEBAGENTS_SCHEMA = "webagents/v0.1";

/** Everything the ops need, injected so the module stays store-free and
 * the whole surface is unit-testable with a fake. */
export interface WorkflowContext {
  health(): { app: string };
  bots(): Array<{ id: string; name: string; title: string; busy: boolean }>;
  /** null = no such bot for this session. */
  tasks(botId: string): Array<{ threadId: string; title: string; createdAt: number }> | null;
  /** null = no such task. */
  receipt(botId: string, threadId: string): unknown | null;
  directory(): unknown;
}

interface OpSpec {
  description: string;
  args: z.ZodType<Record<string, string>>;
  run: (ctx: WorkflowContext, args: Record<string, string>) => unknown;
}

const idArg = z.string().min(1).max(128);

export const AGENT_OPS: Record<string, OpSpec> = {
  "health": {
    description: "Liveness and version of this Muster deployment.",
    args: z.object({}).strict(),
    run: (ctx) => ctx.health(),
  },
  "bots.list": {
    description: "The signed-in user's teammates: id, name, title, busy.",
    args: z.object({}).strict(),
    run: (ctx) => ({ bots: ctx.bots() }),
  },
  "bots.tasks": {
    description: "Tasks (threads) of one teammate: threadId, title, createdAt.",
    args: z.object({ botId: idArg }).strict(),
    run: (ctx, { botId }) => {
      const tasks = ctx.tasks(botId);
      if (tasks === null) throw new Error("no such bot");
      return { tasks };
    },
  },
  "receipt.get": {
    description: "The signed job receipt for one finished task.",
    args: z.object({ botId: idArg, threadId: idArg }).strict(),
    run: (ctx, { botId, threadId }) => {
      const receipt = ctx.receipt(botId, threadId);
      if (receipt === null) throw new Error("no such task");
      return { receipt };
    },
  },
  "directory.agents": {
    description: "Public agent directory: profiles their owners chose to share.",
    args: z.object({}).strict(),
    run: (ctx) => ctx.directory(),
  },
};

const workflowSchema = z.object({
  ops: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        op: z.string(),
        args: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(WORKFLOW_MAX_OPS),
});

export interface WorkflowResult {
  id: string;
  op: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Validate + execute a bounded batch sequentially. Structural problems
 * (bad body, >8 ops, duplicate ids) reject the whole batch up front; a bad
 * or failing OP is answered per-op so one typo can't burn the other seven. */
export function executeWorkflow(body: unknown, ctx: WorkflowContext): {
  status: number;
  results?: WorkflowResult[];
  error?: string;
} {
  const parsed = workflowSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, error: `workflow must be { ops: [1..${WORKFLOW_MAX_OPS}] } with unique ids` };
  }
  const ids = new Set<string>();
  for (const op of parsed.data.ops) {
    if (ids.has(op.id)) return { status: 400, error: `duplicate op id: ${op.id}` };
    ids.add(op.id);
  }
  const results: WorkflowResult[] = [];
  for (const { id, op, args } of parsed.data.ops) {
    const spec = AGENT_OPS[op];
    if (!spec) {
      results.push({ id, op, ok: false, error: `unknown op "${op}" — see /webagents.md for the allowlist` });
      continue;
    }
    const validated = spec.args.safeParse(args ?? {});
    if (!validated.success) {
      results.push({ id, op, ok: false, error: "args did not match the op's schema" });
      continue;
    }
    try {
      results.push({ id, op, ok: true, result: spec.run(ctx, validated.data) });
    } catch (error) {
      results.push({ id, op, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { status: 200, results };
}

/** The machine-readable manifest. The markdown page embeds this exact
 * object in one fenced JSON block — the spec's own checker compares the
 * two, so they are generated from one source and can't drift. */
export function webagentsManifest() {
  return {
    schema: WEBAGENTS_SCHEMA,
    name: "Muster",
    description:
      "A local-first AI-agent workforce. This deployment publishes a bounded, read-only batch endpoint so agents can gather context in one call instead of many round trips.",
    endpoints: [
      {
        id: "workflow",
        method: "POST",
        path: "/api/agent/workflow",
        contentType: "application/json",
        auth: "session cookie (self-hosted); loopback-only (desktop)",
        maxOps: WORKFLOW_MAX_OPS,
        ordering: "sequential",
        readOnly: true,
        actions: Object.entries(AGENT_OPS).map(([name, spec]) => ({
          name,
          description: spec.description,
        })),
      },
    ],
    notes:
      "v1 is read-only by design: every write stays behind Muster's human approval cards. Falls back to ordinary browsing of /api and /skill.md when a caller prefers per-endpoint calls.",
  };
}

export function webagentsMarkdown(): string {
  return `# webagents.md

This Muster deployment publishes an agent action manifest. The machine-
readable form is the fenced JSON block below; the same object is served at
\`/.well-known/webagents.json\`.

\`\`\`json
${JSON.stringify(webagentsManifest(), null, 2)}
\`\`\`

Send \`{"ops":[{"id":"a","op":"bots.list"}]}\` to \`/api/agent/workflow\`
with \`content-type: application/json\`. Ops run in order, results come back
in the same order, and a failing op never cancels the others.
`;
}
