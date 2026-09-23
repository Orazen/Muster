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
 */
export async function sendLoginCodeEmail(
  to: string,
  code: string,
  expiresInSeconds: number,
): Promise<void> {
  if (!isEmailConfigured()) {
    console.warn(
      `[otp] sign-in code for ${to}: ${code} — RESEND_API_KEY is not set, so this was not emailed; it is only printed here for local development.`,
    );
    return;
  }
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  await sendEmail({
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
