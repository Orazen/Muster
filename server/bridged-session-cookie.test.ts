// The session cookie a bridged sign-in writes, asserted on the real header.
//
// The defect: all four bridged sign-ins (OAuth handoff, desktop pair redeem,
// self-host claim, browser redeem) hard-coded the cookie string with no
// `Secure` attribute, and the comments above three of them asserted that this
// was fine because the deployment is plain HTTP. One of those comments called
// muster.today "plain loopback HTTP" — it is the https cloud's own browser
// front door, so the browser was being told it may return a session credential
// over a connection that permits downgrade.
//
// The fix decides the attribute per request. That is the whole risk of the
// change, which is why the negative cases are pinned as hard as the positive
// one: a `Secure` cookie is not sent back over plain http, so adding it
// unconditionally would make desktop pairing and every LAN self-host appear to
// work while logging nobody in.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let directory: string;
let base: string;
let stderr = "";

async function startServer(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), "muster-secure-cookie-"));
  const data = join(directory, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({}));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    OMB_DATA_DIR: data,
    OMB_COMPANION_DIR: join(directory, "companion"),
    OMB_HOST: "127.0.0.1",
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_PUBLIC_URL: base,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdout!.resume();
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/health`, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      /* the listener is not up yet */
    }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`secure-cookie fixture did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Mint a claim code and spend it, returning the raw Set-Cookie value. The
 *  claim path is used because it needs no upstream cloud: the code is minted
 *  from loopback and redeemed in-process, so the only variable is the header
 *  under test. */
async function claimWithHeaders(forwardedProto?: string): Promise<string> {
  const created = await fetch(`${base}/api/pair/claim/create`, { method: "POST" });
  expect(created.status).toBe(201);
  // SAFETY: the claim-create route answers 201 with the body shape the server
  // writes two lines below; the status assertion above is the guard, and a
  // missing `code` fails on the redeem with a 400 rather than a silent pass.
  const { code } = (await created.json()) as { code: string };
  const headers = forwardedProto === undefined
    ? { "content-type": "application/json" }
    : { "content-type": "application/json", "x-forwarded-proto": forwardedProto };
  const redeemed = await fetch(`${base}/api/pair/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code }),
    redirect: "manual",
  });
  expect(redeemed.status).toBe(200);
  const jar = redeemed.headers.getSetCookie?.() ?? [];
  const cookie = jar.find((c) => c.startsWith("better-auth.session_token="))
    ?? redeemed.headers.get("set-cookie");
  expect(cookie, `no session cookie in: ${jar.join(" | ")}`).toBeTruthy();
  // SAFETY: the assertion above is the guard — vitest throws before this line
  // whenever no session cookie was written, so the fallback never reaches the
  // caller as an empty string.
  return cookie as string;
}

posixOnly("bridged session cookies", () => {
  beforeAll(startServer, 40_000);
  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (directory) await removeTempDir(directory);
  });

  it("marks the cookie Secure when a TLS-terminating proxy says the request was https", async () => {
    // THE fix. Pre-fix this header produced a cookie with no Secure attribute
    // on the cloud's own front door.
    const cookie = await claimWithHeaders("https");
    expect(cookie).toContain("Secure");
    // The attribute must not have displaced anything that was already there.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Expires=");
  });

  it("leaves the cookie off Secure over plain http, or the desktop can never send it back", async () => {
    // The regression a too-eager fix would introduce: `Secure` is not advisory.
    // A desktop on loopback http would receive a cookie it then refuses to
    // return, and pairing would look fine while logging nobody in.
    const cookie = await claimWithHeaders();
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });

  it("treats an explicit http proxy hop as insecure even inside a chain", async () => {
    // A proxy chain appends, so "http, https" means the client itself was on
    // plaintext. Reading only the last hop — the naive split(",").pop() — would
    // stamp Secure onto a request that must not carry it.
    const cookie = await claimWithHeaders("http, https");
    expect(cookie).not.toContain("Secure");
  });

  it("still marks Secure when https is the client's hop in a chain", async () => {
    const cookie = await claimWithHeaders("https, http");
    expect(cookie).toContain("Secure");
  });

  it("does not treat an unrecognized scheme as a signal to stamp Secure", async () => {
    // Proxies send lowercase `https`, so anything else is not something to act
    // on. The failure direction is chosen deliberately: an unrecognized scheme
    // omits the attribute rather than guessing on. Guessing on would hand a
    // client a `Secure` cookie it cannot return — a broken session — whereas
    // omitting it on a genuinely-https request costs the attribute, not the
    // sign-in. Same asymmetry as the plain-http case above.
    const cookie = await claimWithHeaders("HTTPS,http");
    expect(cookie).not.toContain("Secure");
    // Still a working session cookie: the miss costs the attribute only.
    expect(cookie).toContain("HttpOnly");
  });
});
