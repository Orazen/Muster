// A1: a CONFIGURED mail provider that refuses the message must not be
// reported as a sent code.
//
// The live OTP suite (server/email-otp-login.test.ts) deliberately runs with
// no mailer, so it exercises the dev path where the code is printed. This file
// covers the other half: RESEND_API_KEY is set, so the deployment has
// advertised a working mailer, and the transport is a stub whose answer the
// test chooses per request. That is the case where "we tried, the provider
// said no" must reach the person who asked for a code.
//
// The bug this pins is not the missing error message — it is what the send
// route does with a FAILED send. better-auth stores the code and then awaits
// the sender through runInBackgroundOrAwait, which SWALLOWS a rejection
// (node_modules/better-auth/dist/context/create-context.mjs:215) and still
// answers {success:true}. The policy wrapper then sees a 2xx and treats it as
// an accepted send: it arms the 60s per-mailbox cooldown and stores the
// response for Idempotency-Key replay. The result is a user told "code sent",
// a cooldown blocking the retry they now need, a replayable lie, and no mail.
//
// So every case below asserts the OUTCOME, not just the status: a refusal is
// retryable immediately, the same key is never replayed as accepted, and the
// 6-digit code appears in no receipt. The accepting case is the control —
// it must still arm the cooldown, or the fix is just "always fail".
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SEND_PATH = "/api/auth/email-otp/send-verification-otp";

/** What the stubbed provider does with the next message. */
type Mode = "accept" | "reject" | "throw";

const sendBody = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
});
/** One record the stub transport wrote per outbound Resend call. */
const transportRecord = z.object({ mode: z.string(), to: z.string(), subject: z.string(), body: z.string() });

describe.skipIf(process.platform === "win32")("a configured mail provider's refusal is not a sent code", () => {
  let dir = "";
  let dataDirectory = "";
  let url = "";
  let controlPath = "";
  let transportLog = "";
  const children: ChildProcess[] = [];
  let output = "";

  const mailbox = (label: string) => `${label}-${randomBytes(6).toString("hex")}@example.test`;
  const setMode = (mode: Mode) => writeFileSync(controlPath, JSON.stringify({ mode }));

  // The per-IP send window is real and deliberately small (8 per 60s, priced
  // in seconds on every rejection). Every case here shares one loopback
  // socket, so without distinct source IPs they would spend each other's
  // budget and the suite would be measuring the rate limiter instead of
  // delivery. `x-forwarded-for` is the header the server's own clientIpOf
  // reads first, so this is the same mechanism a real deployment behind a
  // reverse proxy uses — not a way around the window.
  let ipCounter = 0;
  const nextIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

  /** Every message the stub transport was actually handed, in order. */
  const transported = (): z.infer<typeof transportRecord>[] =>
    (existsSync(transportLog) ? readFileSync(transportLog, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => transportRecord.parse(JSON.parse(line)));

  const sendCode = (email: string, idempotencyKey?: string, ip = nextIp()) => {
    const headers = new Headers({ "content-type": "application/json", origin: url, "x-forwarded-for": ip });
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    return fetch(`${url}${SEND_PATH}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers,
      body: JSON.stringify({ email, type: "sign-in" }),
    });
  };

  /** Status plus parsed body, so a case can assert both without re-reading. */
  const send = async (email: string, idempotencyKey?: string) => {
    const res = await sendCode(email, idempotencyKey);
    return { res, body: sendBody.parse(await res.json()) };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muster-otp-delivery-"));
    dataDirectory = join(dir, "data");
    const home = join(dir, "home");
    const companion = join(dir, "companion");
    const ui = join(dir, "ui");
    for (const path of [dataDirectory, home, companion, ui]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    controlPath = join(dir, "transport.json");
    transportLog = join(dir, "transport.log");
    setMode("accept");

    // A stub transport with no production seam: it replaces global fetch in
    // the child only, answers Resend's URL from the control file, and refuses
    // every other destination so the fixture cannot reach the real provider.
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
        // The payload is recorded because a case must be able to prove the
        // code DID reach the provider on the accepting path — the negative
        // assertions elsewhere are only meaningful against that control.
        `  let payload = {};`,
        `  try { payload = JSON.parse(init && init.body ? String(init.body) : "{}"); } catch {}`,
        `  appendFileSync(log, JSON.stringify({ mode, to: (payload.to || []).join(","), subject: payload.subject || "", body: payload.text || "" }) + "\\n");`,
        `  if (mode === "throw") throw new TypeError("fetch failed");`,
        `  if (mode === "reject") return new Response(JSON.stringify({ message: "stubbed provider rejection" }), { status: 422, headers: { "content-type": "application/json" } });`,
        `  return new Response(JSON.stringify({ id: "stub-message" }), { status: 200, headers: { "content-type": "application/json" } });`,
        `};`,
      ].join("\n"),
    );

    const port = await freePortBlock([0, 1, 2], 47000, 9000);
    const env = pairingServerEnvironment({
      home,
      dataDirectory,
      companionDirectory: companion,
      staticDir: ui,
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    // A configured mailer is the whole point: capability is advertised, so a
    // refusal is a real failure rather than "this deployment has no mail".
    Object.assign(env, { OMB_ALLOW_SIGNUPS: "true", RESEND_API_KEY: `re-stub-${randomBytes(12).toString("hex")}` });
    const child = spawn(
      process.execPath,
      ["--import", preload, "--experimental-strip-types", join(ROOT, "server/index.ts")],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const append = (chunk: Buffer | string) => {
      output += String(chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
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

  it("advertises the mail capability it is about to fail to deliver", async () => {
    // A refusal only violates a contract if the deployment promised delivery.
    const res = await fetch(`${url}/api/auth-capabilities`);
    expect(res.status).toBe(200);
    expect(z.object({ emailOtp: z.boolean() }).parse(await res.json()).emailOtp).toBe(true);
  });

  it("accepts a real send and arms the cooldown — the control", async () => {
    const email = mailbox("accept");
    setMode("accept");
    const first = await send(email);
    expect(first.res.status).toBe(200);
    expect(first.body.success).toBe(true);
    // The code really went to the provider: without this, every negative
    // assertion below could pass simply because nothing was ever attempted.
    const delivered = transported().filter((r) => r.to === email);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.body).toMatch(/\b\d{6}\b/);
    // And an accepted send still costs the mailbox its cooldown.
    const second = await send(email);
    expect(second.res.status).toBe(429);
    expect(second.body.code).toBe("RESEND_COOLDOWN");
  });

  it("refuses a rejected send truthfully and arms no cooldown", async () => {
    const email = mailbox("rejected");
    setMode("reject");
    const first = await send(email);
    // The load-bearing assertion, taken before the status ones so the receipt
    // below is captured even while the fix is absent: a FAILED send must not
    // consume the success cooldown, or the user's only remedy is to wait out
    // a lie.
    const second = await send(email);
    expect(first.res.status).toBeGreaterThanOrEqual(500);
    expect(first.body.success).not.toBe(true);
    expect(first.body.code).toBe("EMAIL_DELIVERY_FAILED");
    // A retryable rejection must be priced, or a client cannot arm its
    // countdown without parsing the message.
    expect(first.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(first.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(second.res.status).not.toBe(429);
    expect(second.body.code).toBe("EMAIL_DELIVERY_FAILED");
    // Both attempts really reached the provider: refused twice, not cached.
    expect(transported().filter((r) => r.to === email)).toHaveLength(2);
  });

  it("treats a transport error the same as a provider rejection", async () => {
    const email = mailbox("thrown");
    setMode("throw");
    const first = await send(email);
    expect(first.res.status).toBeGreaterThanOrEqual(500);
    expect(first.body.code).toBe("EMAIL_DELIVERY_FAILED");
    expect(first.body.retryAfterSeconds).toBeGreaterThan(0);
    const second = await send(email);
    expect(second.res.status).not.toBe(429);
    expect(transported().filter((r) => r.to === email)).toHaveLength(2);
  });

  it("never replays a refused send as an accepted one", async () => {
    const email = mailbox("replay");
    const key = randomBytes(12).toString("hex");
    setMode("reject");
    const first = await send(email, key);
    expect(first.res.status).toBeGreaterThanOrEqual(500);
    expect(first.res.headers.get("x-otp-replay")).toBeNull();
    // The same key must attempt delivery again rather than replay the refusal
    // as an acceptance — that is the same lie by a different route.
    const replay = await send(email, key);
    expect(replay.res.headers.get("x-otp-replay")).toBeNull();
    expect(replay.res.status).toBeGreaterThanOrEqual(500);
    expect(transported().filter((r) => r.to === email)).toHaveLength(2);
  });

  it("recovers as soon as the provider does, with no operator action", async () => {
    const email = mailbox("recovers");
    setMode("reject");
    expect((await send(email)).res.status).toBeGreaterThanOrEqual(500);
    setMode("accept");
    const recovered = await send(email);
    expect(recovered.res.status).toBe(200);
    expect(recovered.body.success).toBe(true);
    expect(transported().filter((r) => r.to === email)).toHaveLength(2);
  });

  it("keeps the code out of every receipt it hands back", async () => {
    const email = mailbox("noleak");
    setMode("reject");
    const res = await sendCode(email);
    const text = await res.text();
    const headers = JSON.stringify([...res.headers.entries()]);
    // A 6-digit run in the body would be the code; there is no legitimate
    // reason for either surface to carry one.
    expect(text).not.toMatch(/\b\d{6}\b/);
    expect(headers).not.toMatch(/\b\d{6}\b/);
    // Nor in the server's own output, which the dev path deliberately uses.
    const since = output.length;
    setMode("throw");
    await sendCode(mailbox("noleak-throw"));
    expect(output.slice(since)).not.toMatch(/\[otp\] sign-in code/);
  });
});
