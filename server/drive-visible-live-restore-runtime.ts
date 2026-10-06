// Production factory for the account-scoped ADDITIVE live-restore runtime.
//
// PR #98's adapter needs a LiveRestoreRuntime that speaks for the RUNNING
// server — its actual Store, task-plan engine, engine registry, account
// settings reader and stream publisher — and a REAL writer authority, not a
// test double, not request metadata. This module is that factory.
//
// This is the production answer to the capability comment:
// "Production registration supplies none until lifetime writer/boot
// authority exists." Lifetime writer authority is implemented in
// server/drive-visible-live-writer-authority.ts (holdRestoreWriterAuthority) —
// a held OS-handle + captured data-directory identity, re-proven at every
// adapter boundary. Boot authority stays CLOSED by design: the boot-time
// apply path still does not exist, and nothing here changes that. The journal
// startup observer (assertLiveRestoreStartupReady) keeps adopting nothing,
// and recoverPendingLiveRestores keeps compensating only — no unattended
// apply exists behind this factory.
//
// enrolment/enablement is NOT decided here on purpose: the factory is inert
// until the host registration in server/index.ts constructs it, and that
// registration happens only behind the explicit, defaulted-off
// OMB_LIVE_RESTORE_APPLY flag (runtime HTTP apply only).
//
// RESIDUAL — named, not papered over. The writer exclusion that protects the
// additive commit/compensation frame is:
//   (a) inside the frame: the JavaScript runtime itself (NO await from
//       authority acquisition through commit), which no in-process writer can
//       break;
//   (b) between the async windows (engine snapshot, Drive custody download):
//       boundary re-reads of recorded before-images — disk, SQLite and live
//       caches — that refuse with a journal-visible rollback on any foreign
//       byte. Detection-based, not exclusion-based: a writer that ran during
//       such a window makes the operation fail closed; it does not yet make
//       the writer hung. The enumerated in-process surfaces (store.ts roster
//       saves and message persistence, task-engine.ts plan/intent persists,
//       message-db.ts SQL writes, workspace MEMORY writes in index.ts, and
//       the sync producers wired in index.ts) have no gate seam in this
//       slice; the shared write paths were not bent to add one. External
//       (other-process) writers are likewise never claimed excluded. What
//       cross-process work there is: the one-process-per-data-directory
//       single-writer convention, the exclusive-restore claim refusal here
//       and at boot, and the journal writer.lock serializing concurrent
//       live-restore operations. None of this is OS isolation, and no
//       power-loss durability is claimed: the receipt itself says
//       durability "process-restart-only".
import type { ModelSelection, ProviderInstance } from "./contracts.ts";
import type { Store } from "./store.ts";
import type { TaskPlanEngine } from "./task-engine.ts";
import type { resolveAuthenticatedVisibleAccount } from "./drive-visible-account-bundle.ts";
import type { CurrentOwnedRecoveryEngine } from "./drive-visible-account-import.ts";
import type { AccountSettingsSnapshot } from "./drive-visible-settings.ts";
import type { LiveRestoreResult, LiveRestoreRuntime } from "./drive-visible-live-restore.ts";
import type { RestoreWriterAuthority } from "./drive-visible-live-writer-authority.ts";
import { userInstanceOwner } from "./user-keys.ts";

type VisibleLiveAccount = NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"];

export interface LiveRestoreRuntimeHost {
  dataDir: string;
  store: Store;
  plans: TaskPlanEngine;
  /** The real held writer authority from holdRestoreWriterAuthority. */
  authority: RestoreWriterAuthority;
  /** The running provider registry, RE-READ on every call so a mid-restore
   * engine reload is observed instead of cached. */
  instances(): ProviderInstance[];
  /** The running server's real settings reader (db-backed). */
  readAccountSettings(account: VisibleLiveAccount): AccountSettingsSnapshot | null;
  /** Engine choices offered in the status route, for the account's own
   * enabled owned instances only. The adapter re-verifies every selection. */
  engineChoices?(account: VisibleLiveAccount): Array<{ label: string; selection: ModelSelection }>;
  /** Publication AFTER commit: the additive inserts emit no store events by
   * design, so the host broadcasts the restored records through its stream. */
  publishRecords(account: { userId: string; workspaceId: string }, ids: { bots: string[]; groups: string[] }): void;
}

/** Verify one selection against the current registry and the account's real
 * owned instance id, mirroring exactly what dispatch consults. */
function ownedEngine(host: LiveRestoreRuntimeHost, selection: ModelSelection, account: VisibleLiveAccount): CurrentOwnedRecoveryEngine | null {
  // The full owner/enablement/model checks stay in the adapter (engine()),
  // which re-reads them at every boundary. This resolver only supplies the
  // registry's CURRENT live instance — the one the server would actually
  // dispatch through.
  if (userInstanceOwner(selection.instanceId) !== account.userId) return null;
  const instance = host.instances().find(candidate => candidate.instanceId === selection.instanceId);
  if (!instance || !instance.enabled) return null;
  return { ownerId: account.userId, selection, instance };
}

export function createLiveRestoreRuntime(host: LiveRestoreRuntimeHost): LiveRestoreRuntime {
  return {
    dataDir: host.dataDir,
    store: host.store,
    plans: host.plans,
    assertReady: () => host.authority.assertReady(),
    resolveEngine: (selection, account) => ownedEngine(host, selection, account),
    readSettings: account => host.readAccountSettings(account),
    engineChoices: host.engineChoices ? account => host.engineChoices!(account) : undefined,
    publish: host.publishRecords
      ? (account, result: LiveRestoreResult) => {
          // Safeguarded by design: targets are restored records this account
          // now owns; the route family stream filter resolves ownership by id
          // so an unrelated account never sees these frames.
          host.publishRecords(account, { bots: Object.values(result.mapping.bot), groups: Object.values(result.mapping.group) });
        }
      : undefined,
  };
}
