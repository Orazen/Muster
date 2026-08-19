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
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const EMAIL_FROM = process.env.EMAIL_FROM?.trim() || "Muster <noreply@localhost>";

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

/**
 * Send one message. Never throws: a mail failure must not turn into a 500 on
 * a sign-up request, and Better Auth treats a rejected promise as a failed
 * registration. Returns whether it went out, for logging.
 */
export async function sendEmail(message: OutboundEmail): Promise<boolean> {
  if (!RESEND_API_KEY) {
    // No transport. Log it so a self-hoster mid-setup can still click through.
    console.warn(
      `[email] RESEND_API_KEY is not set — not sending "${message.subject}" to ${message.to}.\n` +
        `[email] Body:\n${message.text}`,
    );
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] Resend rejected the message (${res.status}): ${detail}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] transport error:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** Wrap body copy in the plain, deliverable HTML shell used by every message. */
function shell(heading: string, body: string, action: { href: string; label: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0a0a0a;color:#cfcfd2;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr><td style="padding-bottom:24px;color:#f6f6f7;font-size:19px;font-weight:600;">Muster</td></tr>
      <tr><td style="padding:28px;border:1px solid rgba(255,255,255,0.08);border-radius:20px;background:#131314;">
        <h1 style="margin:0 0 12px;color:#f6f6f7;font-size:22px;font-weight:600;letter-spacing:-0.02em;">${heading}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;">${body}</p>
        <a href="${action.href}" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#f0460e;color:#ffffff;font-size:15px;font-weight:500;text-decoration:none;">${action.label}</a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#75757b;">
          If the button does not work, paste this into your browser:<br>
          <span style="color:#98989e;word-break:break-all;">${action.href}</span>
        </p>
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

export async function sendPasswordResetEmail(to: string, url: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Reset your Muster password",
    text: `Use this link to choose a new password:\n\n${url}\n\nThe link expires in an hour. If you did not ask for a reset, ignore this message — your password is unchanged.`,
    html: shell(
      "Reset your password",
      "Use the link below to choose a new password. It expires in an hour. If you did not ask for this, your password is unchanged.",
      { href: url, label: "Choose a new password" },
    ),
  });
}
