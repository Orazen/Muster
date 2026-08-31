// Split engines into Cloud (first-party catalog + Custom) and Local
// (no catalog — inject a model). A missing `access` is Cloud so older
// payloads stay in the top group. VibeCoder would join Local later.
import type { InstanceInfo } from "@/state/store";

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

/** The two rail groups, in display order. */
export interface EngineRailSplit<T> {
  subscription: T[];
  custom: T[];
}

export function splitEngineRail<T>(instances: readonly T[]): EngineRailSplit<T> {
  const subscription: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    // SAFETY: rail rows are engine records carrying the optional access tag;
    // absence means Cloud, which isCustomOnly already reports as false.
    if (isCustomOnly(instance as { access?: InstanceInfo["access"] })) custom.push(instance);
    else subscription.push(instance);
  }
  return { subscription, custom };
}
