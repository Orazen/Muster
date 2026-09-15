// Workspace files (droppy-style): the bot's whole private workspace —
// notes, drafts, exports — listed, edited, downloaded and deleted from the
// bot's settings panel. Collapsible and lazy like MemoryCard: fetched on
// expand, so files the bot wrote mid-session show up on the next open.
// Server-side is the safety story (path containment, ownership, caps);
// this panel is deliberately plain.
import { useEffect, useState } from "react";
import { ChevronDown, Download, FileText, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";

interface FileEntry {
  path: string;
  bytes: number;
  mtime: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 10.24) / 100} KB`;
  return `${Math.round(n / (102.4 * 1024)) / 10} MB`;
}

export function FilesTab({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; text: string; draft: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result: { files: FileEntry[] } = await api(`/api/bots/${bot.id}/files`);
      setFiles(result.files);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot.id]);

  const openEditor = async (path: string) => {
    setError(null);
    try {
      const result: { text: string } = await api(`/api/bots/${bot.id}/files/content?path=${encodeURIComponent(path)}`);
      setEditing({ path, text: result.text, draft: result.text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/files/content`, {
        method: "PUT",
        body: JSON.stringify({ path: editing.path, text: editing.draft }),
      });
      setEditing(null);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!creating?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/files/content`, {
        method: "PUT",
        body: JSON.stringify({ path: creating.trim(), text: "" }),
      });
      setCreating(null);
      await load();
      void openEditor(creating.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string) => {
    if (!window.confirm(`Delete ${path} from ${bot.name}'s workspace? The bot's copy goes away.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl bg-card">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-4 text-left"
      >
        <FileText size={15} className="shrink-0 text-ink-secondary" />
        <span className="text-[15px] font-medium text-ink">Workspace files</span>
        {open && !loading && <span className="text-[12px] text-ink-secondary">· {files.length}</span>}
        <ChevronDown size={15} className={cn("ml-auto shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="px-4 pb-4">
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-[13px] text-ink-secondary">
              <Loader2 size={13} className="animate-spin" /> Reading the workspace…
            </div>
          ) : (
            <>
              <p className="mb-2 text-[12.5px] leading-relaxed text-ink-secondary">
                Everything {bot.name} keeps in its private folder — notes, drafts, exports. Edits here land
                immediately; the bot sees them on its next turn.
              </p>

              {editing ? (
                <div className="rounded-lg border border-hairline/40 bg-inset p-2">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="truncate font-mono text-[12px] text-ink">{editing.path}</span>
                    <button
                      onClick={() => setEditing(null)}
                      className="ml-auto rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                      aria-label="Close editor"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <textarea
                    value={editing.draft}
                    onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                    rows={10}
                    className="w-full resize-y rounded-md bg-card p-2 font-mono text-[12.5px] leading-relaxed text-ink focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => void save()}
                      disabled={busy || editing.draft === editing.text}
                      className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {files.length === 0 && (
                    <div className="py-3 text-[13px] text-ink-secondary">Nothing yet — {bot.name} hasn't written any files.</div>
                  )}
                  {files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 border-b border-hairline/20 py-1.5 last:border-0">
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={f.path}>
                        {f.path}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(f.bytes)}</span>
                      <span className="hidden shrink-0 text-[11.5px] text-ink-secondary sm:block">
                        {new Date(f.mtime).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                      <button
                        onClick={() => void openEditor(f.path)}
                        className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                        aria-label={`Edit ${f.path}`}
                        title="Edit"
                      >
                        <Pencil size={13} />
                      </button>
                      <a
                        href={`/api/bots/${bot.id}/files/download?path=${encodeURIComponent(f.path)}`}
                        className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                        aria-label={`Download ${f.path}`}
                        title="Download"
                      >
                        <Download size={13} />
                      </a>
                      <button
                        onClick={() => void remove(f.path)}
                        disabled={busy}
                        className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                        aria-label={`Delete ${f.path}`}
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="mt-2 flex items-center gap-2">
                    {creating !== null ? (
                      <>
                        <input
                          autoFocus
                          value={creating}
                          onChange={(e) => setCreating(e.target.value)}
                          placeholder="notes/todo.md"
                          className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1.5 font-mono text-[12.5px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/50"
                        />
                        <button
                          onClick={() => void create()}
                          disabled={busy || !creating.trim()}
                          className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                        >
                          Create
                        </button>
                        <button
                          onClick={() => setCreating(null)}
                          className="rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setCreating("")}
                        className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover"
                      >
                        <Plus size={13} /> New file
                      </button>
                    )}
                  </div>
                </>
              )}
              {error && <div className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
