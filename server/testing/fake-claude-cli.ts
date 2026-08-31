#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt, mcpConfig} as JSON,
//                      so the test can assert on argv shape and env hygiene.
//                      mcpConfig is read back from the --mcp-config file the
//                      way the real CLI reads it — the driver writes it to a
//                      private temp file and deletes it when the turn settles,
//                      so a test cannot open it after the fact.
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key — what `auth status` reports
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

/** A stream-json frame: one JSON line of the CLI's stdout protocol. */
interface StreamJsonFrame {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string;
  event?: {
    type: string;
    delta?: { type?: string; thinking?: string; text?: string };
  };
  message?: {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; is_error?: boolean; tool_use_id?: string }>;
    usage?: Record<string, number>;
  };
  is_error?: boolean;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: Record<string, number>;
}

const out = (frame: StreamJsonFrame) => process.stdout.write(JSON.stringify(frame) + "\n");

// Snapshot probes: both answer on argv alone and exit without reading stdin.
if (argv[0] === "--version") {
  process.stdout.write("2.1.232 (Claude Code)\n");
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  const loggedIn = auth === "in" || (auth === "inherited-api-key" && Boolean(process.env.ANTHROPIC_API_KEY));
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }) + "\n",
    () => process.exit(auth === "out" ? 1 : 0),
  );
}

let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
  let prompt: JsonValue = null;
  try {
    prompt = JSON.parse(stdin.split("\n").find((l) => l.trim()) ?? "null");
  } catch {
    /* leave null — the test will see it */
  }

  if (process.env.FAKE_CLAUDE_DUMP) {
    const configPath = argAfter("--mcp-config");
    let mcpConfig = null;
    if (configPath) {
      try {
        mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        /* leave null — the test will see it */
      }
    }
    writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ argv, env: process.env, prompt, mcpConfig }, null, 2));
  }

  const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
  const model = argAfter("--model") ?? "claude-fake";

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }

  // First run exits with a transient upstream error; the marker file's
  // existence says a retry already happened, so this run succeeds.
  if (mode === "flaky") {
    const marker = process.env.FAKE_CLAUDE_FLAKY_FILE ?? "";
    if (!marker || !existsSync(marker)) {
      writeFileSync(marker, "attempted");
      process.stderr.write("API Error: 529 overloaded_error — the server is temporarily overloaded\n");
      process.exit(1);
    }
  }

  if (mode === "auth-error") {
    process.stderr.write("Invalid API key · please run /login\n");
    process.exit(1);
  }

  // Every run fails transiently — lets a test drive the retry cap to
  // exhaustion and assert the bounded number of attempts.
  if (mode === "always-overloaded") {
    process.stderr.write("API Error: 529 overloaded_error\n");
    process.exit(1);
  }

  out({ type: "system", subtype: "init", session_id: sessionId, model });

  if (mode === "die-after-delta") {
    // stream some text, THEN die transiently — the driver must not retry
    // an attempt whose partial output already reached the chat
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } });
    process.stderr.write("API Error: 529 overloaded_error\n");
    process.exit(1);
  }

  if (mode === "hang") {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    setInterval(() => {}, 1_000);
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  if (mode === "stream") {
    const delta = (d: NonNullable<NonNullable<StreamJsonFrame["event"]>["delta"]>) =>
      out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    // subagent narration — the driver must drop this, not render it
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello from fake claude" },
        { type: "tool_use", id: "tu-1", name: "Bash" },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } });
  process.exit(0);
});
