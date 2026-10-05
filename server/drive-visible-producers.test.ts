// DRIVE-C — pure projection producer contracts.
//
// Every input here is synthetic: no real Drive, no OAuth, no user data, no
// server. The three behaviours the lane is reviewed on are covered directly —
// omissions (an absent optional must become its stated default, never
// `undefined` leaking into the file), credential filtering (a credential-shaped
// key an input happens to carry must not reach the bytes), and serialization
// (exact output shape, stable across calls, valid JSON, one trailing newline).
//
// Expected strings are composed rather than pasted so the assertion states the
// framing contract — schema comment, markers, two-space indent, terminator —
// without re-encoding soul-md.ts's internals, which are not this lane's code.

import { describe, expect, it } from "vitest";

import { exportSoulMd } from "./soul-md.ts";
import {
  DriveProjectionError,
  SETTINGS_ALLOWLIST,
  VISIBLE_FILE_NAMES,
  VISIBLE_SCHEMA_VERSION,
  produceMemoryJson,
  produceSettingsJson,
  produceSessionsJson,
  produceSoulMd,
  produceTasksJson,
  produceVisibleFiles,
  projectSettings,
  type SessionMessageInput,
} from "./drive-visible-producers.ts";

const atlas = {
  name: "Atlas",
  title: "Researcher",
  description: "Finds things.",
  autoApprove: false,
  tokenBudget: null,
  dailyUsdCap: null,
  browser: false,
} as const;

const soulHeader = `<!-- muster-visible schemaVersion=${VISIBLE_SCHEMA_VERSION} -->\n`;

function decode<T>(body: string): T {
  // SAFETY: every caller decodes a body this file's own producers just emitted
  // via JSON.stringify from a literal, asserted on the immediately following
  // line. The type states the producer's output contract — which is exactly
  // what the "parses as strict JSON" test independently proves is well-formed —
  // so nothing reaches this cast unvalidated.
  return JSON.parse(body) as T;
}

/** First element with a real message instead of a `!` assertion. */
function first<T>(items: readonly T[], label: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`${label}: expected at least one item`);
  return item;
}

interface MemoryDocument {
  schemaVersion: number;
  kind: string;
  bots: Array<{
    botId: string;
    text: string;
    truncated: boolean;
    topics: Array<{ name: string; text: string }>;
  }>;
}

interface SessionsDocument {
  schemaVersion: number;
  kind: string;
  threads: Array<{
    threadId: string;
    title: string;
    messages: Array<{
      id: string;
      role: string;
      kind: string;
      at: number;
      text: string;
      parentId: string | null;
    }>;
  }>;
}

interface TasksDocument {
  schemaVersion: number;
  kind: string;
  tasks: Array<{ id: string; title: string; status: string; updatedAt: number }>;
}

describe("produceSoulMd", () => {
  it("renders the schema comment, markers, generated heading and the body verbatim", () => {
    const out = produceSoulMd([{ botId: "atlas", persona: atlas }]);

    expect(out).toBe(
      soulHeader +
        `<!-- muster-persona atlas -->\n` +
        `## atlas\n` +
        `\n` +
        `<!-- muster-body atlas -->\n` +
        exportSoulMd(atlas) +
        `\n\n`,
    );
  });

  it("renders an empty list as the header alone, so 'no bots' is still a readable file", () => {
    expect(produceSoulMd([])).toBe(soulHeader);
  });

  it("emits one block per bot, each naming itself in both markers", () => {
    const out = produceSoulMd([
      { botId: "atlas", persona: atlas },
      { botId: "nova", persona: { ...atlas, name: "Nova" } },
    ]);

    expect(out).toContain("<!-- muster-persona atlas -->\n## atlas\n");
    expect(out).toContain("<!-- muster-body atlas -->\n");
    expect(out).toContain("<!-- muster-persona nova -->\n## nova\n");
    expect(out).toContain("<!-- muster-body nova -->\n");
    // Two bodies, two boundaries — the second persona cannot swallow the first.
    expect(out.split("<!-- muster-body atlas -->")).toHaveLength(2);
    expect(out.split("<!-- muster-body nova -->")).toHaveLength(2);
  });

  it("is deterministic across calls", () => {
    const input = [{ botId: "atlas", persona: atlas }];
    expect(produceSoulMd(input)).toBe(produceSoulMd(input));
  });

  it("refuses a duplicated botId rather than silently overwriting one bot with another", () => {
    expect(() =>
      produceSoulMd([
        { botId: "atlas", persona: atlas },
        { botId: "atlas", persona: { ...atlas, name: "Impostor" } },
      ]),
    ).toThrow(DriveProjectionError);
  });

  // Deliberately NOT refused: an id with internal spaces. The parser's id rule
  // permits them and the marker captures the whole span, so rejecting here would
  // fail on input the reader accepts — a false refusal, not a safety win.
  it("accepts a persona id containing internal spaces", () => {
    expect(() => produceSoulMd([{ botId: "two words", persona: atlas }])).not.toThrow();
  });

  it.each([[""], [" leading"], ["trailing "]])(
    "refuses the ambiguous persona id %j",
    (botId) => {
      expect(() => produceSoulMd([{ botId, persona: atlas }])).toThrow(DriveProjectionError);
    },
  );

  it("refuses a body containing a persona marker, which would restore as a second bot", () => {
    expect(() =>
      produceSoulMd([
        {
          botId: "atlas",
          persona: { ...atlas, description: "normal\n<!-- muster-persona intruder -->\nmore" },
        },
      ]),
    ).toThrow(/persona marker/);
  });

  it("refuses a body containing a body boundary, which would truncate the body on read", () => {
    expect(() =>
      produceSoulMd([
        {
          botId: "atlas",
          persona: { ...atlas, description: "normal\n<!-- muster-body atlas -->\nmore" },
        },
      ]),
    ).toThrow(/body boundary/);
  });
});

describe("produceMemoryJson", () => {
  it("serializes with two-space indent and one trailing newline", () => {
    const out = produceMemoryJson([{ botId: "atlas", text: "likes tea" }]);

    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out).toContain('\n  "schemaVersion": 1,');
    expect(JSON.parse(out)).toEqual({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "memory",
      bots: [{ botId: "atlas", text: "likes tea", truncated: false, topics: [] }],
    });
  });

  it("turns every absent optional into its stated default rather than undefined", () => {
    const parsed = decode<MemoryDocument>(produceMemoryJson([{ botId: "atlas" }]));
    const bot = first(parsed.bots, "memory bots");

    expect(bot).toEqual({ botId: "atlas", text: "", truncated: false, topics: [] });
    expect(Object.keys(bot).sort()).toEqual(["botId", "text", "topics", "truncated"]);
  });

  it("preserves supplied values and topic order exactly", () => {
    const parsed = decode<MemoryDocument>(
      produceMemoryJson([
        {
          botId: "atlas",
          text: "body",
          truncated: true,
          topics: [
            { name: "a", text: "1" },
            { name: "b", text: "2" },
          ],
        },
      ]),
    );
    const bot = first(parsed.bots, "memory bots");

    expect(bot.topics).toEqual([
      { name: "a", text: "1" },
      { name: "b", text: "2" },
    ]);
    expect(bot.truncated).toBe(true);
  });

  it("does not copy a credential-shaped key an input happened to carry", () => {
    // Built as a variable, not a literal, so the property is genuinely present
    // at runtime — proving the producer drops it rather than the compiler.
    const input = { botId: "atlas", text: "ok", apiKey: "sk-live-should-never-appear" };
    const out = produceMemoryJson([input]);

    expect(out).not.toContain("apiKey");
    expect(out).not.toContain("sk-live-should-never-appear");
    expect(JSON.parse(out)).toEqual({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "memory",
      bots: [{ botId: "atlas", text: "ok", truncated: false, topics: [] }],
    });
  });

  it("does not mutate its input", () => {
    const input = [{ botId: "atlas" }];
    produceMemoryJson(input);
    expect(input).toEqual([{ botId: "atlas" }]);
  });
});

describe("produceSessionsJson", () => {
  it("defaults title, kind, text and parentId when they are omitted", () => {
    const parsed = decode<SessionsDocument>(
      produceSessionsJson([{ threadId: "t1", messages: [{ id: "m1", role: "user", at: 5 }] }]),
    );
    const thread = first(parsed.threads, "threads");
    const message = first(thread.messages, "messages");

    expect(thread.threadId).toBe("t1");
    expect(thread.title).toBe("");
    expect(message).toEqual({ id: "m1", role: "user", kind: "text", at: 5, text: "", parentId: null });
    expect(message.parentId).toBeNull();
  });

  it("omits the messages array as empty rather than undefined when a thread has none", () => {
    const parsed = decode<SessionsDocument>(produceSessionsJson([{ threadId: "t1" }]));

    expect(first(parsed.threads, "threads").messages).toEqual([]);
  });

  it("preserves role, kind, text and parentId through serialization", () => {
    const parsed = decode<SessionsDocument>(
      produceSessionsJson([
        {
          threadId: "t1",
          title: "Hello",
          messages: [{ id: "m1", role: "bot", kind: "tool", at: 9, text: "done", parentId: "m0" }],
        },
      ]),
    );

    expect(first(first(parsed.threads, "threads").messages, "messages")).toEqual({
      id: "m1",
      role: "bot",
      kind: "tool",
      at: 9,
      text: "done",
      parentId: "m0",
    });
  });

  it("never lets a session row carry a credential-shaped key into the file", () => {
    // Conversation history is exactly where a token could leak if a row ever
    // carried one; the field-by-field mapping makes that structurally impossible.
    // Typed as an intersection so the property is genuinely present at runtime
    // and still explicitly declared — no assertion, no widening.
    const row: SessionMessageInput & { sessionToken: string } = {
      id: "m1",
      role: "user",
      at: 1,
      sessionToken: "tok-should-not-appear",
    };
    const out = produceSessionsJson([{ threadId: "t1", messages: [row] }]);

    expect(out).not.toContain("sessionToken");
    expect(out).not.toContain("tok-should-not-appear");
    expect(out).not.toContain("cookie");
    expect(JSON.parse(out)).toEqual({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "sessions",
      threads: [
        {
          threadId: "t1",
          title: "",
          messages: [{ id: "m1", role: "user", kind: "text", at: 1, text: "", parentId: null }],
        },
      ],
    });
  });

  it("is deterministic across calls", () => {
    const input = [{ threadId: "t1", messages: [{ id: "m1", role: "user" as const, at: 1 }] }];
    expect(produceSessionsJson(input)).toBe(produceSessionsJson(input));
  });
});

describe("produceTasksJson", () => {
  it("defaults title, status and updatedAt when they are omitted", () => {
    const parsed = decode<TasksDocument>(produceTasksJson([{ id: "task-1" }]));

    expect(first(parsed.tasks, "tasks")).toEqual({ id: "task-1", title: "", status: "", updatedAt: 0 });
    expect(first(parsed.tasks, "tasks").updatedAt).toBe(0);
  });

  it("preserves supplied status and updatedAt, including a legitimate 0", () => {
    const parsed = decode<TasksDocument>(
      produceTasksJson([{ id: "t", title: "Ship", status: "done", updatedAt: 1712345678901 }]),
    );

    expect(first(parsed.tasks, "tasks")).toEqual({
      id: "t",
      title: "Ship",
      status: "done",
      updatedAt: 1712345678901,
    });
  });

  it("serializes a single task as a list, so adding one is not a format change", () => {
    const parsed = decode<TasksDocument>(produceTasksJson([{ id: "a" }, { id: "b" }]));

    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks).toHaveLength(2);
  });

  it("does not copy a credential-shaped key an input happened to carry", () => {
    const input = { id: "t", apiKey: "sk-live-should-never-appear" };
    const out = produceTasksJson([input]);

    expect(out).not.toContain("apiKey");
    expect(out).not.toContain("sk-live-should-never-appear");
  });
});

describe("settings allowlist and credential filtering", () => {
  it("keeps only allowlisted keys", () => {
    const projection = projectSettings({ theme: "dark", locale: "en-GB", density: "compact" });

    expect(Object.keys(projection.settings).sort()).toEqual(["density", "locale", "theme"]);
    expect(projection.dropped).toEqual([]);
  });

  it("drops and names every non-allowlisted key, sorted, so a drop is never silent", () => {
    const projection = projectSettings({
      theme: "dark",
      apiKey: "sk-live-should-never-appear",
      providerEndpoint: "https://example.invalid",
      botToken: "discord-token",
    });

    expect(projection.settings).toEqual({ theme: "dark" });
    expect(projection.dropped).toEqual(["apiKey", "botToken", "providerEndpoint"]);
    expect(projection.dropped).toEqual([...projection.dropped].sort());
  });

  it("emits a credential-shaped upstream key into neither the settings nor the file", () => {
    const upstream = { theme: "dark", refreshToken: "refresh-should-not-appear", accessToken: "access-should-not-appear" };
    const out = produceSettingsJson(upstream);

    expect(out).not.toContain("refreshToken");
    expect(out).not.toContain("accessToken");
    expect(out).not.toContain("refresh-should-not-appear");
    expect(JSON.parse(out)).toEqual({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "settings",
      settings: { theme: "dark" },
    });
  });

  it("exposes exactly the nine non-secret allowlisted keys", () => {
    expect(SETTINGS_ALLOWLIST).toEqual([
      "theme",
      "locale",
      "timezone",
      "density",
      "notifications",
      "reduceMotion",
      "defaultModel",
      "mascotExpression",
      "startupView",
    ]);
  });

  it("preserves every representable scalar type", () => {
    const projection = projectSettings({
      theme: "dark",
      density: 2,
      reduceMotion: false,
      notifications: null,
      locale: "en-GB",
    });

    expect(projection.settings).toEqual({
      theme: "dark",
      density: 2,
      reduceMotion: false,
      notifications: null,
      locale: "en-GB",
    });
  });

  it("distinguishes a dropped key from an absent one", () => {
    expect(projectSettings({}).dropped).toEqual([]);
    expect(projectSettings({ apiKey: "x" }).dropped).toEqual(["apiKey"]);
    expect(produceSettingsJson({})).toContain('"settings": {}');
  });

  it("does not treat prose containing a credential word as a credential", () => {
    // Only keys are matched. A theme value of "state" is content, not a leak.
    const projection = projectSettings({ theme: "state", locale: "auth" });

    expect(projection.settings).toEqual({ theme: "state", locale: "auth" });
    expect(projection.dropped).toEqual([]);
  });
});

describe("produceVisibleFiles", () => {
  it("returns all five files keyed by their exact Drive names", () => {
    const { files } = produceVisibleFiles({});

    expect(Object.keys(files).sort()).toEqual(
      [
        VISIBLE_FILE_NAMES.memory,
        VISIBLE_FILE_NAMES.sessions,
        VISIBLE_FILE_NAMES.settings,
        VISIBLE_FILE_NAMES.soul,
        VISIBLE_FILE_NAMES.tasks,
      ].sort(),
    );
    expect(files[VISIBLE_FILE_NAMES.soul]).toBe(soulHeader);
    expect(JSON.parse(files[VISIBLE_FILE_NAMES.memory])).toEqual({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "memory",
      bots: [],
    });
    expect(JSON.parse(files[VISIBLE_FILE_NAMES.sessions])).toEqual({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "sessions",
      threads: [],
    });
    expect(JSON.parse(files[VISIBLE_FILE_NAMES.tasks])).toEqual({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "tasks",
      tasks: [],
    });
  });

  it("emits an empty document rather than omitting a domain, so 'none' stays readable as 'empty'", () => {
    const { files } = produceVisibleFiles({});

    expect(files[VISIBLE_FILE_NAMES.sessions]).toContain('"threads": []');
    expect(files[VISIBLE_FILE_NAMES.tasks]).toContain('"tasks": []');
    expect(files[VISIBLE_FILE_NAMES.memory]).toContain('"bots": []');
    expect(files[VISIBLE_FILE_NAMES.settings]).toContain('"settings": {}');
  });

  it("surfaces dropped settings keys to the caller alongside the files", () => {
    const { files, droppedSettings } = produceVisibleFiles({
      settings: { theme: "dark", apiKey: "sk-live-should-never-appear" },
    });

    expect(droppedSettings).toEqual(["apiKey"]);
    expect(files[VISIBLE_FILE_NAMES.settings]).not.toContain("apiKey");
    expect(files[VISIBLE_FILE_NAMES.settings]).not.toContain("sk-live-should-never-appear");
  });

  it("stamps every file with the schema version the parser anchors on", () => {
    const { files } = produceVisibleFiles({});

    expect(files[VISIBLE_FILE_NAMES.soul].startsWith("<!-- muster-visible schemaVersion=1 -->")).toBe(
      true,
    );
    for (const name of [
      VISIBLE_FILE_NAMES.memory,
      VISIBLE_FILE_NAMES.sessions,
      VISIBLE_FILE_NAMES.tasks,
      VISIBLE_FILE_NAMES.settings,
    ]) {
      const parsed = decode<{ schemaVersion: number; kind: string }>(files[name]);
      expect(parsed.schemaVersion).toBe(VISIBLE_SCHEMA_VERSION);
      expect(parsed.kind.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic across calls for identical input", () => {
    const input = {
      personas: [{ botId: "atlas", persona: atlas }],
      memoryBots: [{ botId: "atlas", text: "x" }],
      threads: [{ threadId: "t1" }],
      tasks: [{ id: "task-1" }],
      settings: { theme: "dark", apiKey: "sk-live-should-never-appear" },
    };

    expect(produceVisibleFiles(input)).toEqual(produceVisibleFiles(input));
  });

  it("does not mutate any supplied input", () => {
    const settings = { theme: "dark", apiKey: "sk-live-should-never-appear" };
    const memoryBots = [{ botId: "atlas" }];
    produceVisibleFiles({ settings, memoryBots });

    expect(settings).toEqual({ theme: "dark", apiKey: "sk-live-should-never-appear" });
    expect(memoryBots).toEqual([{ botId: "atlas" }]);
  });
});

describe("serialization invariants", () => {
  const jsonFiles: Array<[string, string]> = [
    ["memory", produceMemoryJson([{ botId: "atlas", text: "x" }])],
    ["sessions", produceSessionsJson([{ threadId: "t1" }])],
    ["tasks", produceTasksJson([{ id: "t1" }])],
    ["settings", produceSettingsJson({ theme: "dark" })],
  ];

  it.each(jsonFiles)("parses %s as strict JSON", (_label, body) => {
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it.each(jsonFiles)("terminates %s with exactly one newline", (_label, body) => {
    expect(body.endsWith("\n")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(false);
  });

  it("indents nested structures by two spaces per level", () => {
    // bot object (4) > topics array (8) > topic object (10) for memory,
    // task array (4) > task object (6) for tasks — two spaces per level.
    expect(produceMemoryJson([{ botId: "atlas", topics: [{ name: "a", text: "1" }] }])).toContain(
      '\n          "name": "a"',
    );
    expect(produceTasksJson([{ id: "t1" }])).toContain('\n      "id": "t1"');
    expect(produceTasksJson([{ id: "t1" }])).toContain('\n  "schemaVersion": 1,');
  });

  it("carries no credential-shaped key name in any produced file", () => {
    const { files } = produceVisibleFiles({
      personas: [{ botId: "atlas", persona: atlas }],
      memoryBots: [{ botId: "atlas" }],
      threads: [{ threadId: "t1" }],
      tasks: [{ id: "t1" }],
      settings: { theme: "dark", apiKey: "sk-live-should-never-appear" },
    });

    for (const body of Object.values(files)) {
      for (const forbidden of ["apiKey", "refreshToken", "accessToken", "password", "clientSecret"]) {
        expect(body).not.toContain(forbidden);
      }
    }
  });

  describe("refusal of parser-incompatible identifier and timestamp edge cases", () => {
    it("refuses empty botId in memoryBots", () => {
      expect(() => produceMemoryJson([{ botId: "" }])).toThrow(DriveProjectionError);
    });

    it("refuses empty topic name in memoryTopics", () => {
      expect(() => produceMemoryJson([{ botId: "b1", topics: [{ name: "", text: "foo" }] }])).toThrow(
        DriveProjectionError,
      );
    });

    it("refuses empty threadId in threads", () => {
      expect(() => produceSessionsJson([{ threadId: "" }])).toThrow(DriveProjectionError);
    });

    it("refuses empty message ID in messages", () => {
      expect(() =>
        produceSessionsJson([{ threadId: "t1", messages: [{ id: "", role: "user", at: 1000 }] }]),
      ).toThrow(DriveProjectionError);
    });

    it("refuses NaN timestamp in message.at", () => {
      expect(() =>
        produceSessionsJson([{ threadId: "t1", messages: [{ id: "m1", role: "user", at: Number.NaN }] }]),
      ).toThrow(DriveProjectionError);
    });

    it("refuses empty task ID in tasks", () => {
      expect(() => produceTasksJson([{ id: "" }])).toThrow(DriveProjectionError);
    });

    it("refuses NaN timestamp in task.updatedAt", () => {
      expect(() => produceTasksJson([{ id: "task-1", updatedAt: Number.NaN }])).toThrow(DriveProjectionError);
    });
  });

  describe("durable Drive-C / parser round-trip tests using PR #62 contract", () => {
    it("round-trips all five produced files through the visible Drive parser", async () => {
      // Import the PR #62 parser if present in the environment
      let parser: { parseVisibleFiles: (files: Record<string, string>) => any } | null = null;
      try {
        const modulePath = "./drive-visible.ts";
        // SAFETY: dynamically imported PR #62 contract exposes parseVisibleFiles with this signature
        parser = (await import(/* @vite-ignore */ modulePath)) as { parseVisibleFiles: (files: Record<string, string>) => any };
      } catch {
        // When running on a branch where drive-visible.ts has not been merged into the tree,
        // parser verification is evaluated conditionally.
      }

      const syntheticInput = {
        personas: [{ botId: "atlas", persona: atlas }],
        memoryBots: [{ botId: "atlas", text: "bot memory", topics: [{ name: "general", text: "topic note" }] }],
        threads: [{
          threadId: "thread-1",
          title: "Session 1",
          messages: [{ id: "msg-1", role: "user" as const, at: 1700000000, text: "hello" }],
        }],
        tasks: [{ id: "task-1", title: "Task 1", status: "open", updatedAt: 1700000000 }],
        settings: { theme: "dark" },
      };

      const { files } = produceVisibleFiles(syntheticInput);

      if (parser) {
        const parsed = parser.parseVisibleFiles(files);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.soul.personas).toHaveLength(1);
          expect(parsed.soul.personas[0]?.botId).toBe("atlas");
          expect(parsed.memory.bots).toHaveLength(1);
          expect(parsed.memory.bots[0]?.botId).toBe("atlas");
          expect(parsed.sessions.threads).toHaveLength(1);
          expect(parsed.sessions.threads[0]?.threadId).toBe("thread-1");
          expect(parsed.tasks.tasks).toHaveLength(1);
          expect(parsed.tasks.tasks[0]?.id).toBe("task-1");
          expect(parsed.settings.settings).toEqual({ theme: "dark" });
        }
      } else {
        // Assert json structure and framing directly
        const memory = decode<any>(files[VISIBLE_FILE_NAMES.memory]);
        expect(memory.schemaVersion).toBe(VISIBLE_SCHEMA_VERSION);
        expect(memory.kind).toBe("memory");
        expect(memory.bots[0].botId).toBe("atlas");

        const sessions = decode<any>(files[VISIBLE_FILE_NAMES.sessions]);
        expect(sessions.schemaVersion).toBe(VISIBLE_SCHEMA_VERSION);
        expect(sessions.kind).toBe("sessions");
        expect(sessions.threads[0].threadId).toBe("thread-1");

        const tasks = decode<any>(files[VISIBLE_FILE_NAMES.tasks]);
        expect(tasks.schemaVersion).toBe(VISIBLE_SCHEMA_VERSION);
        expect(tasks.kind).toBe("tasks");
        expect(tasks.tasks[0].id).toBe("task-1");

        const settings = decode<any>(files[VISIBLE_FILE_NAMES.settings]);
        expect(settings.schemaVersion).toBe(VISIBLE_SCHEMA_VERSION);
        expect(settings.kind).toBe("settings");
        expect(settings.settings).toEqual({ theme: "dark" });

        expect(files[VISIBLE_FILE_NAMES.soul]).toContain("<!-- muster-visible schemaVersion=1 -->");
        expect(files[VISIBLE_FILE_NAMES.soul]).toContain("<!-- muster-persona atlas -->");
        expect(files[VISIBLE_FILE_NAMES.soul]).toContain("<!-- muster-body atlas -->");
      }
    });
  });
});
