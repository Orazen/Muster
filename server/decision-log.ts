// The trust gateway's ledger: every permission a bot raised and the verdict
// it got — a person allowing or denying, an auto-mode rule firing, or a
// peer-contact gate settling — recorded once, at the moment of decision.
//
// "Every action decided before it happens" is only trustworthy if the
// decisions stay visible afterwards, so this log is append-only AND
// persisted: pending approvals die with the process by design, but a
// verdict that already happened must survive a restart. Oldest entries
// fall off a cap — an audit surface for humans, not a compliance archive.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { newId } from "./contracts.ts";

/** How an action was settled. `auto` means a machine rule answered (an
 * always-allow grant or auto mode); `approved`/`denied` mean a person did. */
export type AuditDecision = "approved" | "denied" | "auto";

export interface DecisionEntry {
  id: string;
  /** ms epoch */
  at: number;
  /** the gated thing: a tool name ("Bash") or a peer action ("ask_bot") */
  action: string;
  decision: AuditDecision;
  /** which rule fired, for auto decisions — the same string the transcript chip shows */
  rule?: string;
  summary: string;
}

/** On-disk entries carry the bot they belong to; the API shape does not —
 * the endpoint is already scoped to one bot by its route. */
interface StoredEntry extends DecisionEntry {
  botId: string;
}

interface DecisionFile {
  version: 1;
  decisions: StoredEntry[];
}

export interface DecisionLogOptions {
  file: string;
  now?: () => number;
  makeId?: () => string;
  /** Override for tests; production keeps every recent verdict up to this. */
  maxEntries?: number;
}

/** Exactly what GET /api/bots/:id/audit serializes. */
export interface AuditPageResponse {
  entries: DecisionEntry[];
  /** Pass back as ?before= for the next, older page. Absent at the end. */
  nextBefore?: string;
}

const MAX_ENTRIES = 5000;

export class DecisionLog {
  private entries: StoredEntry[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly maxEntries: number;

  constructor(options: DecisionLogOptions) {
    this.file = options.file;
    this.now = options.now ?? (() => Date.now());
    this.makeId = options.makeId ?? newId;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    try {
      if (!existsSync(this.file)) return;
      // SAFETY: the only writer is save() below, which always emits a versioned DecisionFile.
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as DecisionFile;
      if (raw.version !== 1 || !Array.isArray(raw.decisions)) return;
      this.entries = raw.decisions;
    } catch {
      this.entries = []; // unreadable file starts a fresh ledger rather than wedging the server
    }
  }

  /** Append one verdict and persist it synchronously — a decision lost to a
   * crash moments after being made is exactly the hole this surface exists
   * to close. */
  record(botId: string, input: Omit<DecisionEntry, "id" | "at">): DecisionEntry {
    const entry: StoredEntry = { id: this.makeId(), at: this.now(), botId, ...input };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.save();
    return { ...entry };
  }

  /** One bot's verdicts, newest first. `before` is a cursor: only entries
   * strictly older than that id. A dead cursor yields an empty page instead
   * of silently restarting the walk, so a client can never loop. */
  page(botId: string, opts: { limit: number; before?: string }): AuditPageResponse {
    const newestFirst = this.entries.filter((e) => e.botId === botId).reverse();
    let start = 0;
    if (opts.before) {
      const idx = newestFirst.findIndex((e) => e.id === opts.before);
      if (idx === -1) return { entries: [] };
      start = idx + 1;
    }
    const window = newestFirst.slice(start, start + opts.limit);
    const result: AuditPageResponse = {
      entries: window.map((e) => ({ id: e.id, at: e.at, action: e.action, decision: e.decision, rule: e.rule, summary: e.summary })),
    };
    const oldest = window[window.length - 1];
    if (start + opts.limit < newestFirst.length && oldest) result.nextBefore = oldest.id;
    return result;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, decisions: this.entries } satisfies DecisionFile));
    renameSync(temp, this.file);
  }
}

export const DEFAULT_AUDIT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

function parseAuditLimit(raw: string | null): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n)) return DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), AUDIT_MAX_LIMIT);
}

/** The audit endpoint's whole brain, factored out of index.ts so tests can
 * pin shape, ordering, scoping and cursor behavior without HTTP. The route
 * contributes only session auth, ownership (the shared /api/bots/:id guard)
 * and serialization. */
export function queryAudit(
  log: Pick<DecisionLog, "page">,
  botId: string,
  params: URLSearchParams,
): AuditPageResponse {
  return log.page(botId, { limit: parseAuditLimit(params.get("limit")), before: params.get("before") ?? undefined });
}
