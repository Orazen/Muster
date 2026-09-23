import { useEffect, useRef, useState, type FormEvent } from "react";
import { authInputCls, authButtonCls } from "./AuthShell";

/** Keep only digits, capped at the six a code contains. A paste of
 * "123 456", "123-456" or an OTP copied with trailing whitespace lands as
 * the bare six digits — the input never has to be cleaned up by hand. */
export function otpDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

/** The error body shape Better Auth and the Muster gates both answer:
 * every field read from it is checked before use, never trusted. */
export interface OtpErrorBody {
  code?: unknown;
  message?: unknown;
}

/** True only for primitive strings — the same trick server/http-helpers'
 * isText uses instead of a runtime typeof narrow: JSON decoding is the only
 * source of these values, and String(v) === v holds for strings alone. */
const isStr = <T,>(value: T): value is T & string => String(value) === value;

/** Map a server error body to what the user should read. The server answers
 * Better Auth plugin errors as { message, code } and Muster gate errors in
 * the same shape; anything unrecognised falls back to the server's own
 * message, then to `fallback`. */
export function otpErrorMessage(body: OtpErrorBody | null | undefined, fallback: string): string {
  const record = body ?? {};
  const code = isStr(record.code) ? record.code : "";
  switch (code) {
    case "OTP_EXPIRED":
      return "That code expired. Request a new one.";
    case "INVALID_OTP":
      return "That code isn’t right. Check the latest code and try again.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many attempts. Request a new code.";
    case "RESEND_COOLDOWN":
      return isStr(record.message) ? record.message : "A code was just sent. Wait a moment before requesting another.";
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
  const [resendIn, setResendIn] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resend cooldown ticker — mirrors the server's 60s per-mailbox cooldown
  // so the button rarely gets to show a server-side "already sent" answer.
  useEffect(() => {
    if (resendIn <= 0) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => setResendIn((seconds) => (seconds <= 1 ? 0 : seconds - 1)), 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [resendIn]);

  async function post(path: string, body: Record<string, string>): Promise<{ ok: boolean; status: number; json: OtpErrorBody | null }> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // Any-typed at the I/O boundary on purpose: otpErrorMessage reads only
    // the optional code/message fields and checks both before use.
    const json: OtpErrorBody | null = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  }

  async function sendCode(target = email) {
    setError("");
    setBusy(true);
    try {
      const result = await post("/api/auth/email-otp/send-verification-otp", {
        email: target.trim(),
        type: "sign-in",
      });
      if (!result.ok) {
        // 429 with no cooldown code is Better Auth's per-IP window.
        setError(
          otpErrorMessage(
            result.json,
            result.status === 429 ? "Too many code requests. Please wait a minute and try again." : "Could not send the code. Please try again.",
          ),
        );
        return;
      }
      setStage("code");
      setCode("");
      setResendIn(60);
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
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
          if (resendIn <= 0) void sendCode();
        }}
        onBack={() => {
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
      <button type="submit" disabled={busy} className={authButtonCls}>
        {busy ? "Sending…" : "Email me a code"}
      </button>
      <p className="auth-hint">
        We’ll send a 6-digit code — no password needed. New addresses get an account
        created on first sign-in.
      </p>
    </form>
  );
}
