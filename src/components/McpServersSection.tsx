// MCP Servers settings section: register your own stdio MCP servers and
// hand them to every bot, or just the ones you pick. A server is a command
// on this computer with args and env; "Test" spawns it exactly as a turn
// would and lists the tools it answers with.
//
// Secrets never reach the browser: the server's env arrives with every
// value replaced by `true`, and sending `true` back means "keep the stored
// one". The form shows `KEY=true`; leave it as-is to keep a secret.
import { useEffect, useState } from "react";
import { Pencil, PlayCircle, Plus, Trash2 } from "lucide-react";

import { api, useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

/** Server as the API returns it: env values are redacted booleans. */
export interface McpServerWire {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** true = this variable is set server-side; the value stays there. */
  env: Record<string, boolean>;
  enabled: boolean;
  bots?: string[];
}

/** One arg per line — args may legitimately contain spaces, so a single
 * space-split input would corrupt them. Blank lines are dropped. */
export function parseArgLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** KEY=value lines into an env object. Everything after the first `=` is the
 * value; lines that name no variable are ignored rather than saved empty. */
export function parseEnvLines(text: string) {
  const entries: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    entries.push([key, trimmed.slice(eq + 1)]);
  }
  return Object.fromEntries(entries);
}

/** Env form text → wire shape: a redacted key left reading exactly `true`
 * (or emptied) keeps its stored value instead of overwriting it. */
export function buildWireEnv(parsed: Record<string, string>, redactedKeys: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      redactedKeys.has(key) && (value === "true" || value === "") ? true : value,
    ]),
  );
}

interface TestResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

/** The POST /api/mcp-servers body, built in statements so scope is added
 * only when scoped — a conditional spread would hide the omission. */
interface McpServerSaveBody {
  id?: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, boolean | string>;
  enabled: boolean;
  bots?: string[];
}

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-mono text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

function ServerForm({ initial, onSaved, onCancel }: { initial: McpServerWire | null; onSaved: () => void; onCancel: () => void }) {
  const { state } = useStore();
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join("\n"));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [everyBot, setEveryBot] = useState(!initial?.bots?.length);
  const [botIds, setBotIds] = useState<Set<string>>(new Set(initial?.bots ?? []));
  // Redacted env pre-fills as KEY=true; those keys remember their redacted
  // status so an unchanged line round-trips as "keep", not "set to true".
  const [envText, setEnvText] = useState(
    Object.keys(initial?.env ?? {})
      .map((k) => `${k}=true`)
      .join("\n"),
  );
  const [error, setError] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const redactedKeys = new Set(Object.keys(initial?.env ?? {}));
  const payload = (): McpServerSaveBody => {
    const body: McpServerSaveBody = {
      id: initial?.id,
      name: name.trim(),
      command: command.trim(),
      args: parseArgLines(argsText),
      env: buildWireEnv(parseEnvLines(envText), redactedKeys),
      enabled,
    };
    if (!everyBot) body.bots = [...botIds];
    return body;
  };

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      await api("/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTest(null);
    setBusy(true);
    try {
      const result: TestResult = await api("/api/mcp-servers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      setTest(result);
    } catch (e) {
      setTest({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hairline/40 bg-inset p-3">
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (letters-digits-_)" className={inputClass} />
        <label className="flex shrink-0 items-center gap-1.5 px-1 text-[13px] text-ink-secondary">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> enabled
        </label>
      </div>
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="/absolute/path/to/server or bare-name-found-on-PATH"
        className={inputClass}
      />
      <div>
        <div className="mb-1 text-[12px] text-ink-secondary">Arguments, one per line</div>
        <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={2} placeholder={"-y\n@scope/some-server"} className={inputClass} />
      </div>
      <div>
        <div className="mb-1 text-[12px] text-ink-secondary">Environment — KEY=value lines; leave a redacted value as true to keep the secret</div>
        <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={2} placeholder="API_TOKEN=..." className={inputClass} />
      </div>
      <details open={!everyBot} className="rounded-lg border border-hairline/40 bg-panel px-3 py-2">
        <summary className="cursor-pointer text-[13px] text-ink-secondary">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={everyBot} onChange={(e) => setEveryBot(e.target.checked)} /> available to every bot
          </label>
        </summary>
        {!everyBot && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {state.bots.map((b) => (
              <label key={b.id} className="flex items-center gap-1.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={botIds.has(b.id)}
                  onChange={(e) => {
                    const next = new Set(botIds);
                    if (e.target.checked) next.add(b.id);
                    else next.delete(b.id);
                    setBotIds(next);
                  }}
                />
                {b.name}
              </label>
            ))}
          </div>
        )}
      </details>
      {error && <div className="text-[12.5px] text-danger">{error}</div>}
      {test && !test.ok && <div className="text-[12.5px] text-danger">Test failed: {test.error}</div>}
      {test?.ok && (
        <div className="text-[12.5px] text-success">
          {(test.tools?.length ?? 0) > 0
            ? `Connected — ${test.tools!.length} tool${test.tools!.length === 1 ? "" : "s"}: ${test.tools!.map((t) => t.name).join(", ")}`
            : "Connected — no tools listed"}
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={() => void runTest()} disabled={busy || !command.trim()} className="rounded-lg border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40">
          Test connection
        </button>
        <button onClick={() => void save()} disabled={busy} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] text-panel hover:opacity-90 disabled:opacity-40">
          Save
        </button>
        <button onClick={onCancel} className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function McpServersSection() {
  const [servers, setServers] = useState<McpServerWire[] | null>(null);
  const [editing, setEditing] = useState<McpServerWire | null>(null);
  const [adding, setAdding] = useState(false);
  const [rowTest, setRowTest] = useState<Record<string, TestResult>>({});

  const refresh = async () => {
    const page = await api("/api/mcp-servers");
    setServers(page.servers);
  };
  useEffect(() => {
    void refresh().catch(() => setServers([])); // unreachable server: render empty cleanly
  }, []);

  const remove = async (id: string) => {
    await api(`/api/mcp-servers/${id}`, { method: "DELETE" });
    await refresh();
  };

  const testRow = async (server: McpServerWire) => {
    setRowTest((prev) => ({ ...prev, [server.id]: { ok: false, error: "connecting…" } }));
    try {
      const result: TestResult = await api("/api/mcp-servers/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: server.id, command: server.command, args: server.args, env: server.env }),
      });
      setRowTest((prev) => ({ ...prev, [server.id]: result }));
    } catch (e) {
      setRowTest((prev) => ({ ...prev, [server.id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  return (
    <Card
      title="MCP servers"
      subtitle="Your own stdio MCP servers, mounted into every enabled bot's engine (or just the ones you pick). Commands run on this computer without a shell."
    >
      <div className="flex flex-col gap-3">
        {(editing || adding) && (
          <ServerForm
            initial={editing}
            onSaved={() => {
              setEditing(null);
              setAdding(false);
              void refresh();
            }}
            onCancel={() => {
              setEditing(null);
              setAdding(false);
            }}
          />
        )}
        {!servers?.length && !adding && !editing && (
          <div className="text-[13px] text-ink-secondary">No custom servers yet.</div>
        )}
        {servers?.map((s) => (
          <div key={s.id} className="flex flex-col gap-1.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-ink">{s.name}</span>
              {!s.enabled && <span className="text-[11px] text-ink-secondary">disabled</span>}
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-secondary" title={`${s.command} ${s.args.join(" ")}`}>
                {s.command} {s.args.join(" ")}
              </span>
              <button onClick={() => void testRow(s)} aria-label={`Test ${s.name}`} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink">
                <PlayCircle size={15} />
              </button>
              <button onClick={() => { setAdding(false); setEditing(s); }} aria-label={`Edit ${s.name}`} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink">
                <Pencil size={14} />
              </button>
              <button onClick={() => void remove(s.id)} aria-label={`Remove ${s.name}`} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink">
                <Trash2 size={14} />
              </button>
            </div>
            <div className="text-[11.5px] text-ink-secondary">
              {s.env && Object.keys(s.env).length ? `env: ${Object.keys(s.env).join(", ")} · ` : ""}
              {s.bots?.length ? `${s.bots.length} bot${s.bots.length === 1 ? "" : "s"} selected` : "all bots"}
            </div>
            {rowTest[s.id] && (
              <div className={cn("text-[12px]", rowTest[s.id].ok ? "text-success" : "text-danger")}>
                {rowTest[s.id].ok
                  ? rowTest[s.id].tools?.length
                    ? `Tools: ${rowTest[s.id].tools!.map((t) => t.name).join(", ")}`
                    : "Connected — no tools listed"
                  : `Failed: ${rowTest[s.id].error}`}
              </div>
            )}
          </div>
        ))}
        {!editing && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex w-fit items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised"
          >
            <Plus size={14} /> Add server
          </button>
        )}
      </div>
    </Card>
  );
}
