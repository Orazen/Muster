// Durable SQLite adapter for the follow-up proposal store port.
//
// Scoped to proposal rows only. It is not a second task database, not a
// message store and not a queue: it never runs a job, never dispatches and
// never contacts a provider. The policy module (server/follow-up-proposals.ts)
// owns every lifecycle decision; this file owns nothing but the round trip to
// disk and the atomicity of that round trip.
//
// Two boundaries are deliberate.
//
// 1. Scope is in the SQL, not in a filter applied afterwards. Every read and
//    every write predicate carries ownerId AND workspaceId, so a row that
//    another account owns is not a row this account can select — a forged
//    serialized owner in the stored JSON cannot widen the boundary, because
//    the module re-validates the row on read and this adapter refuses to
//    store a row whose own columns disagree with the authority it was
//    offered under.
//
// 2. Writes report what actually happened. A compare-and-swap is one atomic
//    UPDATE whose affected-row count is the answer: it either advanced the
//    stored revision or it did not. A failure before COMMIT is a definite
//    'rolled-back'; a failure while COMMITting is 'lost-response', because
//    the adapter genuinely cannot tell whether the row moved. The module
//    re-reads the original id in that case and never writes twice.

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type {
  FollowUpAuthority,
  FollowUpProposalStore,
} from "./follow-up-proposals.ts";

/** The policy module refuses to parse a row above this size, so the adapter
 * never stores one either: both ends of the boundary agree. */
const MAX_ROW_BYTES = 256 * 1024;
const MAX_IDENTIFIER = 200;

/** The authority the caller was resolved to, as a queryable pair. A caller
 * that cannot state both has no scope, and the adapter answers empty rather
 * than falling back to an unfiltered read. */
const authoritySchema = z.object({
  ownerId: z.string().min(1).max(MAX_IDENTIFIER),
  workspaceId: z.string().min(1).max(MAX_IDENTIFIER),
});

/** The columns this table indexes, lifted out of the stored row. A row whose
 * indexed fields do not parse is not stored and not read: the SQL boundary
 * depends on these being derivable, so it refuses to hold a row they are not
 * derivable from. */
const storedColumnsSchema = z.object({
  proposalId: z.string().min(1).max(MAX_IDENTIFIER),
  ownerId: z.string().min(1).max(MAX_IDENTIFIER),
  workspaceId: z.string().min(1).max(MAX_IDENTIFIER),
  taskId: z.string().min(1).max(MAX_IDENTIFIER),
  proposalType: z.string().min(1).max(64),
  revision: z.number().int().positive(),
  evidence: z.object({ sourceKey: z.string().min(1).max(MAX_IDENTIFIER) }),
});
type StoredColumns = z.infer<typeof storedColumnsSchema>;

const rowTextSchema = z.string().min(1).max(MAX_ROW_BYTES);
const storedRowSchema = z.object({ row: rowTextSchema });
const changesSchema = z.object({ changes: z.union([z.number(), z.bigint()]) })
  .transform(result => Number(result.changes));
/** What node:sqlite's run() hands back. The affected-row count is the whole
 * answer this adapter needs from it. */
interface SqlWriteResult {
  readonly changes: number | bigint;
}

function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS follow_up_proposals (
    ownerId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    workspaceId TEXT NOT NULL,
    proposalId TEXT NOT NULL,
    revision INTEGER NOT NULL,
    taskId TEXT NOT NULL,
    proposalType TEXT NOT NULL,
    sourceKey TEXT NOT NULL,
    row TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (ownerId, workspaceId, proposalId)
  );
  CREATE INDEX IF NOT EXISTS follow_up_proposals_source
    ON follow_up_proposals(ownerId, workspaceId, sourceKey);
  CREATE INDEX IF NOT EXISTS follow_up_proposals_task
    ON follow_up_proposals(ownerId, workspaceId, taskId);`);
}

/** Read the indexed columns out of a serialized row. Returns null for a row
 * too large to parse, malformed JSON, or missing the fields the table
 * indexes — every one of which is a row this adapter will not carry. */
function readColumns(row: string): StoredColumns | null {
  if (Buffer.byteLength(row, "utf8") > MAX_ROW_BYTES) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(row);
  } catch {
    return null;
  }
  const parsed = storedColumnsSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/** The authority argument is the boundary. A row that disagrees about who it
 * belongs to is not that caller's row, whatever the caller's scope says, and
 * is not written under either name. */
function belongsTo(columns: StoredColumns, authority: FollowUpAuthority): boolean {
  return columns.ownerId === authority.ownerId && columns.workspaceId === authority.workspaceId;
}

function affected(result: SqlWriteResult): number {
  const parsed = changesSchema.safeParse(result);
  return parsed.success ? parsed.data : 0;
}

export function createFollowUpStore(db: DatabaseSync, now: () => number = Date.now): FollowUpProposalStore {
  return {
    listForAuthority(authority, lookup) {
      const scope = authoritySchema.safeParse(authority);
      if (!scope.success) return [];
      initialize(db);
      // Each optional lookup narrows the same scoped read; an absent field is
      // simply not a predicate, exactly as the port describes. The module
      // re-applies both filters after parsing, so this is a narrowing, never
      // the boundary.
      //
      // No LIMIT: the module's dedupe and competing-card checks are only
      // correct over the complete set for a source, and the index bounds that
      // set. Capping the read here would let a truncated query miss a live
      // card and mint a second one. Presentation bounds belong to the route.
      const predicates = ["ownerId = ?", "workspaceId = ?"];
      const bound: string[] = [scope.data.ownerId, scope.data.workspaceId];
      if (lookup.sourceKey !== undefined) {
        predicates.push("sourceKey = ?");
        bound.push(lookup.sourceKey);
      }
      if (lookup.proposalType !== undefined) {
        predicates.push("proposalType = ?");
        bound.push(lookup.proposalType);
      }
      // SAFETY: the statement is assembled only from the fixed predicate
      // strings above; every caller-supplied value travels as a bound
      // parameter, and only the selected `row` column is projected.
      const selected = db.prepare(
        `SELECT row FROM follow_up_proposals WHERE ${predicates.join(" AND ")}`,
      ).all(...bound);
      const rows: string[] = [];
      for (const record of selected) {
        const parsed = storedRowSchema.safeParse(record);
        if (parsed.success) rows.push(parsed.data.row);
      }
      return rows;
    },

    load(authority, proposalId) {
      const scope = authoritySchema.safeParse(authority);
      if (!scope.success || proposalId.length === 0 || proposalId.length > MAX_IDENTIFIER) return null;
      initialize(db);
      const record = db.prepare(`SELECT row FROM follow_up_proposals
        WHERE ownerId = ? AND workspaceId = ? AND proposalId = ?`)
        .get(scope.data.ownerId, scope.data.workspaceId, proposalId);
      const parsed = storedRowSchema.safeParse(record);
      return parsed.success ? parsed.data.row : null;
    },

    compareAndSwap(authority, proposalId, expectedRevision, nextRow) {
      const scope = authoritySchema.safeParse(authority);
      const columns = readColumns(nextRow);
      if (!scope.success || columns === null) return "rolled-back";
      if (proposalId.length === 0 || proposalId.length > MAX_IDENTIFIER) return "rolled-back";
      // A swap may only advance the row it named, by exactly one revision,
      // and only for a row this caller owns.
      if (columns.proposalId !== proposalId
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
        || columns.revision !== expectedRevision + 1
        || !belongsTo(columns, scope.data)) {
        return "rolled-back";
      }
      initialize(db);
      const at = now();
      db.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        // SAFETY: this UPDATE projects and writes only the named columns of
        // follow_up_proposals, all bound above.
        const result = db.prepare(`UPDATE follow_up_proposals
          SET revision = ?, row = ?, sourceKey = ?, updatedAt = ?
          WHERE ownerId = ? AND workspaceId = ? AND proposalId = ? AND revision = ?`)
          .run(
            columns.revision,
            nextRow,
            columns.evidence.sourceKey,
            at,
            scope.data.ownerId,
            scope.data.workspaceId,
            proposalId,
            expectedRevision,
          );
        if (affected(result) !== 1) {
          db.exec("ROLLBACK");
          return "rolled-back";
        }
        db.exec("COMMIT");
        committed = true;
        return "committed";
      } catch {
        // Once COMMIT has been issued the adapter can no longer say whether
        // the row moved: that is exactly 'lost-response', and the module
        // settles it by re-reading the original id instead of writing again.
        if (committed) return "lost-response";
        try {
          db.exec("ROLLBACK");
        } catch {
          return "lost-response";
        }
        return "rolled-back";
      }
    },

    insert(authority, row) {
      const scope = authoritySchema.safeParse(authority);
      const columns = readColumns(row);
      if (!scope.success || columns === null) return "rolled-back";
      if (!belongsTo(columns, scope.data)) return "rolled-back";
      initialize(db);
      const at = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        // SAFETY: this INSERT writes only the named columns of
        // follow_up_proposals, all bound above.
        db.prepare(`INSERT INTO follow_up_proposals
          (ownerId, workspaceId, proposalId, revision, taskId, proposalType, sourceKey, row, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            scope.data.ownerId,
            scope.data.workspaceId,
            columns.proposalId,
            columns.revision,
            columns.taskId,
            columns.proposalType,
            columns.evidence.sourceKey,
            row,
            at,
            at,
          );
        db.exec("COMMIT");
        return "committed";
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
          return "lost-response";
        }
        return "rolled-back";
      }
    },
  };
}
