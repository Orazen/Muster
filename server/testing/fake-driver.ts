// In-memory ProviderDriver for registry/bus tests. Queue-free and
// deliberately tiny: tests reach into the returned handle to emit
// canonical events as if the provider produced them.
import type {
  DriverCreateInput,
  EffortLevel,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
} from "../contracts.ts";
import type { JsonObject, JsonValue } from "../schema.ts";

export interface FakeDriverOptions {
  kind?: string;
  /** create() rejects with this message (shadow-downgrade path). */
  failCreate?: string;
  /** snapshot() rejects with this message (describe-downgrade path). */
  failSnapshot?: string;
  /** effort levels this fake driver declares, forwarded onto capabilities. */
  effortLevels?: readonly EffortLevel[];
}

/** Config contract for the fake driver: fields ride through verbatim; only
 * the `bad` flag is interpreted (it triggers the shadow-downgrade path). */
export interface FakeDriverConfig {
  bad?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface FakeDriverHandle {
  driver: ProviderDriver<FakeDriverConfig>;
  /** Live instances by instanceId, with their event-emit hook. */
  created: Map<string, { instance: ProviderInstance; emit: (e: RuntimeEvent) => void }>;
  decodedConfigs: unknown[];
  disposed: string[];
}

export function makeFakeDriver(opts: FakeDriverOptions = {}): FakeDriverHandle {
  const kind = opts.kind ?? "fake";
  const handle: FakeDriverHandle = {
    created: new Map(),
    decodedConfigs: [],
    disposed: [],
    driver: {
      driverKind: kind,
      metadata: { displayName: `Fake ${kind}` },
      models: { default: `${kind}-1`, options: [{ id: `${kind}-1`, label: `${kind} one` }] },
      decodeConfig(raw: JsonValue | undefined) {
        // Non-object configs decode to the empty config; only `bad` is read.
        const o: JsonObject = raw instanceof Object && !Array.isArray(raw) ? raw : {};
        if (o.bad) {
          throw new Error(`${kind}: bad config`);
        }
        handle.decodedConfigs.push(raw);
        // SAFETY: the fake driver passes persisted config through verbatim; only the `bad` flag is interpreted
        return o as FakeDriverConfig;
      },
      defaultConfig: () => ({ isDefault: true }),
      async create(input: DriverCreateInput<FakeDriverConfig>): Promise<ProviderInstance> {
        if (opts.failCreate) throw new Error(opts.failCreate);
        const listeners = new Set<RuntimeEventListener>();
        const emit = (event: RuntimeEvent) => {
          for (const l of listeners) l(event);
        };
        const instance: ProviderInstance = {
          instanceId: input.instanceId,
          driverKind: kind,
          displayName: input.displayName,
          enabled: input.enabled,
          models: handle.driver.models,
          snapshot: async (): Promise<ProviderSnapshot> => {
            if (opts.failSnapshot) throw new Error(opts.failSnapshot);
            return { state: "available", version: "0.0.0-fake" };
          },
          adapter: {
            provider: kind,
            capabilities: { sessionModelSwitch: "unsupported", effortLevels: opts.effortLevels },
            sendTurn: async () => ({ turnId: "fake-turn" }),
            interruptTurn: async () => {},
            respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
            hasSession: () => false,
            stopAll: async () => {},
            onEvent: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          dispose: async () => {
            handle.disposed.push(input.instanceId);
            listeners.clear();
          },
        };
        handle.created.set(input.instanceId, { instance, emit });
        return instance;
      },
    },
  };
  return handle;
}
