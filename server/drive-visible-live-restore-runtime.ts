// Factory for owned, same-runtime cooperating live-restore preparation.
//
// The injected Store/plan engine/provider registry/settings/publication are
// real runtime ports. The root-identity handle only re-proves the directory
// identity and absence of whole-install restore claims; it cannot exclude
// same-UID processes or previously issued file/SQLite write references.
// JS frame ordering and before/post-image checks are narrower safeguards,
// not production lifetime writer authority or OS isolation.
//
// Production registration below intentionally offers no apply/receipt
// runtime. An environment toggle cannot promote this identity-only handle.
// Boot observation/reconciliation remains unchanged; no unattended apply is
// added. Activation requires a separately reviewed actual host authority.
import type { ModelSelection, ProviderInstance } from "./contracts.ts";
import type { Store } from "./store.ts";
import type { TaskPlanEngine } from "./task-engine.ts";
import type { resolveAuthenticatedVisibleAccount } from "./drive-visible-account-bundle.ts";
import type { CurrentOwnedRecoveryEngine } from "./drive-visible-account-import.ts";
import type { AccountSettingsSnapshot } from "./drive-visible-settings.ts";
import type { LiveRestoreResult, LiveRestoreRuntime } from "./drive-visible-live-restore.ts";
import type { RestoreRootIdentity } from "./drive-visible-live-writer-authority.ts";
import { userInstanceOwner } from "./user-keys.ts";

type VisibleLiveAccount = NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"];

export interface LiveRestoreRuntimeHost {
  dataDir: string;
  store: Store;
  plans: TaskPlanEngine;
  /** Captured root identity for this cooperating runtime, not exclusivity. */
  rootIdentity: RestoreRootIdentity;
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

/** The actual server consumes this registration. It stays empty for every
 * environment value because no supported production host authority exists.
 * The never field prevents accidentally adopting a cooperating runtime here. */
export interface ProductionLiveRestoreRegistration { liveRestore?: never; }
export function productionLiveRestoreRegistration(): ProductionLiveRestoreRegistration {
  return {};
}

/** Owned cooperating harnesses only; production must use the refused
 * registration above rather than promote this injected factory. */
export function createLiveRestoreRuntime(host: LiveRestoreRuntimeHost): LiveRestoreRuntime {
  return {
    dataDir: host.dataDir,
    store: host.store,
    plans: host.plans,
    assertReady: () => host.rootIdentity.assertReady(),
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
