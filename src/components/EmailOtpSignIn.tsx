import { useEffect, useRef, useState, type FormEvent } from "react";
import { authInputCls, authButtonCls } from "./AuthShell";

/** Keep only digits, capped at the six a code contains. A paste of
 * "123 456", "123-456" or an OTP copied with trailing whitespace lands as
 * the bare six digits — the input never has to be cleaned up by hand. */
export function otpDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

/** The error body shape Better Auth and the Muster gates both answer:
 * every field read from it is checked before use, never trusted. The
 * wrapper's send rejections additionally carry `retryAfterSeconds` (S2). */
export interface OtpErrorBody {
  code?: unknown;
  message?: unknown;
  retryAfterSeconds?: unknown;
}

/** True only for primitive strings — the same trick server/http-helpers'
 * isText uses instead of a runtime typeof narrow: JSON decoding is the only
 * source of these values, and String(v) === v holds for strings alone. */
const isStr = <T,>(value: T): value is T & string => String(value) === value;

/** The server's machine-priced wait, clamped to a usable integer: a finite
 * positive number of seconds, fractional values rounded up (a wait must
 * never round a client INTO a retry), strings and junk read as 0 — no
 * countdown, exactly the pre-S2 behaviour. */
export function otpRetryAfterSeconds(body: OtpErrorBody | null | undefined): number {
  const value = body?.retryAfterSeconds;
  if (value === null || value === undefined || isStr(value)) return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(seconds);
}

/** Map a server error body to what the user should read. The server answers
 * Better Auth plugin errors as { message, code } and Muster gate errors in
 * the same shape; anything unrecognised falls back to the server's own
 * message, then to `fallback`. 429 codes prefer the server's own copy (it
 * quotes the wait) and only fall back to a seconds-aware line. */
export function otpErrorMessage(body: OtpErrorBody | null | undefined, fallback: string): string {
  const record = body ?? {};
  const code = isStr(record.code) ? record.code : "";
  const seconds = otpRetryAfterSeconds(record);
  switch (code) {
    case "OTP_EXPIRED":
      return "That code expired. Request a new one.";
    case "INVALID_OTP":
      return "That code isn’t right. Check the latest code and try again.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many attempts. Request a new code.";
    case "RESEND_COOLDOWN":
      if (isStr(record.message) && record.message) return record.message;
      return seconds > 0
        ? `A code was just sent. Wait ${seconds} seconds before requesting another.`
        : "A code was just sent. Wait a moment before requesting another.";
    case "RATE_LIMITED":
      return seconds > 0
        ? `Too many code requests. Please wait ${seconds} seconds and try again.`
        : "Too many code requests. Please wait and try again.";
    case "SIGNUPS_CLOSED":
      return "Sign-ups are closed on this deployment.";
    case "GOOGLE_ONLY_SIGNUP":
      return "Sign up with Google — manual sign-up is turned off on this deployment.";
    case "INVALID_EMAIL":
      return "Enter a valid email address.";
    default:
      break;
  }
  if (isStr(record.message) && record.message) return record.message;
  return fallback;
}

/** Copy for a failed send whose body carried nothing usable: a 429 quotes
 * the priced wait when the server sent seconds (the wrapper always does;
 * a bare plugin 429 has none), anything else gets the generic send-failed
 * line. The old bare-429 "wait a minute" guess is gone — the wait is the
 * server's to price, not ours to assume. */
export function otpSendFallback(status: number, seconds: number): string {
  if (status !== 429) return "Could not send the code. Please try again.";
  if (seconds > 0) return `Too many code requests. Please wait ${seconds} seconds and try again.`;
  return "Too many code requests. Please wait and try again.";
}

/** One send attempt's answer — what post() (and any test double) returns. */
export interface OtpPostResult {
  ok: boolean;
  status: number;
  json: OtpErrorBody | null;
}

export type OtpPost = (
  path: string,
  body: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<OtpPostResult>;

const OTP_SEND_ROUTE = "/api/auth/email-otp/send-verification-otp";

/** One user-initiated send: exactly one request carrying the caller's
 * Idempotency-Key, retried ONCE only when the transport itself throws —
 * with the SAME key, so the server replays the accepted response instead
 * of double-sending or tripping the cooldown (study §5 S3). An answered
 * response (4xx/5xx included) is returned as-is: the server priced that
 * wait, and retrying it would only burn the window. */
export async function attemptOtpSend(post: OtpPost, email: string, key: string): Promise<OtpPostResult> {
  const payload = { email, type: "sign-in" };
  const headers = { "idempotency-key": key };
  try {
    return await post(OTP_SEND_ROUTE, payload, headers);
  } catch {
    return post(OTP_SEND_ROUTE, payload, headers);
  }
}

/** One key per user-initiated attempt — randomUUID with the house fallback
 * (composer-attachments' newId pattern) for contexts lacking it. */
export function newOtpIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `otp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The second stage as its own presentational form: the six-digit input and
 * its resend/back controls. Exported so the SSR contract tests can pin the
 * autofill and paste attributes without driving the two-stage state machine. */
export function EmailOtpCodeForm(props: {
  email: string;
  code: string;
  busy: boolean;
  error: string;
  /** Seconds left before another send is allowed; 0 = resend available. */
  resendIn: number;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
  onResend: () => void;
  onBack: () => void;
}) {
  const { email, code, busy, error, resendIn, onCodeChange, onSubmit, onResend, onBack } = props;
  return (
    <form
      className="auth-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!busy && code.length === 6) onSubmit();
      }}
    >
      <p className="auth-hint">
        We sent a 6-digit code to <strong>{email}</strong>. It expires in 10 minutes —
        check your inbox (it may take a minute).
      </p>
      <div>
        <label htmlFor="otp-code" className="auth-label">6-digit code</label>
        <input
          id="otp-code"
          name="one-time-code"
          // The three attributes iOS/Android/macOS need to offer the code
          // from the mail as an autofill suggestion, plus paste-as-six-digits.
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(event) => onCodeChange(otpDigits(event.target.value))}
          onPaste={(event) => {
            event.preventDefault();
            onCodeChange(otpDigits(event.clipboardData.getData("text")));
          }}
          disabled={busy}
          placeholder="123456"
          aria-describedby={error ? "otp-code-error" : undefined}
          className={authInputCls}
          style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.45em" }}
        />
      </div>
      {error && (
        <div className="auth-notice auth-error" role="alert" id="otp-code-error">
          {error}
        </div>
      )}
      <button type="submit" disabled={busy || code.length !== 6} className={authButtonCls}>
        {busy ? "Verifying…" : "Verify and sign in"}
      </button>
      <div className="auth-recovery">
        <button type="button" className="auth-link" onClick={onBack} disabled={busy}>
          Use a different email
        </button>
        <span aria-hidden="true"> · </span>
        <button type="button" className="auth-link" onClick={onResend} disabled={busy || resendIn > 0}>
          {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
        </button>
      </div>
    </form>
  );
}

/** Two-stage email one-time-code sign-in: address → send → six digits →
 * verify. Additive — the other sign-in methods on the page are untouched,
 * and success lands exactly where the pairing path lands (a hard navigation
 * that picks the fresh session cookie up like every other method). */
export function EmailOtpSignIn({ next }: { next: string }) {
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mailboxDeadlines = useRef(new Map<string, number>());
  const globalDeadline = useRef(0);
  const submitting = useRef(false);
  const [now, setNow] = useState(Date.now);
  const mailbox = email.trim().toLowerCase();
  const resendIn = Math.max(0, Math.ceil((Math.max(
    mailboxDeadlines.current.get(mailbox) ?? 0, globalDeadline.current,
  ) - now) / 1000));

  // Mailbox cooldowns survive editing/backtracking without blocking a corrected
  // address. A server-wide rate limit still applies to every address.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  function armCooldown(seconds: number, global = false) {
    const time = Date.now();
    if (global) globalDeadline.current = time + seconds * 1000;
    else mailboxDeadlines.current.set(mailbox, time + seconds * 1000);
    setNow(time);
  }

  async function post(path: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<OtpPostResult> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    // Any-typed at the I/O boundary on purpose: otpErrorMessage reads only
    // the optional code/message/retryAfterSeconds fields and checks each
    // before use.
    const json: OtpErrorBody | null = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  }

  async function sendCode(target = email) {
    if (submitting.current || resendIn > 0) return;
    submitting.current = true;
    setError("");
    setBusy(true);
    try {
      const result = await attemptOtpSend(post, target.trim(), newOtpIdempotencyKey());
      if (!result.ok) {
        const seconds = otpRetryAfterSeconds(result.json);
        setError(otpErrorMessage(result.json, otpSendFallback(result.status, seconds)));
        // Arm the resend countdown from the server's own seconds (S2) —
        // every wrapper 429 carries them; a bare answer arms nothing new.
        if (seconds > 0) armCooldown(seconds, result.json?.code !== "RESEND_COOLDOWN");
        return;
      }
      setStage("code");
      setCode("");
      armCooldown(60);
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function verify() {
    if (submitting.current || code.length !== 6) return;
    submitting.current = true;
    setError("");
    setBusy(true);
    try {
      const result = await post("/api/auth/sign-in/email-otp", {
        email: email.trim(),
        otp: code,
        // Only read when the verify creates the account (first-time sign-in);
        // ignored for existing users, same as Better Auth's own contract.
        name: email.trim().split("@")[0],
      });
      if (!result.ok) {
        setError(otpErrorMessage(result.json, "That code could not be verified. Please try again."));
        return;
      }
      // The session cookie is set — reload auth state the same way the
      // pairing path does.
      window.location.href = next;
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (stage === "code") {
    return (
      <EmailOtpCodeForm
        email={email.trim()}
        code={code}
        busy={busy}
        error={error}
        resendIn={resendIn}
        onCodeChange={(value) => {
          setCode(value);
          if (error) setError("");
        }}
        onSubmit={() => void verify()}
        onResend={() => {
          if (!submitting.current && resendIn <= 0) void sendCode();
        }}
        onBack={() => {
          if (submitting.current) return;
          setStage("email");
          setCode("");
          setError("");
        }}
      />
    );
  }

  return (
    <form
      className="auth-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!busy && email.trim()) void sendCode();
      }}
    >
      <div>
        <label htmlFor="otp-email" className="auth-label">Email address for a sign-in code</label>
        <input
          id="otp-email"
          disabled={busy}
          name="email"
          type="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError("");
          }}
          placeholder="you@example.com"
          autoComplete="email"
          className={authInputCls}
        />
      </div>
      {error && (
        <div className="auth-notice auth-error" role="alert">
          {error}
        </div>
      )}
      <button type="submit" disabled={busy || resendIn > 0} className={authButtonCls}>
        {busy ? "Sending…" : resendIn > 0 ? `Try again in ${resendIn}s` : "Email me a code"}
      </button>
      <p className="auth-hint">
        We’ll email a 6-digit sign-in code. No password to remember.
      </p>
    </form>
  );
}
