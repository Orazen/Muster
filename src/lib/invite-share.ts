import { z } from "zod";

const referralSchema = z.object({
  code: z.string().min(1),
  bankedDays: z.number().int().nonnegative(),
  inviteeDays: z.number().int().nonnegative(),
});

export type ReferralInfo = z.infer<typeof referralSchema>;

async function request(path: string, signal: AbortSignal, method = "GET") {
  signal.throwIfAborted();
  return fetch(path, { method, signal, credentials: "include" }).catch(() => {
    signal.throwIfAborted();
    throw new Error("Cannot reach Muster. Check your connection and try again.");
  });
}

export async function loadReferralInfo(signal: AbortSignal): Promise<ReferralInfo> {
  const response = await request("/api/referral/code", signal);
  if (!response.ok) throw new Error(`Could not load your invite link (HTTP ${response.status}). Try again.`);
  const parsed = referralSchema.safeParse(await response.json().catch(() => null));
  signal.throwIfAborted();
  if (!parsed.success) throw new Error("Muster returned an invalid invite link. Try again.");
  return parsed.data;
}

const wrappedSchema = z.object({ url: z.string().regex(/^\/w\/[A-Za-z0-9_-]{16,32}$/) });

export async function createWrappedShare(origin: string, signal: AbortSignal): Promise<string> {
  const response = await request("/api/wrapped/share", signal, "POST");
  if (!response.ok) throw new Error(`Could not create your Wrapped link (HTTP ${response.status}). Try again.`);
  const parsed = wrappedSchema.safeParse(await response.json().catch(() => null));
  signal.throwIfAborted();
  if (!parsed.success) throw new Error("Muster returned an invalid Wrapped link. Try again.");
  return new URL(parsed.data.url, origin).href;
}

export async function copyShareLink(link: string): Promise<void> {
  if (!globalThis.navigator?.clipboard) {
    throw new Error("Clipboard unavailable. Select the link below and copy it.");
  }
  await navigator.clipboard.writeText(link).catch(() => {
    throw new Error("Could not copy the link. Select it below or try again.");
  });
}
