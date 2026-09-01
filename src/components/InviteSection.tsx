// App settings → Invite & Share: the viral loop's in-app surface.
// One card, two actions — copy your invite link (both sides get Pro days
// when it's redeemed) and share this week's Wrapped as a public link.
import { useState } from "react";
import { Card } from "./SettingsPrimitives";

interface ReferralInfo {
  code: string;
  bankedDays: number;
  inviteeDays: number;
}

export function InviteSection() {
  const [referral, setReferral] = useState<ReferralInfo | null>(null);
  const [referralError, setReferralError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState<"" | "referral" | "wrapped">("");
  const [busy, setBusy] = useState(false);

  async function loadReferral(): Promise<void> {
    setReferralError("");
    try {
      const r = await fetch("/api/referral/code");
      if (!r.ok) {
        setReferralError((await r.json().catch(() => ({ error: "unavailable" }))).error ?? "unavailable");
        return;
      }
      setReferral(await r.json());
    } catch {
      setReferralError("could not reach the server");
    }
  }

  async function shareWrapped(): Promise<void> {
    setBusy(true);
    try {
      const r = await fetch("/api/wrapped/share", { method: "POST" });
      if (!r.ok) return;
      // SAFETY: the share route's 200 body is exactly {url: string} — its
      // only documented shape.
      const body = (await r.json()) as { url: string };
      const absolute = `${window.location.origin}${body.url}`;
      setShareUrl(absolute);
      await navigator.clipboard.writeText(absolute).catch(() => {});
      setCopied("wrapped");
      setTimeout(() => setCopied(""), 2000);
    } finally {
      setBusy(false);
    }
  }

  function copyReferral(): void {
    if (!referral) return;
    const link = `${window.location.origin}/sign-up?ref=${referral.code}`;
    void navigator.clipboard.writeText(link).catch(() => {});
    setCopied("referral");
    setTimeout(() => setCopied(""), 2000);
  }

  // Load on first expand — the section mounts only when its settings tab is
  // open, so this runs once per visit rather than on app boot.
  if (!referral && !referralError) void loadReferral();

  return (
    <Card
      title="Invite & Share"
      subtitle="Pro days for you and every friend who musters up with your link."
    >
      <div className="space-y-3 text-[13px]">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline/40 px-3 py-2">
          <div className="min-w-0">
            <div className="font-medium text-ink">Your invite link</div>
            <div className="truncate text-[12px] text-ink-secondary">
              {referral ? `+${referral.inviteeDays} Pro days for them, +${referral.inviteeDays} for you` : referralError || "loading…"}
            </div>
          </div>
          <button
            type="button"
            onClick={copyReferral}
            disabled={!referral}
            className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-semibold text-app disabled:opacity-40"
          >
            {copied === "referral" ? "Copied" : "Copy link"}
          </button>
        </div>

        {referral && referral.bankedDays > 0 && (
          <div className="text-[12px] text-ink-secondary">
            Banked rewards: <span className="font-medium text-ink">{referral.bankedDays} Pro days</span> from friends who
            joined with your code.
          </div>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline/40 px-3 py-2">
          <div className="min-w-0">
            <div className="font-medium text-ink">Share your Wrapped</div>
            <div className="text-[12px] text-ink-secondary">A public page with this week's agent receipts.</div>
          </div>
          <button
            type="button"
            onClick={() => void shareWrapped()}
            disabled={busy}
            className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-semibold text-app disabled:opacity-40"
          >
            {copied === "wrapped" ? "Link copied" : busy ? "Creating…" : "Create link"}
          </button>
        </div>
        {shareUrl && <div className="truncate text-[12px] text-ink-secondary">{shareUrl}</div>}
      </div>
    </Card>
  );
}
