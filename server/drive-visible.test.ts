// Focused tests for the visible Drive projection contract.
//
// Everything runs against an injected fake Drive client: no network, no OAuth, no real Google
// account, no real Drive, no user data. Nothing here is real-Drive or device acceptance.

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_KEYS,
  PartialWriteError,
  splitSoulMarkdownDetailed,
  DriveVisibleError,
  FOLDER_MIME,
  VISIBLE_BACKUPS_DIR,
  VISIBLE_FILE_KEYS,
  VISIBLE_FILE_NAMES,
  VISIBLE_SCHEMA_VERSION,
  assertNoCredentialKeys,
  buildMemoryDocument,
  buildSessionsDocument,
  buildSettingsDocument,
  buildSoulDocument,
  buildTasksDocument,
  findOrCreateBackupsFolder,
  findOrCreateVisibleFolder,
  parseVisibleFile,
  parseVisibleFiles,
  projectSettings,
  renderSoulMarkdown,
  renderVisibleFiles,
  splitSoulMarkdown,
  writeVisibleFiles,
  type DriveFileRef,
  type DriveListArgs,
  type VisibleDriveClient,
  type VisibleDocuments,
} from "./drive-visible.js";

// ── A fake Drive ───────────────────────────────────────────────────────────────

interface FakeOptions {
  /** Fail the next `times` calls, to exercise the refusal paths. */
  failWith?: { status: number; message?: string; times?: number };
}

class FakeDrive implements VisibleDriveClient {
  private counter = 0;
  private files = new Map<string, DriveFileRef & { body: string }>();
  /** Counts writes, so "unchanged" can be proven not to churn revisions. */
  writes = 0;
  private failure: { status: number; message?: string; times: number } | undefined;
  /** Models Drive not returning a checksum, to test that we refuse rather than overwrite blind. */
  omitChecksums = false;
  /** Ids to delete when getFile is called, modelling a deletion between list and update. */
  raceDeleteOnGet = new Set<string>();

  constructor(options: FakeOptions = {}) {
    // `times` must default to 1: an unset value compared with `> 0` is false, the guard
    // would never fire, and a failure-path test would silently pass.
    this.failure = options.failWith ? { ...options.failWith, times: options.failWith.times ?? 1 } : undefined;
  }

  private guard(): void {
    if (this.failure && this.failure.times > 0) {
      this.failure.times -= 1;
      throw Object.assign(new Error(this.failure.message ?? "drive failure"), { code: this.failure.status });
    }
  }

  private add(name: string, parent: string, mimeType: string, body = ""): DriveFileRef & { body: string } {
    const id = `id-${++this.counter}`;
    const ref = { id, name, parents: [parent], mimeType, body };
    this.files.set(id, ref);
    return ref;
  }

  /** Seeds a folder, as happens after a manual copy in Drive. */
  seedFolder(name: string, parent: string, createdTime?: string, modifiedTime?: string): string {
    const ref = this.add(name, parent, FOLDER_MIME);
    const existing = this.files.get(ref.id);
    if (!existing) throw new Error("seed lost");
    this.files.set(ref.id, { ...existing, createdTime, modifiedTime });
    return ref.id;
  }

  /** Reverses listing order, to prove selection does not depend on it. */
  reverseListOrder(): void {
    this.files = new Map([...this.files.entries()].reverse());
  }

  async listFiles({ q }: DriveListArgs): Promise<DriveFileRef[]> {
    this.guard();
    const unescape = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    const nameMatch = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
    const parentMatch = /'((?:[^'\\]|\\.)*)' in parents/.exec(q);
    const wantedName = nameMatch ? unescape(nameMatch[1] ?? "") : null;
    const wantedParent = parentMatch ? unescape(parentMatch[1] ?? "") : null;
    const foldersOnly = q.includes(FOLDER_MIME);

    return [...this.files.values()]
      .filter((f) => (foldersOnly ? f.mimeType === FOLDER_MIME : true))
      .filter((f) => (wantedName ? f.name === wantedName : true))
      .filter((f) => (wantedParent ? f.parents.includes(wantedParent) : true))
      .map(({ id, name, parents, mimeType, createdTime, modifiedTime }) => ({
        id,
        name,
        parents,
        mimeType,
        createdTime,
        modifiedTime,
      }));
  }

  async createFolder(name: string, parentId: string): Promise<DriveFileRef> {
    this.guard();
    const { id, name: n, parents, mimeType } = this.add(name, parentId, FOLDER_MIME);
    return { id, name: n, parents, mimeType };
  }

  async createFile(name: string, parentId: string, body: string): Promise<DriveFileRef> {
    this.guard();
    const { id, name: n, parents, mimeType } = this.add(name, parentId, "text/plain", body);
    this.writes += 1;
    return { id, name: n, parents, mimeType };
  }

  async getFile(id: string): Promise<{ body: string; md5Checksum?: string }> {
    this.guard();
    const file = this.files.get(id);
    if (!file) throw Object.assign(new Error("not found"), { code: 404 });
    if (this.raceDeleteOnGet.delete(id)) {
      this.files.delete(id);
      throw Object.assign(new Error("not found"), { code: 404 });
    }
    return { body: file.body, md5Checksum: this.omitChecksums ? undefined : `sha-${hashOf(file.body)}` };
  }

  async updateFile(id: string, body: string, previousChecksum?: string): Promise<DriveFileRef> {
    this.guard();
    const file = this.files.get(id);
    if (!file) throw Object.assign(new Error("not found"), { code: 404 });
    // Drive rejects a stale precondition with 412; the fake does the same.
    if (previousChecksum && `sha-${hashOf(file.body)}` !== previousChecksum) {
      throw Object.assign(new Error("conditionNotMet"), { code: 412 });
    }
    file.body = body;
    this.writes += 1;
    return { id, name: file.name, parents: file.parents, mimeType: file.mimeType };
  }

  /** Simulates a file changing underneath us between list and update. */
  corrupt(id: string): void {
    const file = this.files.get(id);
    if (file) file.body = `${file.body}\n// edited elsewhere`;
  }
}

/** A content hash, so the fake cannot mistake a same-length edit for an unchanged file. */
function hashOf(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return `${h.toString(16)}-${text.length}`;
}

const documents = (): VisibleDocuments => ({
  soul: buildSoulDocument([{ botId: "bot-1", markdown: "# Soul\n\nI am Scout.\n\n## Voice\n\nTerse." }]),
  memory: buildMemoryDocument([
    { botId: "bot-1", text: "Prefers mornings", truncated: false, topics: [{ name: "work", text: "ship it" }] },
  ]),
  sessions: buildSessionsDocument([
    {
      threadId: "t-1",
      title: "Launch prep",
      messages: [{ id: "m-1", role: "user", kind: "text", at: 1724000000000, text: "hello", parentId: null }],
    },
  ]),
  tasks: buildTasksDocument([{ id: "task-1", title: "Ship", status: "open", updatedAt: 1724000000000 }]),
  settings: buildSettingsDocument(projectSettings({ theme: "dark", autosave: true }).settings),
});

// ── Contract: layout, versioning, round trip ───────────────────────────────────

describe("visible folder contract", () => {
  it("declares the ratified layout", () => {
    expect(VISIBLE_FILE_NAMES).toEqual({
      soul: "soul.md",
      memory: "memory.json",
      sessions: "sessions.json",
      tasks: "tasks.json",
      settings: "settings.json",
    });
    expect(VISIBLE_BACKUPS_DIR).toBe("backups");
  });

  it("stamps every live file with the schema version", () => {
    const files = renderVisibleFiles(documents());
    for (const key of VISIBLE_FILE_KEYS) {
      const body = files[VISIBLE_FILE_NAMES[key]];
      if (body === undefined) throw new Error(`missing ${key}`);
      if (key === "soul") expect(body).toContain(`schemaVersion=${VISIBLE_SCHEMA_VERSION}`);
      else expect(JSON.parse(body).schemaVersion).toBe(VISIBLE_SCHEMA_VERSION);
    }
  });

  it("round trips save and read without losing records", () => {
    const parsed = parseVisibleFiles(renderVisibleFiles(documents()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.soul.personas[0]?.botId).toBe("bot-1");
    expect(parsed.memory.bots[0]?.topics[0]?.name).toBe("work");
    expect(parsed.sessions.threads[0]?.messages[0]?.text).toBe("hello");
    expect(parsed.tasks.tasks[0]?.status).toBe("open");
  });

  it("keeps soul.md readable Markdown rather than JSON", () => {
    const body = renderVisibleFiles(documents())[VISIBLE_FILE_NAMES.soul] ?? "";
    expect(body).toContain("## bot-1");
    expect(body).toContain("I am Scout.");
    expect(() => JSON.parse(body)).toThrow();
  });

  it("round trips soul.md EXACTLY with internal headings, several bots and fenced code", () => {
    const original = buildSoulDocument([
      {
        botId: "bot-1",
        markdown: [
          "# Soul",
          "",
          "I am Scout.",
          "",
          "## Voice",
          "",
          "Terse.",
          "",
          "## Notes",
          "",
          "```md",
          "## this is code, not a persona",
          "```",
        ].join("\n"),
      },
      { botId: "bot-2", markdown: "Plain body, no headings." },
      { botId: "bot-3", markdown: "## starts with a heading" },
    ]);
    const body = renderSoulMarkdown(original);
    expect(splitSoulMarkdown(body)).toEqual(original.personas);

    // And through the whole-file path, not just the splitter.
    const files = renderVisibleFiles({ ...documents(), soul: original });
    const parsed = parseVisibleFiles(files);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.soul).toEqual(original);
  });

  it("does NOT turn an internal '## Voice' heading into an extra bot", () => {
    const one = buildSoulDocument([{ botId: "bot-1", markdown: "I am Scout.\n\n## Voice\n\nTerse." }]);
    const ids = splitSoulMarkdown(renderSoulMarkdown(one)).map((p) => p.botId);
    expect(ids).toEqual(["bot-1"]);
  });

  it("reports a malformed soul.md rather than inventing personas from headings", () => {
    // No marker at all: headings must NOT be read as personas.
    expect(splitSoulMarkdown("<!-- muster-visible schemaVersion=1 -->\n\n## bot-9\n\nbody\n")).toEqual([]);
    // Boundary with no body after it is a real, empty persona rather than a silent drop.
    expect(
      splitSoulMarkdown(
        "<!-- muster-visible schemaVersion=1 -->\n<!-- muster-persona bot-9 -->\n## bot-9\n\n" +
          "<!-- muster-body bot-9 -->\n",
      ),
    ).toEqual([{ botId: "bot-9", markdown: "" }]);
  });

  it("treats sessions.json as conversation history, not authentication state", () => {
    const parsed = parseVisibleFiles(renderVisibleFiles(documents()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.sessions).sort()).toEqual(["kind", "schemaVersion", "threads"]);
    expect(Object.keys(parsed.sessions.threads[0] ?? {}).sort()).toEqual(["messages", "threadId", "title"]);
  });
});

// ── soul.md data preservation (consolidated) ─────────────────────────────────

describe("soul.md preservation", () => {
  const boundary = (id: string): string => `<!-- muster-body ${id} -->`;

  it("round trips bodies byte for byte, including indentation and trailing whitespace", () => {
    const bodies = [
      { botId: "bot-1", markdown: "    four space indent\n\n  two spaces  " },
      { botId: "bot-2", markdown: "" },
      { botId: "bot-3", markdown: "keeps\n\n\n\nblank runs\n" },
      { botId: "bot-4", markdown: "```\n## fenced heading\n```\n\ntail" },
      { botId: "bot-5", markdown: "## Voice\n\nTerse." },
      { botId: "bot-6", markdown: "## bot-6 looks like a generated heading" },
    ];
    const original = buildSoulDocument(bodies);
    expect(splitSoulMarkdown(renderSoulMarkdown(original))).toEqual(bodies);
  });

  // ── the collision this block exists to close ────────────────────────────────
  it("keeps a genuine first body line that is exactly the heading it would have generated", () => {
    // Before the boundary marker this was indistinguishable from the generated heading: the parser
    // had to choose one of two answers. Now the boundary locates the content, so both survive.
    const bodies = [
      { botId: "bot-7", markdown: "## bot-7\n\nTerse." },
      { botId: "bot-8", markdown: "## bot-8" },
    ];
    const original = buildSoulDocument(bodies);
    expect(splitSoulMarkdown(renderSoulMarkdown(original))).toEqual(bodies);

    // And the same collision after a person deletes the decorative heading by hand.
    const handEdited =
      "<!-- muster-visible schemaVersion=1 -->\n" +
      "<!-- muster-persona bot-7 -->\n" +
      "<!-- muster-body bot-7 -->\n" +
      "## bot-7\n\nTerse.\n\n";
    expect(splitSoulMarkdown(handEdited)).toEqual([{ botId: "bot-7", markdown: "## bot-7\n\nTerse." }]);
  });

  it("keeps a genuine first heading after the decorative heading is deleted", () => {
    // Person deleted the decorative '## bot-1' line and its blank. The boundary still marks the
    // start of content, so '## Voice' is content rather than something to strip.
    const handEdited =
      "<!-- muster-visible schemaVersion=1 -->\n" +
      "<!-- muster-persona bot-1 -->\n" +
      "<!-- muster-body bot-1 -->\n" +
      "## Voice\n\nTerse.\n\n";
    expect(splitSoulMarkdown(handEdited)).toEqual([{ botId: "bot-1", markdown: "## Voice\n\nTerse." }]);

    // The blank left behind where the heading was sits BEFORE the boundary, so it is prelude and
    // changes nothing.
    const leftoverBlank = handEdited.replace(
      "<!-- muster-persona bot-1 -->\n",
      "<!-- muster-persona bot-1 -->\n\n",
    );
    expect(splitSoulMarkdown(leftoverBlank)).toEqual([{ botId: "bot-1", markdown: "## Voice\n\nTerse." }]);

    // A blank AFTER the boundary is the body's own leading blank line, and byte-exactness keeps it.
    const leadingBlank = handEdited.replace(
      "<!-- muster-body bot-1 -->\n",
      "<!-- muster-body bot-1 -->\n\n",
    );
    expect(splitSoulMarkdown(leadingBlank)).toEqual([{ botId: "bot-1", markdown: "\n## Voice\n\nTerse." }]);
  });

  it("reports a persona block whose boundary was removed instead of guessing", () => {
    // With the whole prelude gone there is genuinely no boundary left. Falling back to "strip
    // '## <own id>' if present" would pick one of two answers silently, so it is reported.
    const noBoundary =
      "<!-- muster-visible schemaVersion=1 -->\n<!-- muster-persona bot-1 -->\n## bot-1\n\nTerse.\n\n";
    expect(splitSoulMarkdownDetailed(noBoundary)).toMatchObject({
      personas: [],
      problems: [expect.stringContaining("no <!-- muster-body bot-1 --> boundary")],
    });
    expect(parseVisibleFile("soul", noBoundary)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("refusing to guess"),
    });
  });

  it("reports a boundary that names a different bot rather than absorbing what follows", () => {
    const copied =
      "<!-- muster-visible schemaVersion=1 -->\n" +
      "<!-- muster-persona bot-1 -->\n" +
      "## bot-1\n\n" +
      "<!-- muster-body bot-2 -->\n" +
      "Terse.\n\n";
    expect(splitSoulMarkdownDetailed(copied).problems).toEqual([
      expect.stringContaining("boundary naming bot-2"),
    ]);
  });

  it("refuses to render a body containing a literal persona marker or body boundary", () => {
    expect(() =>
      renderSoulMarkdown(
        buildSoulDocument([{ botId: "bot-1", markdown: "before\n<!-- muster-persona sneaky -->\nafter" }]),
      ),
    ).toThrowError(/reads as a persona marker/);
    expect(() =>
      renderSoulMarkdown(
        buildSoulDocument([{ botId: "bot-1", markdown: "before\n<!-- muster-body bot-1 -->\nafter" }]),
      ),
    ).toThrowError(/reads as a body boundary/);
  });

  it("rejects an invalid or duplicated persona id on both write and read", () => {
    expect(() => renderSoulMarkdown(buildSoulDocument([{ botId: "  ", markdown: "x" }]))).toThrowError(
      /invalid persona id/,
    );
    expect(() =>
      renderSoulMarkdown(
        buildSoulDocument([
          { botId: "bot-1", markdown: "a" },
          { botId: "bot-1", markdown: "b" },
        ]),
      ),
    ).toThrowError(/more than once/);

    const dup =
      "<!-- muster-visible schemaVersion=1 -->\n" +
      "<!-- muster-persona bot-1 -->\n## bot-1\n\n<!-- muster-body bot-1 -->\na\n\n" +
      "<!-- muster-persona bot-1 -->\n## bot-1\n\n<!-- muster-body bot-1 -->\nb\n\n";
    expect(parseVisibleFile("soul", dup)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("more than once"),
    });
  });

  it("rejects versioned non-empty content with no markers, but accepts an intentionally empty file", () => {
    expect(parseVisibleFile("soul", "<!-- muster-visible schemaVersion=1 -->\n\n## bot-1\n\nstray\n")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("malformed, not empty"),
    });
    const empty = parseVisibleFile("soul", "<!-- muster-visible schemaVersion=1 -->\n");
    expect(empty.ok).toBe(true);
  });

  it("exposes the boundary in the rendered file so the boundary is auditable by eye", () => {
    const rendered = renderSoulMarkdown(buildSoulDocument([{ botId: "bot-1", markdown: "Terse." }]));
    expect(rendered).toContain(boundary("bot-1"));
    expect(rendered.split("\n").filter((line) => line === boundary("bot-1"))).toHaveLength(1);
  });
});

// ── schema and settings boundaries (consolidated) ─────────────────────────────

describe("schema boundaries", () => {
  it("refuses a file whose kind does not match its name", () => {
    expect(
      parseVisibleFile("tasks", JSON.stringify({ schemaVersion: 1, kind: "memory", bots: [] })),
    ).toMatchObject({ ok: false });
  });

  it("strips an unknown key rather than letting it survive a round trip", () => {
    const raw = JSON.stringify({ schemaVersion: 1, kind: "tasks", tasks: [], surprise: "value" });
    const parsed = parseVisibleFile("tasks", raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.document)).not.toContain("surprise");
  });

  it("refuses settings carrying a credential on READ, not only on write", () => {
    const raw = JSON.stringify({ schemaVersion: 1, kind: "settings", settings: { theme: "dark", apiKey: "sk-x" } });
    expect(parseVisibleFile("settings", raw)).toMatchObject({ ok: false });
  });
});

// ── write and conflict behaviour (consolidated) ───────────────────────────────

describe("write and conflict behaviour", () => {
  it("refuses to overwrite when there is no revision evidence at all", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    await drive.createFile(VISIBLE_FILE_NAMES.tasks, folder.id, "stale");
    drive.omitChecksums = true;
    await expect(
      writeVisibleFiles(drive, folder.id, renderVisibleFiles(documents())),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows a caller to opt out of revision evidence explicitly", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    await drive.createFile(VISIBLE_FILE_NAMES.tasks, folder.id, "stale");
    drive.omitChecksums = true;
    const outcome = await writeVisibleFiles(drive, folder.id, renderVisibleFiles(documents()), {
      requireRevisionEvidence: false,
    });
    expect(outcome.wrote).toContain(VISIBLE_FILE_NAMES.tasks);
  });

  it("refuses to write a body that would not survive the reader", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    await expect(
      writeVisibleFiles(drive, folder.id, { [VISIBLE_FILE_NAMES.tasks]: "{\"kind\":\"soul\"}" }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(drive.writes).toBe(0);
  });

  it("reports how far a partial write got instead of failing opaquely", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const good = renderVisibleFiles(documents());
    const order = [VISIBLE_FILE_NAMES.soul, VISIBLE_FILE_NAMES.tasks];
    // Fail on the second file only.
    let seen = 0;
    const inner = drive.createFile.bind(drive);
    drive.createFile = async (name, parent, body) => {
      seen += 1;
      if (seen === 2) throw Object.assign(new Error("insufficientPermissions"), { code: 401 });
      return inner(name, parent, body);
    };
    const partial = { [order[0]!]: good[order[0]!], [order[1]!]: good[order[1]!] };
    const error = await writeVisibleFiles(drive, folder.id, partial).then(
      () => null,
      (reason: PartialWriteError) => reason,
    );
    expect(error).toBeInstanceOf(PartialWriteError);
    expect(error?.wrote).toEqual([VISIBLE_FILE_NAMES.soul]);
    expect(error?.code).toBe("consent_revoked");
  });

  it("preserves the written-file list when the adapter fails with an error it never mapped", async () => {
    // Not a DriveVisibleError: an adapter or transport fault the module does not recognise. It must
    // still report what was already written, or a caller cannot tell a partial write from one that
    // never started - and the original error must survive for diagnosis.
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const good = renderVisibleFiles(documents());
    const order = [VISIBLE_FILE_NAMES.soul, VISIBLE_FILE_NAMES.tasks];
    const original = new Error("socket hang up");
    let seen = 0;
    const inner = drive.createFile.bind(drive);
    drive.createFile = async (name, parent, body) => {
      seen += 1;
      if (seen === 2) throw original;
      return inner(name, parent, body);
    };
    const partial = { [order[0]!]: good[order[0]!], [order[1]!]: good[order[1]!] };
    const error = await writeVisibleFiles(drive, folder.id, partial).then(
      () => null,
      (reason: PartialWriteError) => reason,
    );
    expect(error).toBeInstanceOf(PartialWriteError);
    expect(error?.wrote).toEqual([VISIBLE_FILE_NAMES.soul]);
    expect(error?.code).toBe("transport_error");
    expect(error?.cause).toBe(original);
  });

  it("preserves the written-file list when the client rejects with a plain object", async () => {
    // Reviewer finding: the catch rethrew anything that was not an Error, so a plain-object rejection
    // after one successful write discarded the exact wrote list.
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const good = renderVisibleFiles(documents());
    const order = [VISIBLE_FILE_NAMES.soul, VISIBLE_FILE_NAMES.tasks];
    const thrown = { reason: "adapter gave up", status: 599 };
    let seen = 0;
    const inner = drive.createFile.bind(drive);
    drive.createFile = async (name, parent, body) => {
      seen += 1;
      if (seen === 2) throw thrown;
      return inner(name, parent, body);
    };
    const partial = { [order[0]!]: good[order[0]!], [order[1]!]: good[order[1]!] };
    const error = await writeVisibleFiles(drive, folder.id, partial).then(
      () => null,
      (reason: PartialWriteError) => reason,
    );
    expect(error).toBeInstanceOf(PartialWriteError);
    expect(error?.wrote).toEqual([VISIBLE_FILE_NAMES.soul]);
    expect(error?.code).toBe("transport_error");
    // The original value is kept verbatim, not merely described.
    expect(error?.thrown).toBe(thrown);
  });

  it("preserves the written-file list when the client rejects with a bare string", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const good = renderVisibleFiles(documents());
    const order = [VISIBLE_FILE_NAMES.soul, VISIBLE_FILE_NAMES.tasks];
    let seen = 0;
    const inner = drive.createFile.bind(drive);
    drive.createFile = async (name, parent, body) => {
      seen += 1;
      if (seen === 2) throw "socket hang up";
      return inner(name, parent, body);
    };
    const partial = { [order[0]!]: good[order[0]!], [order[1]!]: good[order[1]!] };
    const error = await writeVisibleFiles(drive, folder.id, partial).then(
      () => null,
      (reason: PartialWriteError) => reason,
    );
    expect(error).toBeInstanceOf(PartialWriteError);
    expect(error?.wrote).toEqual([VISIBLE_FILE_NAMES.soul]);
    expect(error?.thrown).toBe("socket hang up");
    expect(error?.cause.message).toMatch(/non-Error value/);
  });

  it("reports a deletion race as not_found rather than as success", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const target = await drive.createFile(VISIBLE_FILE_NAMES.tasks, folder.id, "old");
    drive.raceDeleteOnGet.add(target.id);
    await expect(
      writeVisibleFiles(drive, folder.id, renderVisibleFiles(documents())),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

// ── settings.json allowlist ────────────────────────────────────────────────────

// ── raw credential rejection (before schema stripping) ─────────────────────────

describe("raw credential rejection", () => {
  type TaskRecord = ReturnType<typeof buildTasksDocument>["tasks"][number];
  /** A nested JSON value for the depth fixtures; closed, so no open dictionary is needed. */
  type NestedJson = { nested: NestedJson } | { leaf: string } | { apiKey: string };
  type ThreadRecord = ReturnType<typeof buildSessionsDocument>["threads"][number];
  const sampleTask = { id: "task-1", title: "Ship", status: "open", updatedAt: 1724000000000 } as const;
  const tasksDoc = (): ReturnType<typeof buildTasksDocument> => buildTasksDocument([sampleTask]);
  const firstTask = (): TaskRecord => tasksDoc().tasks[0] ?? sampleTask;

  it("refuses a credential-shaped key at the top level instead of stripping it silently", () => {
    // The schema would strip this and validate cleanly, so a person who pasted a key into the file
    // would be told it was fine. It must be refused, and the reason must name the key.
    const raw = JSON.stringify({ ...tasksDoc(), apiKey: "sk-live-1" });
    expect(parseVisibleFile("tasks", raw)).toMatchObject({ ok: false, reason: expect.stringContaining("apiKey") });
  });

  it("refuses a credential-shaped key nested inside a record, which a top-level check would miss", () => {
    const raw = JSON.stringify({ ...tasksDoc(), tasks: [{ ...firstTask(), meta: { providerKey: "pk-1" } }] });
    expect(parseVisibleFile("tasks", raw)).toMatchObject({ ok: false, reason: expect.stringContaining("providerKey") });
  });

  it("refuses a credential-shaped key nested inside an array element", () => {
    const sessionsDoc = buildSessionsDocument([
      { threadId: "t-1", title: "Launch prep", messages: [{ id: "m-1", role: "user", kind: "text", at: 1724000000000, text: "hello", parentId: null }] },
    ]);
    const thread: ThreadRecord = sessionsDoc.threads[0] ?? { threadId: "t-1", title: "Launch prep", messages: [] };
    const raw = JSON.stringify({
      ...sessionsDoc,
      threads: [{ ...thread, messages: [{ id: "m", role: "user", kind: "text", at: 1, text: "hi", parentId: null, accessToken: "at-1" }] }],
    });
    expect(parseVisibleFile("sessions", raw)).toMatchObject({ ok: false, reason: expect.stringContaining("accessToken") });
  });

  it("does not treat ordinary prose that mentions a credential word as a credential", () => {
    const raw = JSON.stringify({ ...tasksDoc(), tasks: [{ ...firstTask(), title: "rotate the apiKey and reset the password" }] });
    expect(parseVisibleFile("tasks", raw).ok).toBe(true);
  });

  it("terminates on string values instead of recursing through their indices", () => {
    // A string has enumerable index keys, so a walk that treats "has keys" as "is a container"
    // recurses forever on a one-character string. This is a reproduced stack overflow, not a
    // hypothetical: an earlier version of the walk hung on ordinary text.
    const single = JSON.stringify({ ...tasksDoc(), tasks: [{ ...firstTask(), title: "x" }] });
    expect(parseVisibleFile("tasks", single).ok).toBe(true);

    // Deep nesting must terminate too.
    let deep: NestedJson = { leaf: "v" };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };
    expect(parseVisibleFile("tasks", JSON.stringify({ ...tasksDoc(), extra: deep })).ok).toBe(true);
  });

  it("finds a credential however deeply it is buried", () => {
    let deep: NestedJson = { apiKey: "sk-deep-1" };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    const raw = JSON.stringify({ ...tasksDoc(), blob: deep });
    expect(parseVisibleFile("tasks", raw)).toMatchObject({ ok: false, reason: expect.stringContaining("apiKey") });
  });

  it("keeps every documented schema field legal, so the gate cannot reject a valid document", () => {
    for (const key of VISIBLE_FILE_KEYS) {
      if (key === "soul") continue;
      expect(parseVisibleFile(key, JSON.stringify(documents()[key])).ok, `${key} must stay parseable`).toBe(true);
    }
  });

  it("refuses to RENDER a credential, not merely to write one", () => {
    // Reviewer finding: the writer refused credential fields, but the renderer serialised the
    // caller's object directly, so an extra apiKey was already in the produced bytes before any
    // write check ran. Refusing at the last moment is not the same as never producing it.
    const smuggled = { ...tasksDoc(), apiKey: "sk-render-1" };
    expect(() => renderVisibleFiles({ ...documents(), tasks: smuggled })).toThrowError(/credential-shaped keys/);

    // And a non-credential extra is dropped by projection rather than serialised through.
    const extra = { ...tasksDoc(), surprise: "value" };
    const rendered = renderVisibleFiles({ ...documents(), tasks: extra })[VISIBLE_FILE_NAMES.tasks] ?? "";
    expect(rendered).not.toContain("surprise");

    // Nested inside a record, the same way.
    const nested = { ...tasksDoc(), tasks: [{ ...(tasksDoc().tasks[0] ?? { id: "t", title: "x", status: "open", updatedAt: 1 }), providerKey: "pk-1" }] };
    expect(() => renderVisibleFiles({ ...documents(), tasks: nested })).toThrowError(/credential-shaped keys/);
  });

  it("cannot widen the settings allowlist by skipping projectSettings at render time", () => {
    const widened = { schemaVersion: VISIBLE_SCHEMA_VERSION, kind: "settings", settings: { theme: "dark", somethingElse: 1 } } as const;
    const rendered = renderVisibleFiles({ ...documents(), settings: widened })[VISIBLE_FILE_NAMES.settings] ?? "";
    expect(rendered).toContain("theme");
    expect(rendered).not.toContain("somethingElse");
  });

  it("cannot write bytes that retain a field validation discarded", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    // A hand-crafted body whose extra field the reader would strip. Writing it unchanged would put a
    // field on Drive that no read path agrees exists.
    await expect(
      writeVisibleFiles(drive, folder.id, {
        [VISIBLE_FILE_NAMES.tasks]: JSON.stringify({ ...tasksDoc(), apiKey: "sk-live-1" }),
      }),
    ).rejects.toMatchObject({ code: "credential_leak" });
    expect(drive.writes).toBe(0);

    // And the rendered form of a valid document carries no credential field at all.
    for (const body of Object.values(renderVisibleFiles(documents()))) {
      expect(body).not.toMatch(/apiKey|accessToken|password/i);
    }
  });
});

describe("settings allowlist", () => {
  it("keeps allowlisted keys", () => {
    const projected = projectSettings({ theme: "dark", locale: "en-GB" });
    expect(projected.settings).toEqual({ theme: "dark", locale: "en-GB" });
    expect(projected.dropped).toEqual([]);
  });

  it("drops a non-allowlisted key and NAMES it, so a drop is never silent", () => {
    const projected = projectSettings({ theme: "dark", somethingElse: 1, anotherThing: "x" });
    expect(projected.settings).toEqual({ theme: "dark" });
    expect(projected.dropped).toEqual(["anotherThing", "somethingElse"]);
  });

  it("refuses a credential outright rather than merely dropping it", () => {
    expect(() => projectSettings({ theme: "dark", refreshToken: "secret" })).toThrowError(/credential-shaped keys/);
  });

  it("drops a nested credential container and NAMES it, so it cannot pass silently", () => {
    // `providers` is not itself a credential key, so it is dropped rather than refused — but
    // it must be reported, and nothing from inside it may reach the rendered file.
    const projected = projectSettings({ theme: "dark", providers: "sk-x" });
    expect(projected.settings).toEqual({ theme: "dark" });
    expect(projected.dropped).toEqual(["providers"]);
    expect(JSON.stringify(projected.settings)).not.toContain("sk-x");
  });

  it("renders only the allowlisted keys it was actually given", () => {
    const body = JSON.stringify(buildSettingsDocument(projectSettings({ theme: "dark", locale: "en-GB" }).settings));
    expect(body).toContain("theme");
    expect(body).toContain("locale");
    expect(body).not.toContain("startupView"); // allowlisted, but not supplied
    expect(body).not.toContain("apiKey");
  });

  it("refuses a hand-edited settings.json carrying a credential or a non-allowlisted key", () => {
    const withCredential = JSON.stringify({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "settings",
      settings: { theme: "dark", refreshToken: "stolen" },
    });
    expect(parseVisibleFile("settings", withCredential)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("credential"),
    });

    const withStray = JSON.stringify({
      schemaVersion: VISIBLE_SCHEMA_VERSION,
      kind: "settings",
      settings: { theme: "dark", somethingElse: 1 },
    });
    expect(parseVisibleFile("settings", withStray)).toMatchObject({
      reason: expect.stringContaining("outside the allowlist"),
    });
  });
});

// ── Credential exclusion ───────────────────────────────────────────────────────

describe("credential exclusion", () => {
  it("refuses every declared credential-shaped key", () => {
    for (const key of CREDENTIAL_KEYS) {
      expect(() => assertNoCredentialKeys([key.toLowerCase()], "x.json")).toThrowError(/credential-shaped keys/);
    }
  });

  it("catches a credential key among many, not only a lone one", () => {
    expect(() => assertNoCredentialKeys(["id", "name", "createdAt", "refreshToken"], "x.json")).toThrowError(
      DriveVisibleError,
    );
  });

  it("does not treat ordinary prose containing the word state as a leak", () => {
    expect(() => assertNoCredentialKeys(["markdown"], "soul.md")).not.toThrow();
    const body = renderVisibleFiles(documents())[VISIBLE_FILE_NAMES.soul] ?? "";
    expect(body).toContain("I am Scout.");
  });

  it("blocks a write whose bytes would not survive the reader", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    await expect(
      writeVisibleFiles(drive, folder.id, { [VISIBLE_FILE_NAMES.tasks]: "{ not json" }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(drive.writes).toBe(0);
  });
});

// ── Folder discovery and idempotent creation ───────────────────────────────────

describe("folder discovery", () => {
  it("creates Muster/ on first use", async () => {
    const drive = new FakeDrive();
    const result = await findOrCreateVisibleFolder(drive);
    expect(result.created).toBe(true);
    expect(result.duplicates).toEqual([]);
  });

  it("adopts the existing folder on repeat onboarding instead of creating another", async () => {
    const drive = new FakeDrive();
    const first = await findOrCreateVisibleFolder(drive);
    const second = await findOrCreateVisibleFolder(drive);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("scopes discovery to the selected parent and ignores a same-named folder elsewhere", async () => {
    const drive = new FakeDrive();
    const nested = drive.seedFolder("Muster", "some-other-parent", "2020-01-01T00:00:00.000Z");
    const result = await findOrCreateVisibleFolder(drive, "root");
    // The older folder is under a different parent, so it must NOT be adopted.
    expect(result.id).not.toBe(nested);
    expect(result.created).toBe(true);
    expect(result.duplicates).toEqual([]);
  });

  it("adopts the OLDEST-CREATED duplicate and REPORTS the rest by exact id", async () => {
    const drive = new FakeDrive();
    const older = drive.seedFolder("Muster", "root", "2026-01-01T00:00:00.000Z");
    const newer = drive.seedFolder("Muster", "root", "2026-09-01T00:00:00.000Z");
    const result = await findOrCreateVisibleFolder(drive);
    expect(result.created).toBe(false);
    expect(result.id).toBe(older);
    expect(result.duplicates).toEqual([newer]);
  });

  it("selects by createdTime, not modifiedTime", async () => {
    const drive = new FakeDrive();
    // Older by creation, but edited most recently: createdTime must win.
    const olderCreated = drive.seedFolder(
      "Muster", "root", "2026-01-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z",
    );
    drive.seedFolder("Muster", "root", "2026-09-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    expect((await findOrCreateVisibleFolder(drive)).id).toBe(olderCreated);
  });

  it("chooses the same folder regardless of listing order", async () => {
    const forward = new FakeDrive();
    const a = forward.seedFolder("Muster", "root", "2026-01-01T00:00:00.000Z");
    const b = forward.seedFolder("Muster", "root", "2026-09-01T00:00:00.000Z");
    const first = await findOrCreateVisibleFolder(forward);

    const reversed = new FakeDrive();
    const a2 = reversed.seedFolder("Muster", "root", "2026-01-01T00:00:00.000Z");
    const b2 = reversed.seedFolder("Muster", "root", "2026-09-01T00:00:00.000Z");
    reversed.reverseListOrder();
    const second = await findOrCreateVisibleFolder(reversed);

    expect(first.id).toBe(second.id);
    expect(first.duplicates).toEqual(second.duplicates);
    expect([a, b]).toEqual([a2, b2]);
  });

  it("sorts unknown age LAST and breaks ties by id, so selection is total", async () => {
    const drive = new FakeDrive();
    const known = drive.seedFolder("Muster", "root", "2026-05-01T00:00:00.000Z");
    const unknown = drive.seedFolder("Muster", "root");
    expect((await findOrCreateVisibleFolder(drive)).id).toBe(known);
    expect((await findOrCreateVisibleFolder(drive)).duplicates).toEqual([unknown]);

    // Two folders with no createdTime: id ascending decides, not listing order.
    const tie = new FakeDrive();
    const first = tie.seedFolder("Muster", "root");
    const second = tie.seedFolder("Muster", "root");
    const expected = [first, second].sort();
    const picked = await findOrCreateVisibleFolder(tie);
    expect(picked.id).toBe(expected[0]);
    expect(picked.duplicates).toEqual([expected[1]]);
  });

  it("places backups/ under Muster/ and does not recreate it", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const first = await findOrCreateBackupsFolder(drive, folder.id);
    const second = await findOrCreateBackupsFolder(drive, folder.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  // This helper is the destination for the verified copy of muster-workspace-v2.enc, so which
  // folder it picks has to be a decision rather than a side effect of Drive's listing order.
  it("picks the same backups/ folder regardless of listing order, and reports the rest by id", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const older = drive.seedFolder("backups", folder.id, "2024-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const newer = drive.seedFolder("backups", folder.id, "2025-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
    const first = await findOrCreateBackupsFolder(drive, folder.id);
    const second = await findOrCreateBackupsFolder(drive, folder.id);
    // Older by CREATION wins even though it was edited most recently.
    expect(first.id).toBe(older);
    expect(second.id).toBe(older);
    expect(first.duplicates).toEqual([newer]);
  });

  it("sorts an unknown-age backups/ folder last rather than adopting it", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const dated = drive.seedFolder("backups", folder.id, "2024-01-01T00:00:00.000Z");
    const undated = drive.seedFolder("backups", folder.id);
    const chosen = await findOrCreateBackupsFolder(drive, folder.id);
    expect(chosen.id).toBe(dated);
    expect(chosen.duplicates).toEqual([undated]);
  });

  it("ignores a backups/ folder that lives outside Muster/", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const stranger = drive.seedFolder("backups", "root", "2020-01-01T00:00:00.000Z");
    const chosen = await findOrCreateBackupsFolder(drive, folder.id);
    expect(chosen.id).not.toBe(stranger);
    expect(chosen.created).toBe(true);
  });
});

// ── Failure modes and honest state ─────────────────────────────────────────────

describe("failure modes", () => {
  it("reports revoked consent distinctly from throttling", async () => {
    const revoked = new FakeDrive({ failWith: { status: 401, message: "insufficientPermissions" } });
    await expect(findOrCreateVisibleFolder(revoked)).rejects.toMatchObject({ code: "consent_revoked" });

    const throttled = new FakeDrive({ failWith: { status: 429, message: "rateLimitExceeded" } });
    await expect(findOrCreateVisibleFolder(throttled)).rejects.toMatchObject({ code: "throttled" });
  });

  it("surfaces a concurrent edit as a conflict rather than overwriting it", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const target = await drive.createFile(VISIBLE_FILE_NAMES.tasks, folder.id, "first");
    drive.corrupt(target.id);
    await expect(drive.updateFile(target.id, "second", "md5-wrong")).rejects.toMatchObject({ code: 412 });
  });

  it("refuses to guess when the same file name exists twice", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    await drive.createFile(VISIBLE_FILE_NAMES.tasks, folder.id, "a");
    await drive.createFile(VISIBLE_FILE_NAMES.tasks, folder.id, "b");
    await expect(writeVisibleFiles(drive, folder.id, renderVisibleFiles(documents()))).rejects.toMatchObject({
      code: "duplicate_folder",
    });
  });

  it("writes only what changed, so a no-op sync does not churn revisions", async () => {
    const drive = new FakeDrive();
    const folder = await findOrCreateVisibleFolder(drive);
    const files = renderVisibleFiles(documents());

    const first = await writeVisibleFiles(drive, folder.id, files);
    expect(first.wrote.sort()).toEqual(Object.values(VISIBLE_FILE_NAMES).sort());
    const afterFirst = drive.writes;

    const second = await writeVisibleFiles(drive, folder.id, files);
    expect(second.wrote).toEqual([]);
    expect(second.unchanged.sort()).toEqual(Object.values(VISIBLE_FILE_NAMES).sort());
    expect(drive.writes).toBe(afterFirst);
  });

  it("reports a corrupt file instead of treating it as restored", () => {
    const files = renderVisibleFiles(documents());
    files[VISIBLE_FILE_NAMES.tasks] = "{not json";
    expect(parseVisibleFiles(files)).toMatchObject({ ok: false, fileName: "tasks.json", reason: "invalid JSON" });
  });

  it("reports a missing file rather than silently restoring an empty workspace", () => {
    const files = renderVisibleFiles(documents());
    delete files[VISIBLE_FILE_NAMES.memory];
    expect(parseVisibleFiles(files)).toMatchObject({ ok: false, fileName: "memory.json" });
  });

  it("refuses a schema version newer than it understands instead of guessing", () => {
    const files = renderVisibleFiles(documents());
    files[VISIBLE_FILE_NAMES.tasks] = JSON.stringify({
      schemaVersion: VISIBLE_SCHEMA_VERSION + 1,
      kind: "tasks",
      tasks: [],
    });
    expect(parseVisibleFiles(files)).toMatchObject({ ok: false, reason: /newer than/ });
  });

  it("rejects a soul.md with no version marker rather than assuming one", () => {
    expect(parseVisibleFile("soul", "## bot-1\n\nno marker here\n")).toMatchObject({
      ok: false,
      reason: "missing schemaVersion marker",
    });
  });

  it("rejects a soul.md whose body mentions a version but whose top-level marker is absent", () => {
    // The regression the unanchored search allowed: prose alone used to satisfy the version check, so
    // deleting the header did not make the document unparseable.
    const raw =
      "<!-- muster-persona bot-1 -->\n## bot-1\n\nProse that reads schemaVersion=1 in passing.\n";
    expect(parseVisibleFile("soul", raw)).toMatchObject({
      ok: false,
      reason: "missing schemaVersion marker",
    });
  });

  it("accepts prose mentioning the version once a genuine marker opens the document", () => {
    // Built through the renderer so the document is the contract's own shape, boundary included: the
    // anchored header must reject impostors without rejecting real files that talk about versions.
    const rendered = renderSoulMarkdown(
      buildSoulDocument([{ botId: "bot-1", markdown: "Prose that reads schemaVersion=1 in passing." }]),
    );
    expect(rendered.startsWith("<!-- muster-visible schemaVersion=1 -->\n")).toBe(true);
    expect(parseVisibleFile("soul", rendered)).toMatchObject({
      ok: true,
      document: { schemaVersion: 1, kind: "soul" },
    });
  });
});
