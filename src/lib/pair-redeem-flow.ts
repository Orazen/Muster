import { z } from "zod";

export type PairRedeemState =
  | { status: "idle" | "redeeming" | "done" }
  | { status: "error"; message: string; retryable: boolean };

const confirmedRedeem = z.object({ ok: z.literal(true), email: z.string(), name: z.string() });
const rejectedRedeem = z.object({ error: z.string() });

/** Redeem in this browser a pairing code carried into /pair, swapping it for a
 * session cookie. Unlike the display-only default the page keeps, this runs
 * only on an explicit start(); once started, retain the single redemption
 * across effect cleanup and re-subscription — unsubscribing must not abort a
 * request the server may already have consumed (claim-flow.ts guarantees the
 * same). A confirmed response hard-navigates so the new cookie applies
 * everywhere, not just to this React tree. */
export class PairRedeemFlow {
  state: PairRedeemState;
  private request?: Promise<void>;
  private listener?: (state: PairRedeemState) => void;

  constructor(
    private readonly code: string,
    private readonly transport: typeof fetch = (...args) => fetch(...args),
    private readonly navigate: () => void = () => window.location.replace("/app"),
  ) {
    this.state = { status: "idle" };
  }

  subscribe(listener: (state: PairRedeemState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  start(): Promise<void> {
    if (this.request) return this.request;
    // Published synchronously: the page's button reacts before the first
    // await. ClaimFlow gets this state from its constructor; this flow stays
    // idle until the explicit start.
    this.publish({ status: "redeeming" });
    this.request = this.redeem(this.code);
    return this.request;
  }

  retry(): Promise<void> {
    if (this.state.status !== "error" || !this.state.retryable) return this.request ?? Promise.resolve();
    this.request = undefined;
    return this.start();
  }

  private publish(state: PairRedeemState) {
    this.state = state;
    this.listener?.(state);
  }

  private async redeem(code: string): Promise<void> {
    try {
      const response = await this.transport("/api/pair/redeem-browser", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && confirmedRedeem.safeParse(body).success) {
        this.publish({ status: "done" });
        this.navigate();
        return;
      }
      if (response.ok) {
        // A 200 already consumed the single-use code and set the session
        // cookie, whatever the body says — "try again" would be a doomed
        // instruction. The honest move is to check whether the sign-in
        // actually landed before asking the user to do anything.
        this.publish({ status: "error", retryable: false,
          message: "The sign-in could not be confirmed. The code cannot be used twice — reload the page: if you are signed in, you are done." });
      } else if (response.status === 400) {
        // Invalid, consumed and expired share one remedy — a fresh code — so
        // single-use semantics get one honest message for the whole class.
        this.publish({ status: "error", retryable: false,
          message: "This code isn't valid or has already been used." });
      } else {
        const failure = rejectedRedeem.safeParse(body);
        this.publish({
          status: "error",
          retryable: response.status === 429 || response.status >= 500,
          message: failure.success ? failure.data.error
            : response.status === 429 ? "Too many attempts. Wait a moment, then try again."
            : "This code could not be redeemed right now. Try again.",
        });
      }
    } catch {
      this.publish({ status: "error", retryable: true,
        message: "Could not reach your server. Check your connection, then try again." });
    }
  }
}
