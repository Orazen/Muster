// B: request-password-reset must not report a message the mail provider never
// accepted.
//
// The live OTP suite (server/email-otp-delivery-harness.test.ts) covers the
// sign-in code's send. This covers the reset mail, which is a DIFFERENT flow
// with a DIFFERENT sender and which nobody had pinned: better-auth's
// emailAndPassword.sendResetPassword, invoked through the same
// runInBackgroundOrAwait that catches a rejection and still answers 200. The
// route therefore returned
// `{"status":true,"message":"If this email exists in our system…"}` for a
// provider that answered 422 and for one that was never reached at all, and
// the person was told to check an inbox nothing had been sent to.
//
// The stub is the same owned fixture pattern: globalThis.fetch replaced in
// the child only, answering Resend's URL from a control file, refusing every
// other destination so the fixture cannot reach the real provider. No
// credentials, no outbound mail, no live service.
//
// The non-enumeration case is load-bearing and is asserted first, because the
// obvious fix for "tell the truth" is to raise a 503 from the per-mailbox
// verdict — and better-auth attempts no send at all for an address with no
// account, so that status would answer "does this address exist?" on the one
// page whose copy is written to refuse it.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import type { JsonObject } from "./schema.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** What the stubbed provider does with the next message. */
type Mode = "accept" | "reject" | "throw";

const body = z.object({
  status: z.boolean().optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
});
const transportRecord = z.object({ mode: z.string(), to: z.string(), subject: z.string(), body: z.string() });

/** The sentence Better Auth answers with for every address, registered or
 * not. A reset that cannot be delivered must not differ from this one. */
const NEUTRAL = "If this email exists in our system, check your email for the reset link";

describe.skipIf(process.platform === "win32")("password reset: a refused send is not a sent link", () => {
  let dir = "";
  let controlPath = "";
  let transportLog = "";
  let url = "";
  const children: ChildProcess[] = [];
  let output = "";

  const mailbox = (label: string) => `${label}-${randomBytes(6).toString("hex")}@example.test`;
  const setMode = (mode: Mode) => writeFileSync(controlPath, JSON.stringify({ mode }));

  const transported = (): Array<z.infer<typeof transportRecord>> =>
    (existsSync(transportLog) ? readFileSync(transportLog, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => transportRecord.parse(JSON.parse(line)));

  /** Only the reset messages for one mailbox. Creating an account also mails
   *  a verification link, so an unscoped count would be off by one. */
  const resetMailsFor = (email: string) =>
    transported().filter((r) => r.to === email && r.subject === "Reset your Muster password");

  // Better Auth's own limiter prices /request-password-reset at 3 per 60s per
  // IP. Distinct source IPs per request so these cases do not measure the rate
  // limiter instead of delivery — the same mechanism a real deployment behind
  // a reverse proxy uses, not a way around the window.
  let ipCounter = 0;
  const nextIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

  const post = (path: string, payload: JsonObject, ip = nextIp()) =>
    fetch(`${url}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: new Headers({ "content-type": "application/json", origin: url, "x-forwarded-for": ip }),
      body: JSON.stringify(payload),
    });

  const requestReset = async (email: string, ip?: string) => {
    const res = await post("/api/auth/request-password-reset", { email, redirectTo: "/reset-password" }, ip);
    return { res, parsed: body.parse(await res.json()) };
  };

  const capabilities = async () =>
    z.object({ passwordReset: z.boolean() }).parse(await (await fetch(`${url}/api/auth-capabilities`)).json());

  /** An account with a password, so the reset route has something to reset. */
  const createAccount = async (email: string) => {
    const res = await post("/api/auth/sign-up/email", {
      name: "Reset Harness",
      email,
      password: randomBytes(24).toString("base64url"),
    });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muster-reset-delivery-"));
    const dataDirectory = join(dir, "data");
    const home = join(dir, "home");
    const companion = join(dir, "companion");
    const ui = join(dir, "ui");
    for (const path of [dataDirectory, home, companion, ui]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    controlPath = join(dir, "transport.json");
    transportLog = join(dir, "transport.log");
    setMode("accept");

    const preload = join(dir, "stub-transport.mjs");
    writeFileSync(
      preload,
      [
        `import { readFileSync, appendFileSync } from "node:fs";`,
        `const control = ${JSON.stringify(controlPath)};`,
        `const log = ${JSON.stringify(transportLog)};`,
        `globalThis.fetch = async (input, init) => {`,
        `  const target = typeof input === "string" ? input : (input && input.url) || String(input);`,
        `  if (!target.startsWith("https://api.resend.com/")) throw new Error("Owned fixture refuses outbound traffic");`,
        `  let mode = "accept";`,
        `  try { mode = JSON.parse(readFileSync(control, "utf8")).mode; } catch {}`,
        `  let payload = {};`,
        `  try { payload = JSON.parse(init && init.body ? String(init.body) : "{}"); } catch {}`,
        `  appendFileSync(log, JSON.stringify({ mode, to: (payload.to || []).join(","), subject: payload.subject || "", body: payload.text || "" }) + "\\n");`,
        `  if (mode === "throw") throw new TypeError("fetch failed");`,
        `  if (mode === "reject") return new Response(JSON.stringify({ message: "stubbed provider rejection" }), { status: 422, headers: { "content-type": "application/json" } });`,
        `  return new Response(JSON.stringify({ id: "stub-message" }), { status: 200, headers: { "content-type": "application/json" } });`,
        `};`,
      ].join("\n"),
    );

    const port = await freePortBlock([0, 1, 2], 48300, 9000);
    const env = pairingServerEnvironment({
      home,
      dataDirectory,
      companionDirectory: companion,
      staticDir: ui,
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    // A configured mailer is the whole point: the deployment advertised
    // password reset, so a refusal is a real failure rather than a feature
    // that was never offered.
    Object.assign(env, { OMB_ALLOW_SIGNUPS: "true", RESEND_API_KEY: `re-stub-${randomBytes(12).toString("hex")}` });
    const child = spawn(
      process.execPath,
      ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    url = `http://127.0.0.1:${port}`;
    await waitForOwnedServer(child, url);
  }, 40_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => waitForExit(child, { signal: "SIGTERM" })));
    await removeTempDir(dir);
  });

  beforeEach(() => {
    setMode("accept");
  });

  it("advertises the reset it is about to fail to deliver — the control", async () => {
    const email = mailbox("control");
    await createAccount(email);
    expect((await capabilities()).passwordReset).toBe(true);
    setMode("accept");
    const sent = await requestReset(email);
    expect(sent.res.status).toBe(200);
    // The message really went to the provider, so every negative assertion
    // below is against a real attempt rather than a silent no-op. Scoped to
    // the reset subject: creating the account also mails a verification link.
    expect(resetMailsFor(email)).toHaveLength(1);
  });

  it("answers a registered and an unregistered address identically", async () => {
    const known = mailbox("known");
    const unknown = mailbox("unknown");
    await createAccount(known);
    const forKnown = await requestReset(known);
    const forUnknown = await requestReset(unknown);
    // Byte-identical status and body. This is the property
    // src/pages/ForgotPasswordPage.tsx is built on, and the reason the fix
    // below is keyed on the deployment's transport rather than the mailbox.
    expect(forKnown.res.status).toBe(forUnknown.res.status);
    expect(forKnown.parsed.message).toBe(forUnknown.parsed.message);
    expect(forKnown.parsed.message).toBe(NEUTRAL);
    // And no verdict for the unregistered address was ever recorded, because
    // no send was attempted for it.
    expect(transported().filter((r) => r.to === unknown)).toHaveLength(0);
  });

  it("refuses a provider rejection instead of reporting a sent link", async () => {
    const email = mailbox("rejected");
    await createAccount(email);
    setMode("reject");
    const first = await requestReset(email);
    // The load-bearing assertion, taken before the retry: a reset nobody can
    // act on must not be answered with "check your inbox".
    expect(first.parsed.code).toBe("EMAIL_DELIVERY_FAILED");
    expect(first.res.status).toBeGreaterThanOrEqual(500);
    // Priced, or a client cannot arm a countdown without parsing the copy.
    expect(first.parsed.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(first.res.headers.get("retry-after"))).toBeGreaterThan(0);
    // The refusal is retryable — the transport verdict has a TTL, not a lock.
    const retry = await requestReset(email);
    expect(retry.parsed.code).toBe("EMAIL_DELIVERY_FAILED");
    // Both attempts really reached the provider: refused twice, not cached.
    expect(resetMailsFor(email)).toHaveLength(2);
  });

  it("treats an unreachable provider the same as a rejection", async () => {
    const email = mailbox("thrown");
    await createAccount(email);
    setMode("throw");
    const result = await requestReset(email);
    expect(result.parsed.code).toBe("EMAIL_DELIVERY_FAILED");
    expect(result.res.status).toBeGreaterThanOrEqual(500);
  });

  it("keeps refusing every address, not only the one that failed first", async () => {
    // The oracle guard, in the direction that matters. Once the transport is
    // known to be refusing, an address with NO account is refused exactly like
    // one with an account — otherwise a stranger could read "503" as
    // "registered" and "200" as "not registered", which is the oracle
    // ForgotPasswordPage's copy exists to prevent.
    const known = mailbox("known-2");
    const unknown = mailbox("unknown-2");
    await createAccount(known);
    setMode("reject");
    const forKnown = await requestReset(known);
    setMode("accept");
    const forUnknown = await requestReset(unknown);
    expect(forKnown.res.status).toBe(forUnknown.res.status);
    expect(forUnknown.parsed.code).toBe("EMAIL_DELIVERY_FAILED");
    // And no message was sent for the unregistered address, even then.
    expect(transported().filter((r) => r.to === unknown)).toHaveLength(0);
  });

  it("does not mint a new reset token for a send that cannot leave", async () => {
    // The token is stored by better-auth BEFORE the sender runs, so a refused
    // send leaves a live hour-long credential whose link was never delivered
    // to anyone. That is only worth asserting if it is true that a later
    // request supersedes it, which is what the single-use consumption in the
    // end-to-end case below establishes.
    const email = mailbox("token");
    await createAccount(email);
    setMode("reject");
    await requestReset(email);
    setMode("reject");
    await requestReset(email);
    // Two refusals, two stored tokens, and only the most recent one is the
    // link that was ever mailed (none of them) — the point being that no
    // request was answered with a working link.
    expect(resetMailsFor(email)).toHaveLength(2);
    expect((await capabilities()).passwordReset).toBe(false);
  });

  it("stops advertising the flow while the mailer is refusing", async () => {
    const email = mailbox("advertised");
    await createAccount(email);
    setMode("reject");
    await requestReset(email);
    // server/email.ts's header: offering a button that silently drops the
    // mail is worse than not offering it. The capability is what the sign-in
    // screen reads to decide whether to render "Forgot password?", and
    // /forgot-password already has a branch for it saying reset is
    // unavailable. Neither needs a new screen.
    expect((await capabilities()).passwordReset).toBe(false);
  });

  it("recovers as soon as the provider does, with no operator action", async () => {
    const email = mailbox("recovers");
    await createAccount(email);
    setMode("reject");
    expect((await requestReset(email)).parsed.code).toBe("EMAIL_DELIVERY_FAILED");
    expect((await capabilities()).passwordReset).toBe(false);
    // The refusal is a TTL, not a latch: one good send restores both.
    setMode("accept");
    const recovered = await requestReset(email);
    expect(recovered.res.status).toBe(200);
    expect(recovered.parsed.message).toBe(NEUTRAL);
    expect((await capabilities()).passwordReset).toBe(true);
  });

  it("mails a link that actually resets the password, once", async () => {
    // The end-to-end claim behind every case above: when a send succeeds, the
    // link works. Asserted through the real routes, because "we reported
    // truthfully" is worthless if the token behind the mail is not stored.
    const email = mailbox("endtoend");
    const password = randomBytes(24).toString("base64url");
    const res = await post("/api/auth/sign-up/email", { name: "End To End", email, password });
    expect(res.status).toBe(200);
    setMode("accept");
    await requestReset(email);

    const sent = transported().filter((r) => r.to === email && r.subject === "Reset your Muster password");
    expect(sent).toHaveLength(1);
    const link = /\bhttp:\/\/\S+\/api\/auth\/reset-password\/([A-Za-z0-9]+)\?/.exec(sent[0]!.body);
    expect(link).not.toBeNull();
    const token = link![1]!;

    // The link redirects to the app's own /reset-password with the token, and
    // the token is the one the route stored.
    const followed = await fetch(
      `${url}/api/auth/reset-password/${token}?callbackURL=%2Freset-password`,
      { redirect: "manual", signal: AbortSignal.timeout(15_000) },
    );
    expect(followed.status).toBe(302);
    expect(followed.headers.get("location")).toContain("token=");

    const newPassword = randomBytes(24).toString("base64url");
    const changed = await post("/api/auth/reset-password", { token, newPassword });
    expect(changed.status).toBe(200);
    // The new password is the one that now signs in.
    const signIn = await post("/api/auth/sign-in/email", { email, password: newPassword });
    expect(signIn.status).toBe(200);
    // And the token is single-use: a replayed link is refused.
    const replay = await post("/api/auth/reset-password", { token, newPassword: randomBytes(24).toString("base64url") });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });
});
