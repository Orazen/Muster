// App settings → Invite & Share: the viral loop's in-app surface.
// One card, two actions — copy your invite link (both sides get Pro days
// when it's redeemed) and share this week's Wrapped as a public link.
import { useEffect, useRef, useState } from "react";
import { Card } from "./SettingsPrimitives";
import { copyShareLink, createWrappedShare, loadReferralInfo, type ReferralInfo } from "@/lib/invite-share";

export function InviteSection() {
  const [referral, setReferral] = useState<ReferralInfo | null>(null);
  const [referralError, setReferralError] = useState("");
  const [referralLoading, setReferralLoading] = useState(true);
  const [referralAttempt, setReferralAttempt] = useState(0);
  const [shareUrl, setShareUrl] = useState("");
  const [shareError, setShareError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [copied, setCopied] = useState<"" | "referral" | "wrapped">("");
  const [busy, setBusy] = useState<"" | "referral" | "wrapped">("");
  const mountedRef = useRef(false);
  const shareRequestRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      shareRequestRef.current?.abort();
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Loading belongs to the mounted section, never the render pass. A tab
  // change aborts the request and prevents its late result changing state.
  useEffect(() => {
    const controller = new AbortController();
    setReferralLoading(true);
    setReferralError("");
    void loadReferralInfo(controller.signal)
      .then((info) => { if (!controller.signal.aborted) setReferral(info); })
      .catch((error) => {
        if (!controller.signal.aborted) setReferralError(error instanceof Error ? error.message : "Could not load your invite link. Try again.");
      })
      .finally(() => { if (!controller.signal.aborted) setReferralLoading(false); });
    return () => controller.abort();
  }, [referralAttempt]);

  function markCopied(kind: "referral" | "wrapped") {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    setCopied(kind);
    copyTimerRef.current = setTimeout(() => setCopied(""), 2000);
  }

  async function shareWrapped(): Promise<void> {
    const controller = new AbortController();
    shareRequestRef.current = controller;
    setBusy("wrapped");
    setShareError("");
    setCopied("");
    try {
      // A clipboard retry reuses the already-created share instead of
      // publishing another copy of the same Wrapped.
      const absolute = shareUrl || await createWrappedShare(window.location.origin, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setShareUrl(absolute);
      await copyShareLink(absolute);
      if (mountedRef.current) markCopied("wrapped");
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) {
        setShareError(error instanceof Error ? error.message : "Could not share your Wrapped. Try again.");
      }
    } finally {
      if (mountedRef.current) setBusy("");
      if (shareRequestRef.current === controller) shareRequestRef.current = null;
    }
  }

  const referralUrl = referral ? `/sign-up?ref=${encodeURIComponent(referral.code)}` : "";

  async function copyReferral(): Promise<void> {
    if (!referral) return;
    setBusy("referral");
    setCopied("");
    setCopyError("");
    try {
      await copyShareLink(new URL(referralUrl, window.location.origin).href);
      if (mountedRef.current) markCopied("referral");
    } catch (error) {
      if (mountedRef.current) setCopyError(error instanceof Error ? error.message : "Could not copy your invite link. Try again.");
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  return (
    <Card
      title="Invite & Share"
      subtitle="Pro days for you and every friend who musters up with your link."
    >
      <div className="space-y-3 text-[13px]">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline/40 px-3 py-2">
          <div className="min-w-0">
            <div className="font-medium text-ink">Your invite link</div>
            <div className="text-[12px] text-ink-secondary">
              {referral ? `+${referral.inviteeDays} Pro days for them, +${referral.inviteeDays} for you` : referralLoading ? <span role="status">Loading invite link…</span> : "Invite link unavailable"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void copyReferral()}
            disabled={!referral || Boolean(busy)}
            className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-semibold text-app disabled:opacity-40"
          >
            {copied === "referral" ? "Copied" : busy === "referral" ? "Copying…" : "Copy link"}
          </button>
        </div>
        {referralError && <div role="alert" className="space-y-2 text-danger">
          <p>{referralError}</p>
          <button type="button" onClick={() => setReferralAttempt((attempt) => attempt + 1)} disabled={referralLoading}
            className="min-h-9 rounded-lg border border-hairline/60 px-3 py-1.5 font-medium text-ink hover:bg-raised disabled:opacity-40">Retry invite link</button>
        </div>}
        {copyError && <p role="alert" className="text-danger">{copyError}</p>}
        {referral && <input aria-label="Invite link" readOnly value={new URL(referralUrl, window.location.origin).href}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink" />}

        {referral && referral.bankedDays > 0 && (
          <div className="text-[12px] text-ink-secondary">
            Banked rewards: <span className="font-medium text-ink">{referral.bankedDays} Pro days</span> from friends who
            joined with your code.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline/40 px-3 py-2">
          <div className="min-w-0">
            <div className="font-medium text-ink">Share your Wrapped</div>
            <div className="text-[12px] text-ink-secondary">A public page with this week's agent receipts.</div>
          </div>
          <button
            type="button"
            onClick={() => void shareWrapped()}
            disabled={Boolean(busy)}
            className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-semibold text-app disabled:opacity-40"
          >
            {copied === "wrapped" ? "Link copied" : busy === "wrapped" ? (shareUrl ? "Copying…" : "Creating…") : shareUrl ? "Copy link" : "Create link"}
          </button>
        </div>
        {shareError && <p role="alert" className="text-danger">{shareError}</p>}
        {shareUrl && <input aria-label="Wrapped link" readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()}
          className="w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink" />}
      </div>
    </Card>
  );
}
