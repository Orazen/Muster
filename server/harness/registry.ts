// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { findCliCandidates } from "../env-path.ts";
import type { JsonObject } from "../schema.ts";
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

/** True only for primitive strings — what JSON decoding yields for text fields. */
const isText = <T>(value: T): value is T & string => String(value) === value;

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    // SAFETY: defaultConfig returns the driver's own config shape; only its optional `cli` field is read here
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return isText(cfg?.cli) ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(entry: { config?: unknown }): string | undefined {
  // SAFETY: config is decoded JSON from config.json; only a record can carry a cli field
  const record = entry.config as JsonObject | undefined;
  const cli = record?.cli;
  return isText(cli) && cli ? cli : undefined;
}

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private driversByKind: Map<string, AnyProviderDriver>;

  constructor(drivers: readonly AnyProviderDriver[]) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  async load(configs: InstanceConfigMap) {
    // Instances load in PARALLEL: each create() can spawn a process, fetch
    // models, and run a snapshot — N serial awaits made boot time scale
    // with fleet size (seconds of socket-dead time on the boot path).
    //
    // Deterministic order: entries() / instances() expose byId INSERTION
    // order, and consumers rely on it (defaultSelection prefers the first
    // available engine; the unattended-gate e2e pins exactly that). So
    // creates run concurrently, but every byId/shadow write happens in a
    // second pass in CONFIG order — the observable map is byte-identical
    // to the serial version, only faster.
    const ids = Object.keys(configs);
    const settled = await Promise.all(
      ids.map(async (instanceId) => {
        const entry = configs[instanceId]!;
        const driver = this.driversByKind.get(entry.driver);
        if (!driver) {
          // Unknown driver: recorded as a shadow in the second pass — the
          // "kept as configured, unavailable here" contract.
          return { instanceId, entry, live: null, rawCli: cliOfRaw(entry), unknownDriver: entry.driver };
        }
        try {
          const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
          // Override detection is on the RAW config, never the decoded one:
          // decodeConfig fills in the driver default ("claude", "codex", …),
          // so reading `cli` there would flag every instance as overridden.
          const rawCli = cliOfRaw(entry);
          const live = await driver.create({
            instanceId,
            displayName: entry.displayName ?? driver.metadata.displayName,
            environment: entry.environment ?? {},
            enabled: entry.enabled ?? true,
            config,
          });
          return { instanceId, entry, live, rawCli };
        } catch (e) {
          return {
            instanceId,
            entry,
            live: null,
            rawCli: cliOfRaw(entry),
            shadowReason: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    // Second pass in config order. A missing driver surfaces its
    // "unknown driver" shadow here too — create() was never attempted.
    ids.forEach((instanceId, index) => {
      const result = settled[index]!;
      const { entry } = result;
      if (!result.live) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName ?? this.driversByKind.get(entry.driver)?.metadata.displayName,
            cli: cliOfRaw(entry),
            shadow: true,
            reason:
              "unknownDriver" in result
                ? `unknown driver "${result.unknownDriver}" — kept as configured, unavailable here`
                : "shadowReason" in result
                  ? result.shadowReason
                  : "unavailable",
          },
        });
        return;
      }
      if (result.rawCli) this.cliByInstance.set(instanceId, result.rawCli);
      this.byId.set(instanceId, { instanceId, live: result.live });
    });
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async describe() {
    // Multiple instances may share a driver. Scan each default binary once
    // per response instead of repeating filesystem work for every row.
    const candidatesByName = new Map<string, string[]>();
    const candidatesFor = (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
    return Promise.all(
      this.entries().map(async (entry) => {
        const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            capabilities: { computerMcp: false, agentsMcp: false },
            // an unknown driver has no driver record, hence no install path
            access: driver?.metadata.access ?? "subscription",
            install: driver?.install,
            cli: entry.shadow.cli,
            cliDefault: cliDefaultOf(driver),
            // a shadow is exactly the "your CLI is broken, pick another"
            // case where the detected-path dropdown matters most
            cliCandidates: candidatesFor(driver),
          };
        }
        const inst = entry.live;
        let snapshot: ProviderSnapshot;
        try {
          await inst.refreshModels?.();
          snapshot = await inst.snapshot();
        } catch (e) {
          snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
        }
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          snapshot,
          models: inst.models,
          capabilities: {
            computerMcp: inst.adapter.capabilities.computerMcp === true,
            agentsMcp: inst.adapter.capabilities.agentsMcp === true,
            composioMcp: inst.adapter.capabilities.composioMcp === true,
            effortLevels: inst.adapter.capabilities.effortLevels,
          },
          access: driver?.metadata.access ?? "subscription",
          install: driver?.install,
          cli: this.cliByInstance.get(inst.instanceId),
          cliDefault: cliDefaultOf(driver),
          // every copy of the driver's default binary on the augmented PATH —
          // the dropdown's "detected" entries. Snapshotted per describe() so a
          // newly installed CLI shows up on the next refresh.
          cliCandidates: candidatesFor(driver),
        };
      }),
    );
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.cliByInstance.clear();
  }
}
