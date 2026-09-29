// Did the password-reset mail actually LEAVE the building?
//
// The same question server/otp-delivery.ts asks about sign-in codes, with the
// same answer: it cannot be read off the HTTP response, because better-auth
// stores the token and then awaits `sendResetPassword` through
// `runInBackgroundOrAwait`, which catches a rejection, logs it, and still
// resolves (node_modules/better-auth/dist/context/create-context.mjs:215).
// `/request-password-reset` therefore answered 200
// `{"status":true,"message":"If this email exists in our system…"}` whether
// the provider accepted the message, refused it, or was never reached.
//
// The cost of that answer is not only the missing error. A "check your inbox"
// page that never sent anything is the failure mode server/email.ts's own
// header calls worse than not offering the flow at all — and the person who
// asked cannot tell it from the one case where it did work, so they wait out
// an hour of token lifetime for a link that will never arrive.
//
// What this wrapper does NOT do is report a per-mailbox verdict as a status.
// That is the trap in this route specifically. better-auth attempts no send at
// all for an address with no account, so a 503 raised from a recorded verdict
// would fire for registered addresses and not for unregistered ones — an
// account-existence oracle, on the one page in the product whose copy is
// explicitly written to refuse one (src/pages/ForgotPasswordPage.tsx). The
// refusal below is therefore gated on the DEPLOYMENT's transport health
// (mailTransportFailing), which knows nothing about which address asked:
// while the mailer is refusing, every reset request gets the same answer, and
// an address with no account is refused identically to one that has.
//
// The residual is one request per outage. The request that first observes a
// failing send is answered 503 because refusing to tell that person the truth
// is the defect being fixed; every request after it — registered address or
// not — is answered the same way without consulting the mailbox at all.

import type { IncomingMessage, ServerResponse } from "node:http";

import { auth, forwardedProtoOf } from "./auth.ts";
import { isText, readBody } from "./http-helpers.ts";
import {
  clearDeliveryFor,
  deliveryOutcomeFor,
  mailTransportFailing,
  type DeliveryFailure,
} from "./otp-delivery.ts";
import { parseJson, type JsonObject } from "./schema.ts";

export const PASSWORD_RESET_PATH = "/api/auth/request-password-reset";

/** The Better Auth route this wrapper owns. Nothing else here is touched:
 * the token-consuming POST /reset-password and the emailOTP plugin's
 * /email-otp/request-password-reset are separate flows with separate
 * senders. */
export function isPasswordResetAuthPath(path: string): boolean {
  return path === PASSWORD_RESET_PATH;
}

/** How long a client is told to wait after the mail provider refused. A
 * HINT, not a lock, and deliberately identical to the sign-in code's
 * DELIVERY_RETRY_SECONDS in server/email-otp-login.ts: the remedy is the same
 * one sentence in both places. */
const DELIVERY_RETRY_SECONDS = 20;

/** The receipt a refused send gets. Uniform with the sign-in send's
 * EMAIL_DELIVERY_FAILED, and deliberately uninformative about the provider —
 * a requester learns that no mail went out and may try again, and which
 * vendor refused it belongs in the server log where deliverEmail puts it. */
// Inferred (not annotated): the object literal's own type is the contract.
function deliveryRejection(failure: DeliveryFailure) {
  return {
    message:
      failure.reason === "unconfigured"
        ? "Email is not available on this deployment, so no reset link was sent."
        : failure.reason === "transport"
          ? "We could not reach the mail service. Please try again in a moment."
          : "We could not send your reset link. Please try again in a moment.",
    code: "EMAIL_DELIVERY_FAILED",
  };
}

/** Write the refusal: the JSON body plus `retry-after`/`x-retry-after`, so a
 * client can arm a countdown from the rejection without parsing copy. Same
 * shape and same writer as the sign-in send's rejectSend, so the two mail
 * routes answer a client identically. */
function rejectDelivery(res: ServerResponse, failure: DeliveryFailure): void {
  const data = JSON.stringify({ ...deliveryRejection(failure), retryAfterSeconds: DELIVERY_RETRY_SECONDS });
  res.writeHead(503, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(data)),
    "retry-after": String(DELIVERY_RETRY_SECONDS),
    "x-retry-after": String(DELIVERY_RETRY_SECONDS),
  });
  res.end(data);
}

/** Relay a delegated response back verbatim — status, headers, body — with
 * set-cookie kept apart (Headers.forEach comma-joins repeats, and a comma
 * can legally appear inside an Expires attribute). */
function relay(res: ServerResponse, delegated: { status: number; headers: Headers; body: string }): void {
  const headers: Record<string, string | string[]> = {};
  delegated.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  const setCookies = delegated.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;
  res.writeHead(delegated.status, headers);
  res.end(delegated.body);
}

/** Replay the parsed body to Better Auth through the same auth.handler the
 * normal delegation uses — the cloud-bridge and sign-up-gate paths in
 * server/index.ts do exactly this, because readBody has already consumed the
 * request stream. An Origin is synthesized when absent for the same reason
 * they do: Better Auth's CSRF check treats a missing Origin as untrusted. */
async function delegate(
  req: IncomingMessage,
  body: JsonObject,
): Promise<{ status: number; headers: Headers; body: string }> {
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", `${forwardedProtoOf(req)}://${host}`);
  const authRes = await auth.handler(
    new Request(`${forwardedProtoOf(req)}://${host}${PASSWORD_RESET_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    }),
  );
  return { status: authRes.status, headers: authRes.headers, body: await authRes.text() };
}

/** Entry point for POST /api/auth/request-password-reset, called from
 * server/index.ts before the generic Better Auth delegation. */
export async function handlePasswordResetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: JsonObject;
  try {
    // Parsed rather than cast: readBody answers `any`, and this wrapper both
    // reads `email` off it and re-serializes it into the delegated request, so
    // a non-object body has to be a typed rejection rather than an assumption.
    // An empty body is a legitimate request here (the route answers 400 from
    // Better Auth's own schema), so it becomes an empty object.
    const raw = parseJson(JSON.stringify((await readBody(req)) ?? {}));
    body = raw instanceof Object && !Array.isArray(raw) ? raw : {};
  } catch (error) {
    // SAFETY: readBody and parseJson rejections are Errors; the status is the
    // HTTP one readBody attaches via Object.assign at its size-limit
    // rejection site, defaulting to 400 for a parse failure that has none.
    const status = (error as { status?: number }).status ?? 400;
    return relay(res, {
      status,
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ message: error instanceof Error ? error.message : String(error), code: "INVALID_REQUEST" }),
    });
  }

  // The same normalized mailbox the sender keys its record by, so the verdict
  // this reads is its own. Better Auth lowercases internally; the wrapper
  // trims, which deliveryKey absorbs.
  const email = isText(body?.email) ? String(body.email) : "";
  const delegated = await delegate(req, body);
  if (delegated.status >= 200 && delegated.status < 300) {
    const outcome = email ? deliveryOutcomeFor("password-reset", email) : undefined;
    if (email) clearDeliveryFor("password-reset", email);
    if (outcome && !outcome.ok) return rejectDelivery(res, outcome);
    // Undefined means no send was attempted — better-auth short-circuits an
    // address with no account and never calls the sender. That is not a
    // failure, and on its own it relays the same 200 every address gets.
    //
    // It is not left at that unconditionally. While the server is
    // demonstrably refusing every message it sends, an address with no
    // account deserves the same answer as one that has — otherwise the status
    // alone answers "is this address registered?", which is the oracle
    // src/pages/ForgotPasswordPage.tsx exists to prevent. The gate is the
    // deployment's transport, which knows nothing about the address, so both
    // get the same 503 and the question has no answer in it.
    //
    // This runs AFTER the delegation on purpose. Refusing before it would stop
    // the attempt that clears the mark, and a transport that had recovered
    // would never be observed recovering — the failure would latch.
    if (!outcome && mailTransportFailing()) {
      return rejectDelivery(res, { ok: false, reason: "transport" });
    }
  }
  return relay(res, delegated);
}
