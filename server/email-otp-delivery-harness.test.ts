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
import { DatabaseSync } from "node:sqlite";
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
const transportRecord = z.object({ callId: z.string(), mode: z.string(), to: z.string(), subject: z.string(), body: z.string() });
const verificationExpiry = z.object({
  expiresAt: z.union([z.string().transform((value) => Date.parse(value)), z.number(), z.bigint().transform((value) => Number(value))]),
});

describe.skipIf(process.platform === "win32")("a configured mail provider's refusal is not a sent code", () => {
  let dir = "";
  let dataDirectory = "";
  let url = "";
  let controlPath = "";
  let transportLog = "";
  let releaseDirectory = "";
  const children: ChildProcess[] = [];
  let output = "";

  const mailbox = (label: string) => `${label}-${randomBytes(6).toString("hex")}@example.test`;
  const setMode = (mode: Mode, hold = false) => writeFileSync(controlPath, JSON.stringify({ mode, hold }));

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

  const forMailbox = (email: string) => transported().filter((record) => record.to === email.trim().toLowerCase());
  const release = (callId: string, mode: Mode = "accept") =>
    writeFileSync(join(releaseDirectory, `${callId}.json`), JSON.stringify({ mode }));
  const releaseMailbox = (email: string) => {
    for (const record of forMailbox(email)) release(record.callId);
  };
  const waitForEntries = async (email: string, count: number) => {
    await expect.poll(() => forMailbox(email).length, { timeout: 3_000 }).toBe(count);
  };
  const settleAdmission = () => new Promise<void>((resolve) => setTimeout(resolve, 200));

  const sendCode = (email: string, idempotencyKey?: string, ip = nextIp(), signal = AbortSignal.timeout(20_000)) => {
    const headers = new Headers({ "content-type": "application/json", origin: url, "x-forwarded-for": ip });
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    return fetch(`${url}${SEND_PATH}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers,
      body: JSON.stringify({ email, type: "sign-in" }),
    });
  };

  /** Status plus parsed body, so a case can assert both without re-reading. */
  const send = async (email: string, idempotencyKey?: string, ip?: string) => {
    const res = await sendCode(email, idempotencyKey, ip);
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
    releaseDirectory = join(dir, "releases");
    mkdirSync(releaseDirectory, { mode: 0o700 });
    setMode("accept");

    // A stub transport with no production seam: it replaces global fetch in
    // the child only, answers Resend's URL from the control file, and refuses
    // every other destination so the fixture cannot reach the real provider.
    const preload = join(dir, "stub-transport.mjs");
    writeFileSync(
      preload,
      [
        `import { readFileSync, appendFileSync, existsSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const control = ${JSON.stringify(controlPath)};`,
        `const log = ${JSON.stringify(transportLog)};`,
        `const releases = ${JSON.stringify(releaseDirectory)};`,
        `let callCounter = 0;`,
        `const waitForRelease = (callId, signal) => new Promise((resolve, reject) => {`,
        `  let timer;`,
        `  const finish = (error, mode) => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); error ? reject(error) : resolve(mode); };`,
        `  const aborted = () => finish(signal.reason || new Error("Owned transport aborted"));`,
        `  const poll = () => {`,
        `    if (signal?.aborted) return aborted();`,
        `    const path = join(releases, callId + ".json");`,
        `    if (existsSync(path)) return finish(null, JSON.parse(readFileSync(path, "utf8")).mode);`,
        `    timer = setTimeout(poll, 20);`,
        `  };`,
        `  signal?.addEventListener("abort", aborted, { once: true });`,
        `  poll();`,
        `});`,
        `globalThis.fetch = async (input, init) => {`,
        `  const target = typeof input === "string" ? input : (input && input.url) || String(input);`,
        `  if (target !== "https://api.resend.com/emails") throw new Error("Owned fixture refuses outbound traffic");`,
        `  let mode = "accept";`,
        `  let hold = false;`,
        `  try { ({ mode, hold } = JSON.parse(readFileSync(control, "utf8"))); } catch {}`,
        `  const callId = String(++callCounter);`,
        // The payload is recorded because a case must be able to prove the
        // code DID reach the provider on the accepting path — the negative
        // assertions elsewhere are only meaningful against that control.
        `  let payload = {};`,
        `  try { payload = JSON.parse(init && init.body ? String(init.body) : "{}"); } catch {}`,
        `  appendFileSync(log, JSON.stringify({ callId, mode, to: (payload.to || []).join(","), subject: payload.subject || "", body: payload.text || "" }) + "\\n");`,
        `  if (hold) mode = await waitForRelease(callId, init?.signal);`,
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
    const childrenExited = children.every((child) => child.exitCode !== null || child.signalCode !== null);
    const directoryRemoved = !existsSync(dir);
    expect(childrenExited).toBe(true);
    expect(directoryRemoved).toBe(true);
    process.stdout.write(`[otp-delivery-cleanup] ${JSON.stringify({ children: children.length, childrenExited, directoryRemoved })}\n`);
  });

  beforeEach(() => {
    setMode("accept");
  });

  it("serializes a pending same-key send and replays its actual accepted result", async () => {
    const email = mailbox("pending-replay");
    const key = randomBytes(12).toString("hex");
    setMode("accept", true);
    const first = send(email, key);
    const requests = [first];
    let admissionCount = 0;
    let secondSettled = false;
    let completedWhileHeld = false;
    try {
      await waitForEntries(email, 1);
      requests.push(send(email, key).finally(() => { secondSettled = true; }));
      await settleAdmission();
      admissionCount = forMailbox(email).length;
      completedWhileHeld = secondSettled;
    } finally {
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    const results = await Promise.all(requests);
    expect(admissionCount, "held mailbox admits one actual mailer invocation").toBe(1);
    expect(completedWhileHeld, "replay waits for the actual accepted outcome").toBe(false);
    expect(results).toHaveLength(2);
    expect(results.map(({ res }) => res.status)).toEqual([200, 200]);
    expect(results[0]!.res.headers.get("x-otp-replay")).toBeNull();
    expect(results[1]!.res.headers.get("x-otp-replay")).toBe("1");
    expect(results[1]!.body).toEqual(results[0]!.body);
    expect(forMailbox(email)).toHaveLength(1);
  });

  it("prices a concurrent new key against the accepted mailbox cooldown", async () => {
    const email = mailbox("pending-cooldown");
    setMode("accept", true);
    const first = send(email, randomBytes(12).toString("hex"));
    const requests = [first];
    let admissionCount = 0;
    try {
      await waitForEntries(email, 1);
      requests.push(send(email, randomBytes(12).toString("hex")));
      await settleAdmission();
      admissionCount = forMailbox(email).length;
    } finally {
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    const [accepted, queued] = await Promise.all(requests);
    expect(admissionCount, "new key waits for its mailbox's pending outcome").toBe(1);
    expect(accepted!.res.status).toBe(200);
    expect(queued!.res.status).toBe(429);
    expect(queued!.body.code).toBe("RESEND_COOLDOWN");
    expect(queued!.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(queued!.res.headers.get("x-otp-replay")).toBeNull();
    expect(forMailbox(email)).toHaveLength(1);
  });

  it("keeps different mailbox sends independent while both mailers are held", async () => {
    const emails = [mailbox("independent-a"), mailbox("independent-b")];
    setMode("accept", true);
    const requests = emails.map((email) => send(email));
    try {
      await Promise.all(emails.map((email) => waitForEntries(email, 1)));
    } finally {
      setMode("accept");
      for (const email of emails) releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    expect((await Promise.all(requests)).map(({ res }) => res.status)).toEqual([200, 200]);
    for (const email of emails) expect(forMailbox(email)).toHaveLength(1);
  });

  it("retains a failed pending outcome and lets the same key make a genuine healthy retry", async () => {
    const email = mailbox("pending-failure");
    const key = randomBytes(12).toString("hex");
    setMode("reject", true);
    const first = send(email, key);
    const requests = [first];
    let admissionCount = 0;
    let completedWhileHeld = false;
    try {
      await waitForEntries(email, 1);
      setMode("accept");
      requests.push(send(email, key).then((result) => { completedWhileHeld = true; return result; }));
      await settleAdmission();
      admissionCount = forMailbox(email).length;
      expect(completedWhileHeld, "healthy retry waits for the first mailbox outcome").toBe(false);
    } finally {
      setMode("accept");
      for (const record of forMailbox(email)) release(record.callId, "reject");
      await Promise.allSettled(requests);
    }
    const [failed, retried] = await Promise.all(requests);
    expect(admissionCount).toBe(1);
    expect(failed!.res.status).toBe(503);
    expect(failed!.body.code).toBe("EMAIL_DELIVERY_FAILED");
    expect(failed!.res.headers.get("x-otp-replay")).toBeNull();
    expect(retried!.res.status).toBe(200);
    expect(retried!.body.success).toBe(true);
    expect(retried!.res.headers.get("x-otp-replay")).toBeNull();
    expect(forMailbox(email)).toHaveLength(2);
    const replay = await send(email, key);
    expect(replay.res.status).toBe(200);
    expect(replay.res.headers.get("x-otp-replay")).toBe("1");
    expect(forMailbox(email)).toHaveLength(2);
  });

  it("reserves case-normalized mailbox retries as the same pending send", async () => {
    const email = mailbox("normalized");
    const key = randomBytes(12).toString("hex");
    setMode("accept", true);
    const requests = [send(email, key)];
    try {
      await waitForEntries(email, 1);
      requests.push(send(email.toUpperCase(), key));
      await settleAdmission();
      expect(forMailbox(email)).toHaveLength(1);
    } finally {
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    const results = await Promise.all(requests);
    expect(results.map(({ res }) => res.status)).toEqual([200, 200]);
    expect(results[1]!.res.headers.get("x-otp-replay")).toBe("1");
    expect(forMailbox(email)).toHaveLength(1);
  });

  it("spends one IP send for pending replay and preserves the remaining seven sends", async () => {
    const email = mailbox("pending-ip");
    const key = randomBytes(12).toString("hex");
    const ip = nextIp();
    setMode("accept", true);
    const requests = [send(email, key, ip)];
    try {
      await waitForEntries(email, 1);
      requests.push(send(email, key, ip));
      await settleAdmission();
    } finally {
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    const results = await Promise.all(requests);
    expect(results.map(({ res }) => res.status)).toEqual([200, 200]);
    expect(results[1]!.res.headers.get("x-otp-replay")).toBe("1");
    for (let i = 0; i < 7; i += 1) expect((await send(mailbox("ip-room"), undefined, ip)).res.status).toBe(200);
    const exhaustedEmail = mailbox("ip-exhausted");
    const exhausted = await send(exhaustedEmail, undefined, ip);
    expect(exhausted.res.status).toBe(429);
    expect(exhausted.body.code).toBe("RATE_LIMITED");
    expect(forMailbox(exhaustedEmail)).toHaveLength(0);
  });

  it("bounds mailbox waiters with a truthful busy response and spends no send for overload", async () => {
    const email = mailbox("queue-bound");
    const key = randomBytes(12).toString("hex");
    const overloadIp = nextIp();
    setMode("accept", true);
    const requests = [send(email, key)];
    try {
      await waitForEntries(email, 1);
      requests.push(send(email, key));
      await settleAdmission();
      const overloaded = await send(email, key, overloadIp);
      expect(overloaded.res.status).toBe(503);
      expect(overloaded.body.code).toBe("EMAIL_SEND_BUSY");
      expect(overloaded.body.success).not.toBe(true);
      expect(overloaded.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number(overloaded.res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(overloaded.res.headers.get("x-otp-replay")).toBeNull();
      expect(forMailbox(email)).toHaveLength(1);
    } finally {
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    expect((await Promise.all(requests)).map(({ res }) => res.status)).toEqual([200, 200]);
    // An overloaded request did not reach the plugin or spend this IP's
    // budget. All eight real sends remain; the ninth is honestly priced.
    for (let i = 0; i < 8; i += 1) expect((await send(mailbox("overload-ip"), undefined, overloadIp)).res.status).toBe(200);
    expect((await send(mailbox("overload-ip-full"), undefined, overloadIp)).body.code).toBe("RATE_LIMITED");
  });

  it("bounds outstanding mailboxes and releases capacity after genuine outcomes", async () => {
    const emails = Array.from({ length: 64 }, () => mailbox("mailbox-bound"));
    setMode("accept", true);
    const requests = emails.map((email) => send(email));
    const extra = mailbox("capacity-retry");
    try {
      await expect.poll(() => {
        const entered = new Set(transported().map((record) => record.to));
        return emails.filter((email) => entered.has(email)).length;
      }, { timeout: 5_000 }).toBe(64);
      const overloaded = await send(extra);
      expect(overloaded.res.status).toBe(503);
      expect(overloaded.body.code).toBe("EMAIL_SEND_BUSY");
      expect(overloaded.body.success).not.toBe(true);
      expect(forMailbox(extra)).toHaveLength(0);
    } finally {
      setMode("accept");
      for (const email of emails) releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    expect((await Promise.all(requests)).map(({ res }) => res.status)).toEqual(emails.map(() => 200));
    const retry = await send(extra);
    expect(retry.res.status).toBe(200);
    expect(retry.res.headers.get("x-otp-replay")).toBeNull();
    expect(forMailbox(extra)).toHaveLength(1);
  }, 15_000);

  it("releases a timed-out sender and lets its queued retry use the real healthy transport", async () => {
    const email = mailbox("deadline-release");
    const key = randomBytes(12).toString("hex");
    setMode("accept", true);
    const requests = [send(email, key)];
    try {
      await waitForEntries(email, 1);
      setMode("accept");
      requests.push(send(email, key));
      const [failed, retried] = await Promise.all(requests);
      expect(failed!.res.status).toBe(503);
      expect(failed!.body.code).toBe("EMAIL_DELIVERY_FAILED");
      expect(retried!.res.status).toBe(200);
      expect(retried!.res.headers.get("x-otp-replay")).toBeNull();
      expect(forMailbox(email)).toHaveLength(2);
      expect((await send(email, key)).res.headers.get("x-otp-replay")).toBe("1");
    } finally {
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled(requests);
    }
  }, 20_000);

  it("retains an admitted send after caller disconnect so a pending retry receives its accepted replay", async () => {
    const email = mailbox("caller-disconnect");
    const key = randomBytes(12).toString("hex");
    const controller = new AbortController();
    setMode("accept", true);
    const first = sendCode(email, key, nextIp(), controller.signal).then(
      () => "unexpected-response",
      () => "caller-aborted",
    );
    const requests: ReturnType<typeof send>[] = [];
    try {
      await waitForEntries(email, 1);
      controller.abort();
      expect(await first).toBe("caller-aborted");
      requests.push(send(email, key));
      await settleAdmission();
      expect(forMailbox(email)).toHaveLength(1);
    } finally {
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled(requests);
    }
    const retried = await requests[0]!;
    expect(retried.res.status).toBe(200);
    expect(retried.res.headers.get("x-otp-replay")).toBe("1");
    expect(forMailbox(email)).toHaveLength(1);
  });

  it("releases a disconnected queued caller without mailing on its behalf or retaining its slot", async () => {
    const email = mailbox("queued-disconnect");
    const key = randomBytes(12).toString("hex");
    const controller = new AbortController();
    setMode("reject", true);
    const first = send(email, key);
    let queued: Promise<string> | undefined;
    try {
      await waitForEntries(email, 1);
      setMode("accept");
      queued = sendCode(email, key, nextIp(), controller.signal).then(
        () => "unexpected-response",
        () => "caller-aborted",
      );
      await settleAdmission();
      controller.abort();
      expect(await queued).toBe("caller-aborted");
      for (const record of forMailbox(email)) release(record.callId, "reject");
      expect((await first).res.status).toBe(503);
      await settleAdmission();
      expect(forMailbox(email)).toHaveLength(1);
      const retry = await send(email, key);
      expect(retry.res.status).toBe(200);
      expect(retry.res.headers.get("x-otp-replay")).toBeNull();
      expect(forMailbox(email)).toHaveLength(2);
    } finally {
      controller.abort();
      setMode("accept");
      releaseMailbox(email);
      await Promise.allSettled([first, queued]);
    }
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

  it("stores the accepted synthetic code with an actual600-second deadline", async () => {
    const email = mailbox("stored-lifetime");
    const beforeSend = Date.now();
    const result = await send(email);
    const afterSend = Date.now();
    expect(result.res.status).toBe(200);
    const db = new DatabaseSync(join(dataDirectory, "auth.db"), { readOnly: true });
    try {
      const row = verificationExpiry.parse(db.prepare('SELECT "expiresAt" FROM "verification" WHERE "identifier" = ?').get(`sign-in-otp-${email}`));
      expect(Number.isFinite(row.expiresAt)).toBe(true);
      expect(row.expiresAt).toBeGreaterThanOrEqual(beforeSend + 600_000);
      expect(row.expiresAt).toBeLessThanOrEqual(afterSend + 600_000);
    } finally {
      db.close();
    }
    // This inspects only our stored deadline. It proves no real inbox receipt,
    // elapsed ten-minute login boundary or independent host clock agreement.
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

  it("does not let a password-reset send decide a later sign-in send", async () => {
    // A guard, not a regression test for the retention fix: this passes with
    // or without the type gate, because the send policy only reads AFTER it
    // delegates, and delegating always invokes the sender first — so the
    // verdict it reads is always its own. What it pins is that a non-sign-in
    // route outside the wrapper (`/email-otp/request-password-reset` needs no
    // configuration and simply bypasses it) cannot influence a sign-in send
    // at all, now or later. The leak that gate prevents is asserted directly
    // in server/otp-delivery.test.ts.
    const email = mailbox("crosscontam");
    // The account must exist: the plugin short-circuits a non-sign-in send for
    // an unknown address without ever calling the sender.
    const signUp = await fetch(`${url}/api/auth/sign-up/email`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: new Headers({ "content-type": "application/json", origin: url }),
      body: JSON.stringify({ name: "Cross Contam", email, password: randomBytes(24).toString("base64url") }),
    });
    expect(signUp.status).toBe(200);

    setMode("accept");
    const before = transported().filter((r) => r.to === email).length;
    const reset = await fetch(`${url}/api/auth/email-otp/request-password-reset`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: new Headers({ "content-type": "application/json", origin: url }),
      body: JSON.stringify({ email }),
    });
    expect(reset.status).toBe(200);
    // The sender really ran for that non-sign-in request, so this is not a
    // vacuous pass.
    expect(transported().filter((r) => r.to === email).length).toBe(before + 1);

    // Now the provider starts refusing. A sign-in code for the same mailbox
    // must still be reported as undelivered. It is not cooldown-blocked: the
    // reset route never reached the send policy, so no cooldown was armed.
    setMode("reject");
    const signIn = await send(email);
    expect(signIn.res.status).toBeGreaterThanOrEqual(500);
    expect(signIn.body.code).toBe("EMAIL_DELIVERY_FAILED");
    // And the user must be able to try again.
    const retry = await send(email);
    expect(retry.res.status).not.toBe(429);
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
