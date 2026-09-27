import { z } from "zod";
import { sessionRecheck } from "./session-recheck";

const gateSchema = z.object({
  required: z.boolean(),
  satisfied: z.boolean(),
  options: z.object({
    googleDrive: z.object({ available: z.boolean(), connected: z.boolean() }),
    telegram: z.object({ configured: z.boolean() }),
  }).optional(),
});
const driveSchema = z.object({
  accountDrive: z.object({ available: z.boolean(), connected: z.boolean() }),
  workspaceBackupAvailable: z.boolean().optional(),
  installationDrive: z.object({ configured: z.boolean() }).optional(),
});
const configSchema = z.object({ storageGate: gateSchema });
const catalogSchema = z.object({
  configured: z.boolean(),
  cards: z.array(z.object({ slug: z.string() })),
  reason: z.string().max(500).optional(),
});
const servicesSchema = z.object({
  configured: z.boolean(),
  services: z.record(z.string(), z.object({ connected: z.boolean(), pending: z.boolean().optional(), status: z.string().optional() })),
  reason: z.string().max(500).optional(),
});

export type DriveSetupStatus = z.infer<typeof driveSchema>["accountDrive"] & { gate: z.infer<typeof gateSchema>; localBackupReady: boolean };
export type GmailSetupStatus =
  | { kind: "unavailable"; reason: string }
  | { kind: "connected" | "pending" | "disconnected" };

/** Status and explicit consent only. This reader never redirects a stale
 * account after a late 401, and never treats an OAuth return query as proof. */
async function request<T>(path: string, signal: AbortSignal, fetcher: typeof fetch, schema: z.ZodType<T>, invalidMessage: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const recheckSession = sessionRecheck.capture();
  const response = await fetcher(path, {
    method, credentials: "include", cache: "no-store", redirect: "error",
    headers: { accept: "application/json" }, signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  if (!response.ok) {
    if (response.status === 401) void recheckSession();
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(error.success ? error.data.error : "Could not check this connection. Try again.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(invalidMessage);
  return parsed.data;
}

export async function readOnboardingDrive(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<DriveSetupStatus> {
  const [status, config] = await Promise.all([
    request("/api/workspace/google/status", signal, fetcher, driveSchema, "Drive status could not be verified. Check again."),
    request("/api/config", signal, fetcher, configSchema, "Drive status could not be verified. Check again."),
  ]);
  // Two reads may straddle revocation; don't show Connected from a stale half.
  const gate = config.storageGate;
  const connected = status.accountDrive.connected && (!gate.required || gate.satisfied);
  return { ...status.accountDrive, connected, gate,
    localBackupReady: status.workspaceBackupAvailable === true && status.installationDrive?.configured === true };
}

/** Only remove our known callback marker; preserve the chosen app shell,
 * other query parameters and fragment. The outcome never proves a grant. */
export function onboardingDriveReturn(location: { pathname: string; search: string; hash: string }): {
  outcome: "connected" | "connect-failed"; cleaned: string;
} | null {
  const params = new URLSearchParams(location.search);
  const outcome = params.get("drive");
  if (outcome !== "connected" && outcome !== "connect-failed") return null;
  params.delete("drive");
  const rest = params.toString();
  return { outcome, cleaned: `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}` };
}

export async function readOnboardingGmail(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<GmailSetupStatus> {
  const catalog = await request("/api/connectors/catalog", signal, fetcher, catalogSchema, "Gmail availability could not be verified. Check again.");
  if (!catalog.configured || !catalog.cards.some((card) => card.slug === "gmail")) {
    return { kind: "unavailable", reason: catalog.reason ?? "Gmail is not available for this account here yet. You can continue without it." };
  }
  const result = await request("/api/connectors?services=gmail", signal, fetcher, servicesSchema, "Gmail status could not be verified. Check again.");
  if (!result.configured) return { kind: "unavailable", reason: result.reason ?? "Gmail is not available for this account here yet. You can continue without it." };
  const gmail = result.services.gmail;
  if (!gmail) throw new Error("Gmail status could not be verified. Check again.");
  return { kind: gmail.connected ? "connected" : gmail.pending ? "pending" : "disconnected" };
}

const consentSchema = z.object({ url: z.string().url() });
type ConsentResponse = z.infer<typeof consentSchema>;

export function onboardingConsentUrl(value: ConsentResponse, service: "drive" | "gmail"): string {
  const result = consentSchema.safeParse(value);
  if (!result.success) throw new Error("The connection page could not be verified. Try again.");
  const url = new URL(result.data.url);
  if (url.protocol !== "https:" || url.username || url.password
    || (service === "drive" && (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth"))) {
    throw new Error("The connection page could not be verified. Try again.");
  }
  // Gmail may use either configured connector backend. The server supplies
  // its provider URL; only explicit HTTPS navigation is offered by this UI.
  return url.href;
}

export async function prepareOnboardingConsent(service: "drive" | "gmail", signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const path = service === "drive" ? "/api/workspace/google/connect" : "/api/connectors/gmail/authorize";
  return onboardingConsentUrl(await request(path, signal, fetcher, consentSchema, "The connection page could not be verified. Try again.", service === "drive" ? "GET" : "POST"), service);
}
