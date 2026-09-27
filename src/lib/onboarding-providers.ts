import { z } from "zod";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { sessionRecheck } from "./session-recheck";

const providerSchema = z.object({
  id: z.string().min(1),
  configKey: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string(),
});
const catalogSchema = z.object({ providers: z.array(providerSchema) });
const accountVaultCapabilitySchema = z.object({ storageGate: z.object({ required: z.literal(true) }) });
export type OnboardingProvider = z.infer<typeof providerSchema>;
export type ProviderKeyDestination = "/api/user-keys" | null;

export const ONBOARDING_ENGINES = [
  { driverKind: "claudeAgent", label: "Claude", detail: "Use the Claude CLI with your eligible Claude account." },
  { driverKind: "codex", label: "ChatGPT via Codex", detail: "Use Codex with your eligible ChatGPT account." },
  { driverKind: "opencodeGo", label: "OpenCode", detail: "Use OpenCode Go through its CLI and configured account or key." },
] as const;

export function onboardingEngine(instances: InstanceInfo[] | null, driverKind: string): InstanceInfo | undefined {
  const matches = (instances ?? []).filter((instance) => instance.driverKind === driverKind && instance.access !== "custom");
  return matches.find((instance) => instance.snapshot.state === "available" && instance.snapshot.authenticated === true)
    ?? matches[0];
}

/** The current server emits storageGate.required=true only for a signed-in
 * hosted account. Use that as a conservative read capability, then verify the
 * vault itself. Local/older servers offer Settings; never infer a global write
 * destination from a browser/desktop marker or an absent capability. */
export async function readOnboardingProviders(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{
  providers: OnboardingProvider[];
  destination: ProviderKeyDestination;
}> {
  const recheckSession = sessionRecheck.capture();
  signal.throwIfAborted();
  const options: RequestInit = { method: "GET", credentials: "include", cache: "no-store", redirect: "error", signal };
  const read = async (path: string) => {
    const response = await fetcher(path, options);
    signal.throwIfAborted();
    // A capability rejection is not proof of expiry. Check the captured
    // account separately, even if the other discovery request fails.
    if (response.status === 401) void recheckSession();
    return response;
  };
  const [catalog, config] = await Promise.all([
    read("/api/providers"),
    read("/api/config"),
  ]);
  if (!catalog.ok) throw new Error("Provider choices could not be loaded. Try again.");
  const parsed = catalogSchema.safeParse(await catalog.json().catch(() => null));
  if (!parsed.success) throw new Error("Provider choices could not be loaded. Try again.");
  const hasAccountVault = config.ok && accountVaultCapabilitySchema.safeParse(await config.json().catch(() => null)).success;
  signal.throwIfAborted();
  let destination: ProviderKeyDestination = null;
  if (hasAccountVault) {
    const vault = await read("/api/user-keys");
    if (vault.ok) {
      if (!catalogSchema.safeParse(await vault.json().catch(() => null)).success) {
        throw new Error("Account key setup could not be confirmed. Try again.");
      }
      destination = "/api/user-keys";
    } else if (![401, 403, 404].includes(vault.status)) {
      throw new Error("Account key setup could not be confirmed. Try again.");
    }
  }
  signal.throwIfAborted();
  return { providers: parsed.data.providers.filter((provider) => provider.id !== "elevenlabs"), destination };
}

/** Exactly one destination chosen before the write. Errors must never send
 * a personal key to the installation-wide config as a fallback. */
export async function saveOnboardingProvider(
  destination: ProviderKeyDestination,
  provider: OnboardingProvider,
  key: string,
  request: (path: string, init: RequestInit) => Promise<ConfigStatus>,
): Promise<ConfigStatus> {
  if (destination !== "/api/user-keys") throw new Error("Use Providers settings to add a key on this installation.");
  if (!key.trim()) throw new Error("Enter an API key.");
  return request(destination, {
    method: "PUT",
    body: JSON.stringify({ providerId: provider.configKey, apiKey: key.trim() }),
  });
}
