/**
 * Outbound transactional email — verification links, password resets.
 *
 * Deliberately dependency-free: this talks to Resend's REST API with `fetch`
 * rather than pulling in an SDK. The harness already ships in a packaged
 * Electron app and a Docker image, and a mail SDK would be dead weight in the
 * (overwhelmingly common) desktop case where no mail is ever sent.
 *
 * Three modes, chosen by environment:
 *
 *   RESEND_API_KEY set  → real delivery via Resend
 *   otherwise, dev      → the link is logged to the console so a self-hoster
 *                         can finish a flow without wiring up mail first
 *   otherwise, packaged → disabled; the flows that need it are not offered
 *
 * `isEmailConfigured()` is the switch the auth layer reads to decide whether
 * to advertise verification and password reset at all. Offering a "reset your
 * password" button that silently drops the mail is worse than not offering it.
 *
 * A configured transport can still REFUSE a message — a bad sender address, a
 * revoked key, a provider outage. `deliverEmail` reports that as a typed
 * outcome rather than a bare boolean, because the sign-in code path has to
 * tell the person who asked for a code whether it was actually sent (see
 * server/otp-delivery.ts for why better-auth cannot answer that itself).
 */

import { recordDelivery, recordDeliveryFor, shouldRecordDelivery, type DeliveryOutcome, type OtpCodeType } from "./otp-delivery.ts";

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const EMAIL_FROM = process.env.EMAIL_FROM?.trim() || "Muster <noreply@localhost>";

/** Bound on one provider call. Without it a provider that accepts the
 * connection and then stalls holds the sign-in request open indefinitely,
 * and the user sees a spinner instead of a retry — the same false
 * "still working" as a silent refusal, one layer up. Comfortably above a real
 * API call, far below any client's patience. */
const RESEND_TIMEOUT_MS = 10_000;

/** True when real delivery is possible. */
export function isEmailConfigured(): boolean {
  return Boolean(RESEND_API_KEY);
}

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain-text body. Always sent — some clients and most filters prefer it. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export type { DeliveryOutcome } from "./otp-delivery.ts";

/** The Resend send-message envelope; `html` rides along only for messages
 * that carry an HTML body. */
interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send one message, reporting what actually happened.
 *
 * Never throws: a mail failure must not turn into a 500 on a sign-up request,
 * and Better Auth treats a rejected promise as a failed registration. The
 * typed outcome is how a caller that MUST tell the truth (the sign-in code
 * path) learns the difference between "sent", "the provider refused" and
 * "the request never made it" — a bare boolean collapses all three.
 */
export async function deliverEmail(message: OutboundEmail): Promise<DeliveryOutcome> {
  if (!RESEND_API_KEY) {
    // No transport. Log it so a self-hoster mid-setup can still click through.
    // Only the verification and reset mail reach this branch: the sign-in code
    // returns before it, because there the console channel above IS the
    // delivery and must not be reported as a failure.
    console.warn(
      `[email] RESEND_API_KEY is not set — not sending "${message.subject}" to ${message.to}.\n` +
        `[email] Body:\n${message.text}`,
    );
    return { ok: false, reason: "unconfigured" };
  }

  try {
    const payload: ResendPayload = {
      from: EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    };
    if (message.html) payload.html = message.html;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // The provider's own error body, never the payload: the payload holds
      // the sign-in code, and a rejection reason has no need of it.
      console.error(`[email] Resend rejected the message (${res.status}): ${detail}`);
      return { ok: false, reason: "rejected", status: res.status };
    }
    return { ok: true };
  } catch (error) {
    // A timeout surfaces here as the same AbortError as any other transport
    // fault. The distinction the caller needs is "did not get there", not
    // "why", and both are retryable.
    console.error("[email] transport error:", error instanceof Error ? error.message : error);
    return { ok: false, reason: "transport" };
  }
}

/**
 * Send one message, never throws: a mail failure must not turn into a 500 on
 * a sign-up request, and Better Auth treats a rejected promise as a failed
 * registration. Returns whether it went out, for logging.
 */
export async function sendEmail(message: OutboundEmail): Promise<boolean> {
  return (await deliverEmail(message)).ok;
}

/** Wrap body copy in the plain, deliverable HTML shell used by every message. */
function shell(heading: string, body: string, action?: { href: string; label: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0a0a0a;color:#cfcfd2;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr><td style="padding-bottom:24px;color:#f6f6f7;font-size:19px;font-weight:600;">Muster</td></tr>
      <tr><td style="padding:28px;border:1px solid rgba(255,255,255,0.08);border-radius:20px;background:#131314;">
        <h1 style="margin:0 0 12px;color:#f6f6f7;font-size:22px;font-weight:600;letter-spacing:-0.02em;">${heading}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">${body}</p>
        ${action ? `<a href="${action.href}" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#f0460e;color:#ffffff;font-size:15px;font-weight:500;text-decoration:none;">${action.label}</a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#75757b;">
          If the button does not work, paste this into your browser:<br>
          <span style="color:#98989e;word-break:break-all;">${action.href}</span>
        </p>` : ""}
      </td></tr>
      <tr><td style="padding-top:20px;font-size:12px;color:#75757b;">
        You received this because someone used this address to sign in to Muster.
        If that was not you, you can ignore this message.
      </td></tr>
    </table>
  </body>
</html>`;
}

export async function sendVerificationEmail(to: string, url: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Verify your Muster address",
    text: `Confirm this address to finish setting up your Muster account:\n\n${url}\n\nIf you did not sign up, ignore this message.`,
    html: shell(
      "Verify your address",
      "Confirm this address to finish setting up your Muster account. The link expires in an hour.",
      { href: url, label: "Verify address" },
    ),
  });
}

/**
 * Deliver a 6-digit sign-in one-time code.
 *
 * With no mailer configured (local dev, desktop, CI) the code is printed to
 * the server output under a stable `[otp]` prefix so the flow can be finished
 * without wiring up mail — the same contract verification emails already use.
 * The code itself is never persisted anywhere but the auth database's
 * verification table (stored hashed by Better Auth).
 *
 * Whatever happens to the message is RECORDED against the mailbox, because
 * the caller cannot observe it: better-auth swallows this callback's rejection
 * and still answers the send route with success. See server/otp-delivery.ts.
 * With no mailer configured nothing is recorded, and that is deliberate: the
 * code DID reach its recipient, through the console channel documented above,
 * and the send policy must keep treating that as the success it is. A
 * deployment with no mailer never offers the flow anyway — `emailOtp` is
 * advertised from isEmailConfigured(), so the UI hides email codes entirely.
 *
 * `type` gates the recording, and it has to. The plugin invokes this callback
 * for `email-verification`, `forget-password` and `change-email` codes as
 * well, and several of those routes sit OUTSIDE the send policy —
 * `/email-otp/request-password-reset` is one, and it needs no configuration.
 * A record written for them has no reader, so without this gate the map would
 * gain an entry per address ever mailed a reset or change code, on a server
 * that runs for weeks. Only the sign-in type is recorded, because only the
 * sign-in type has a reader. The union mirrors the plugin's own
 * `sendVerificationOTP` payload.
 *
 * Note what this does NOT rely on: a leaked record cannot be misread as some
 * later send's verdict, because the send policy reads only after delegating,
 * and delegating always calls this sender first — so the verdict it reads is
 * its own. The gate is about retention, not about correctness of attribution.
 */
export async function sendLoginCodeEmail(
  to: string,
  code: string,
  expiresInSeconds: number,
  type: OtpCodeType = "sign-in",
): Promise<void> {
  if (!isEmailConfigured()) {
    console.warn(
      `[otp] sign-in code for ${to}: ${code} — RESEND_API_KEY is not set, so this was not emailed; it is only printed here for local development.`,
    );
    return;
  }
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  const outcome = await deliverEmail({
    to,
    subject: `Your Muster sign-in code: ${code}`,
    text: [
      `Your Muster sign-in code is: ${code}`,
      `It expires in ${minutes} minute${minutes === 1 ? "" : "s"}. Enter it on the sign-in screen to finish signing in.`,
      "Never share this code with anyone. If you did not ask for this code, ignore this message.",
    ].join("\n\n"),
    html: shell(
      "Your sign-in code",
      `Enter this code on the sign-in screen to finish signing in. It expires in ${minutes} minute${minutes === 1 ? "" : "s"}.<br><br><span style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26px;letter-spacing:0.3em;font-weight:600;color:#f6f6f7;background:#1c1c1f;border:1px dashed #3a3a3f;border-radius:10px;padding:10px 14px;">${code}</span>`,
    ),
  });
  // The one and only write, gated to the type the send policy can read.
  if (shouldRecordDelivery(type)) recordDelivery(to, outcome);
}

/**
 * Deliver the reset mail, and REPORT what happened.
 *
 * This used to return nothing and ignore `sendEmail`'s boolean, which is the
 * same defect server/otp-delivery.ts was written to fix for sign-in codes: the
 * outcome is the only honest signal, better-auth's `runInBackgroundOrAwait`
 * swallows any rejection and still answers the route with success, and a
 * server that records it and reports nothing has thrown the only copy away.
 * The record lands on the "password-reset" channel rather than the sign-in
 * one, so a reset verdict can never be read back as a code's.
 *
 * The link this carries is a credential: a token in the URL that sets a
 * password. The body below the link is why the log lines on the
 * unconfigured branch matter — with no transport the message text, reset link
 * included, is written to the server's own output.
 */
export async function sendPasswordResetEmail(to: string, url: string): Promise<DeliveryOutcome> {
  const outcome = await deliverEmail({
    to,
    subject: "Reset your Muster password",
    text: `Use this link to choose a new password:\n\n${url}\n\nThe link expires in an hour. If you did not ask for a reset, ignore this message — your password is unchanged.`,
    html: shell(
      "Reset your password",
      "Use the link below to choose a new password. It expires in an hour. If you did not ask for this, your password is unchanged.",
      { href: url, label: "Choose a new password" },
    ),
  });
  recordDeliveryFor("password-reset", to, outcome);
  return outcome;
}
