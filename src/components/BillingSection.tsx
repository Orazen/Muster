// App settings → Billing. Cloud-only.
//
// Self-hosting is free and unlimited, so on a self-hosted or desktop install
// the API returns 404 and this renders a short "you're self-hosting" note
// instead of a plan picker. No licence key, no locked features — the paid
// product is the hosting, not the software.
import { useCallback, useEffect, useState } from "react";
import { Card } from "./SettingsPrimitives";
import { ExternalLink, Loader2 } from "lucide-react";

interface SubscriptionSummary {
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  quantity: number;
  interval: "month" | "year" | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "self-hosted" }
  | { kind: "unconfigured" }
  | { kind: "ready"; subscription: SubscriptionSummary };

const STATUS_COPY: Record<SubscriptionSummary["status"], string> = {
  active: "Active",
  trialing: "Trial",
  past_due: "Payment failed",
  canceled: "Cancelled",
  none: "No subscription",
};

function formatRenewal(unixSeconds: number | null): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function BillingSection() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/billing/subscription", { credentials: "include" });
      // 404 is the documented "billing is not enabled" answer, not a failure.
      if (res.status === 404) return setState({ kind: "self-hosted" });
      if (!res.ok) throw new Error(`Could not load billing (${res.status})`);

      const data = (await res.json()) as {
        configured: boolean;
        subscription: SubscriptionSummary | null;
      };
      if (!data.configured || !data.subscription) return setState({ kind: "unconfigured" });
      setState({ kind: "ready", subscription: data.subscription });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load billing");
      setState({ kind: "self-hosted" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Both flows hand off to a Stripe-hosted page — no card data touches us. */
  async function go(endpoint: "checkout" | "portal", body?: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/billing/${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not open Stripe");
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open Stripe");
      setBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <Card title="Billing">
        <Loader2 size={16} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  if (state.kind === "self-hosted") {
    return (
      <Card
        title="Billing"
        subtitle="You're self-hosting. Muster is free and unlimited here — no seats, no plan, nothing to pay."
      >
        <div className="text-[13px] leading-relaxed text-ink-secondary">
          Every feature is available on this install. Muster Cloud exists for people who would
          rather not run the computers themselves; it changes nothing about what the software can
          do.
        </div>
      </Card>
    );
  }

  if (state.kind === "unconfigured") {
    return (
      <Card
        title="Billing"
        subtitle="Cloud mode is on, but Stripe isn't configured on this deployment."
      >
        <div className="text-[13px] leading-relaxed text-ink-secondary">
          Set <code className="text-ink">STRIPE_SECRET_KEY</code> and{" "}
          <code className="text-ink">STRIPE_PRICE_MONTHLY</code> to enable checkout. See{" "}
          <code className="text-ink">docs/billing.md</code>.
        </div>
      </Card>
    );
  }

  const { subscription } = state;
  const live = subscription.status === "active" || subscription.status === "trialing";
  const renewal = formatRenewal(subscription.currentPeriodEnd);

  return (
    <Card
      title="Billing"
      subtitle="Cloud computers are metered — the Linux desktops your bots drive. Bots themselves are free and unlimited."
    >
      {error && (
        <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between rounded-lg bg-raised px-3 py-2.5">
          <span className="text-[13px] text-ink-secondary">Status</span>
          <span
            className={
              subscription.status === "past_due"
                ? "text-[13px] font-medium text-danger"
                : "text-[13px] font-medium text-ink"
            }
          >
            {STATUS_COPY[subscription.status]}
          </span>
        </div>

        {live && (
          <>
            <div className="flex items-center justify-between rounded-lg bg-raised px-3 py-2.5">
              <span className="text-[13px] text-ink-secondary">Cloud computers</span>
              <span className="text-[13px] font-medium text-ink">{subscription.quantity}</span>
            </div>
            {renewal && (
              <div className="flex items-center justify-between rounded-lg bg-raised px-3 py-2.5">
                <span className="text-[13px] text-ink-secondary">
                  {subscription.cancelAtPeriodEnd ? "Access ends" : "Renews"}
                </span>
                <span className="text-[13px] font-medium text-ink">{renewal}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {live ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => go("portal")}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            Manage subscription
            <ExternalLink size={13} />
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => go("checkout", { interval: "month", quantity: 1 })}
              className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              Subscribe monthly
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => go("checkout", { interval: "year", quantity: 1 })}
              className="rounded-lg border border-hairline px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-raised disabled:opacity-50"
            >
              Subscribe yearly
            </button>
          </>
        )}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
        Cards, invoices, plan changes and cancellation are all handled by Stripe. Muster never sees
        your card details.
      </p>
    </Card>
  );
}
