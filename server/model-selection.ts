// The engine a brand-new bot is born onto. Pure so the rule is unit-testable;
// index.ts's defaultSelection() supplies the described fleet and the per-user
// scoping, this module owns only the pick.
//
// The rule mirrors the first-run wizard's engineReady (Onboarding.tsx):
// an installed CLI with expired auth (`authenticated === false`) answers
// every send with "Failed to authenticate: OAuth session expired…" — the
// worst first-run, reproduced live (the wizard listed Droid/Antigravity as
// READY while the seed bot was born onto an expired Claude). Signed-in
// engines therefore outrank an unsigned-in preferred driverKind. When
// nothing is signed in, the legacy pick stands: an installed engine still
// beats an empty selection, and signing in fixes the bot with no surgery.

export interface SeedCandidate {
  instanceId: string;
  driverKind: string;
  models: { default: string };
  snapshot: { state: "available" | "unavailable"; authenticated?: boolean };
}

export interface SeedSelection {
  instanceId: string;
  model: string;
}

const preferred = (pool: SeedCandidate[]): SeedCandidate | undefined =>
  pool.find((d) => d.driverKind === "claudeAgent") ?? pool[0];

export function pickSeedEngine(available: SeedCandidate[]): SeedSelection {
  const signedIn = available.filter((d) => d.snapshot.authenticated !== false);
  const pick = preferred(signedIn) ?? preferred(available);
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}
