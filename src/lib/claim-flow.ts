import { z } from "zod";

export type ClaimState =
  | { status: "claiming" | "done" }
  | { status: "error"; message: string; retryable: boolean };

const confirmedClaim = z.object({ ok: z.literal(true) });
const rejectedClaim = z.object({ error: z.string() });

export function parseClaimFragment(fragment: string): { code: string } | { message: string } {
  let fragmentText: string;
  try {
    fragmentText = decodeURIComponent(String(fragment ?? "").replace(/^#/, ""));
  } catch {
    return { message: "This link is damaged. Scan a fresh QR from your computer." };
  }
  // The QR encodes the bare form (#CODE), but a code read off a screen and
  // typed by hand can arrive in the carry shapes the pairing front door
  // documents (src/lib/pairing-link.ts): the keyed form (#code=CODE) and a
  // grouped print (ABCD-EFGH). All normalize to the mint form before the
  // throttled redeem; a wrong string still fails honestly at the endpoint.
  const keyed = new URLSearchParams(fragmentText).get("code");
  let candidate = (keyed ?? fragmentText).trim();
  if (!candidate) return { message: "This link is missing its claim code. Scan a fresh QR from your computer." };
  candidate = candidate.toUpperCase().replace(/-/g, "");
  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(candidate)) {
    return { message: "This claim code is not valid. Scan a fresh QR from your computer." };
  }
  return { code: candidate };
}

/** Retain a single-use redemption across effect cleanup/re-subscription.
 * Unsubscribing must not abort a request the server may already have consumed. */
export class ClaimFlow {
  state: ClaimState;
  private readonly code?: string;
  private request?: Promise<void>;
  private listener?: (state: ClaimState) => void;

  constructor(fragment: string, private readonly transport: typeof fetch = (...args) => fetch(...args)) {
    const parsed = parseClaimFragment(fragment);
    if ("code" in parsed) {
      this.code = parsed.code;
      this.state = { status: "claiming" };
    } else {
      this.state = { status: "error", message: parsed.message, retryable: false };
    }
  }

  subscribe(listener: (state: ClaimState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  start(): Promise<void> {
    if (!this.code) return Promise.resolve();
    if (!this.request) this.request = this.redeem(this.code);
    return this.request;
  }

  retry(): Promise<void> {
    if (this.state.status !== "error" || !this.state.retryable) return this.request ?? Promise.resolve();
    this.request = undefined;
    this.publish({ status: "claiming" });
    return this.start();
  }

  private publish(state: ClaimState) {
    this.state = state;
    this.listener?.(state);
  }

  private async redeem(code: string): Promise<void> {
    try {
      const response = await this.transport("/api/pair/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && confirmedClaim.safeParse(body).success) {
        this.publish({ status: "done" });
      } else if (response.ok) {
        this.publish({ status: "error", retryable: false,
          message: "The server did not confirm this link. Try opening the console, or scan a fresh QR." });
      } else {
        const failure = rejectedClaim.safeParse(body);
        this.publish({ status: "error", retryable: response.status >= 500,
          message: failure.success ? failure.data.error : "This code could not be redeemed. Scan a fresh QR." });
      }
    } catch {
      this.publish({ status: "error", retryable: true,
        message: "Could not reach your server. Check your connection, then try again. If the link was already used, open the console or scan a fresh QR." });
    }
  }
}
