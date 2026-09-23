// Browser panel session manager — a harness-owned Chromium the HUMAN can
// preview public pages from the chat's Browser side panel (the OpenMausBot
// "Quill's browser" pattern). This is deliberately NOT the bot's Obscura
// browser: obscura is stealth + headless and lives only for the duration of
// a turn, spawned by the CLI's MCP layer. This session is long-lived,
// visible: the human enters a URL or watches frames. Bot tools and page
// input are not attached to this session.
//
// One Chromium per bot. Profiles keep logins separate: "Bot's own"
// (persistent user-data-dir under the bot's workspace) vs "Guest" (a scratch
// dir wiped on switch). CDP drives navigation and the Page.startScreencast
// frame feed; frames are kept in memory, one JPEG deep, and served to the
// panel. The legacy takeControl wire flag does not pause agent execution
// and is ignored by the preview UI.
//
// Security: navigation URLs are validated http/https with a DNS-resolvable
// public host (loopback/private ranges refused — a panel must not become a
// probe for internal services). The endpoints serve cloud installs too —
// ownership is enforced per bot id upstream (the multi-tenant guard in
// server/index.ts), so one account's frames never reach another account.
//
// Browser discovery ("auto-install in app"): MUSTER_CHROME_PATH/CHROME_PATH
// override → system Chrome/Chromium/Edge/Brave → Playwright's downloaded
// Chromium → one-shot auto-install of a Chrome for Testing build under the
// data dir. The auto-install fetches only from Google's fixed CfT endpoints
// (https, version strings validated to digits-and-dots — no user input ever
// reaches a URL).
//
// Takeover console (opt-in, OFF by default): a human-handoff layer over the
// SAME CDP session — click-to-select, type-into-field, key chips, scroll,
// plus a short-lived signed link for the console's screenshot image. All of
// it is inert unless the operator sets MUSTER_BROWSER_TAKEOVER=1: without
// the flag the takeover endpoints refuse, no preview signature is minted,
// panelState reports takeoverEnabled=false (so the UI shows no Take control
// affordance), and nothing here contacts anything at boot — frames and
// links are produced only for an already-open session.
//
// Adapted from OpenMuse (github.com/CopilotKit/OpenMuse), MIT License,
// Copyright (c) 2026 OpenMuse contributors — the takeover console's
// interaction model, its fixed 1280×800 click-coordinate bounds and the
// input whitelist below.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import { deploymentSigningSecret } from "./auth.ts";
import { DATA_DIR } from "./config.ts";

export interface BrowserPanelState {
  running: boolean;
  url: string | null;
  title: string | null;
  profile: "bot" | "guest";
  takeControl: boolean;
  startedAt: number | null;
  error: string | null;
  /** False unless MUSTER_BROWSER_TAKEOVER is explicitly enabled. */
  takeoverEnabled: boolean;
  /** Short-lived signed screenshot link for the takeover console; only
   * minted while the gate is on and a frame exists, renewed every poll. */
  previewLink: string | null;
}

interface Session {
  child: ChildProcess;
  profile: "bot" | "guest";
  userDataDir: string;
  cdpPort: number;
  ws: WebSocket | null;
  targetId: string | null;
  frame: Buffer | null;
  frameAt: number;
  url: string | null;
  title: string | null;
  takeControl: boolean;
  startedAt: number;
  error: string | null;
  dying: boolean;
}

const sessions = new Map<string, Session>();

const CDP_BASE = 9500;
// The CDP port must be free on the machine, not just unused by this
// process — a leftover Chromium (crashed session, or a second harness such
// as the desktop app running alongside) would otherwise receive our
// attach() traffic while the freshly spawned browser sits there portless.
// Detect ANY live listener by connecting to both loopback stacks: a bind()
// probe can't be trusted here (libuv sets SO_REUSEADDR, so a wildcard bind
// succeeds alongside a specific-address one; Chrome sometimes picks ::1).
function portHasListener(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
  return (async () => (await tryHost("127.0.0.1")) || (await tryHost("::1")))();
}
export async function freeCdpPort(): Promise<number> {
  const used = new Set([...sessions.values()].map((s) => s.cdpPort));
  for (let p = CDP_BASE; p < CDP_BASE + 40; p++) {
    if (used.has(p)) continue;
    if (!(await portHasListener(p))) return p;
  }
  throw new Error("too many browser panel sessions open");
}

const CHROME_CANDIDATES: Array<{ platform: NodeJS.Platform; paths: string[] }> = [
  {
    platform: "darwin",
    paths: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ],
  },
  {
    platform: "linux",
    paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/microsoft-edge"],
  },
  {
    platform: "win32",
    paths: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
        : "C:\\Users\\you\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
];

/** Playwright downloads browsers into a versioned cache dir; the binary
 * hides one level deeper under chrome-<build>. Walks any version found and
 * picks the highest — stale caches from old Playwright versions still work. */
function findPlaywrightChromium(): string | null {
  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "AppData", "Local", "ms-playwright"),
  ].filter((b): b is string => Boolean(b));
  const sub =
    process.platform === "darwin"
      ? ["chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
      : process.platform === "win32"
        ? ["chrome-win/chrome.exe"]
        : ["chrome-linux/chrome"];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    let versions: string[] = [];
    try {
      versions = readdirSync(base).filter((d) => d.startsWith("chrome-"));
    } catch {
      continue;
    }
    for (const v of versions.sort().reverse()) {
      for (const rel of sub) {
        const p = join(base, v, ...rel.split("/"));
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** Chrome for Testing auto-install. One version per install dir under
 * DATA_DIR so upgrades never trash a working binary; the newest installed
 * version wins. A pinned fallback covers the (rare) case where the CfT
 * version feed is unreachable — the feed host and the archive host are both
 * fixed Google endpoints, https only, and the version is validated to
 * digits-and-dots before it ever touches a URL. */
const CFT_FEED_URL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json";
const CFT_ARCHIVE_HOST = "https://storage.googleapis.com/chrome-for-testing-public";
const CFT_FALLBACK_VERSION = "140.0.7339.82";
const CFT_VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;

const cftVersionResponseSchema = z.object({
  channels: z.object({ Stable: z.object({ version: z.string() }) }),
});

function cftRootDir(): string {
  return join(DATA_DIR, "browsers", "chrome-for-testing");
}

function cftBinaryPath(version: string): string {
  if (process.platform === "darwin") {
    return join(cftRootDir(), version, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  if (process.platform === "win32") return join(cftRootDir(), version, "chrome-win64", "chrome.exe");
  return join(cftRootDir(), version, "chrome-linux64", "chrome");
}

/** Newest fully-installed CfT build, or null. The .installed marker is
 * written only after a successful extract, so a half-download from a killed
 * start attempt never looks installed. */
function findInstalledCft(): string | null {
  const root = cftRootDir();
  if (!existsSync(root)) return null;
  let versions: string[] = [];
  try {
    versions = readdirSync(root).filter((d) => CFT_VERSION_RE.test(d));
  } catch {
    return null;
  }
  for (const v of versions.sort(compareVersions).reverse()) {
    const bin = cftBinaryPath(v);
    if (existsSync(bin) && existsSync(join(root, v, ".installed"))) return bin;
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function resolveCftVersion(): Promise<string> {
  try {
    // SAFETY: fixed Google CfT feed, no user input; response is zod-checked.
    const res = await fetch(CFT_FEED_URL, { signal: AbortSignal.timeout(10_000) });
    const parsed = cftVersionResponseSchema.safeParse(await res.json());
    const v = parsed.success ? parsed.data.channels.Stable.version : "";
    if (CFT_VERSION_RE.test(v)) return v;
  } catch {
    /* feed unreachable — pinned fallback below */
  }
  return CFT_FALLBACK_VERSION;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  // SAFETY: caller builds the URL from validated constants only.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const body = res.body;
  if (!body) throw new Error("empty response body");
  // SAFETY: res.body is undici's web ReadableStream — the same runtime
  // class node:stream/web's fromWeb wraps; the local only reconciles the
  // two type declarations of one object.
  const stream: import("node:stream/web").ReadableStream = body;
  await pipeline(Readable.fromWeb(stream), createWriteStream(dest));
}

/** One-shot Chrome for Testing install. Everything in the URLs is
 * server-constant — never user input. */
export async function installChromeForTesting(): Promise<string> {
  const existing = findInstalledCft();
  if (existing) return existing;
  const version = await resolveCftVersion();
  const root = join(cftRootDir(), version);
  const platform =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "mac-arm64"
        : "mac-x64"
      : process.platform === "win32"
        ? "win64"
        : "linux64";
  const zipName = `chrome-${platform}.zip`;
  const zipPath = join(root, zipName);
  mkdirSync(root, { recursive: true });
  try {
    await downloadTo(`${CFT_ARCHIVE_HOST}/${version}/${zipName}`, zipPath);
    const extract =
      process.platform === "win32"
        ? spawn("powershell", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${root}'`,
          ], { stdio: "ignore" })
        : spawn("unzip", ["-oq", zipPath, "-d", root], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      extract.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`extraction failed (exit ${code}) — is unzip available on this host?`)),
      );
      extract.on("error", reject);
    });
    const bin = cftBinaryPath(version);
    if (!existsSync(bin)) throw new Error("archive extracted but the Chrome binary is missing");
    if (process.platform !== "win32") {
      try {
        chmodSync(bin, 0o755);
      } catch {
        /* already executable */
      }
      if (process.platform === "darwin") {
        // CfT zips carry the quarantine xattr; a headless spawn would trip
        // Gatekeeper's first-run assessment otherwise. Best effort.
        spawn("xattr", ["-dr", "com.apple.quarantine", join(root, "Google Chrome for Testing.app")], { stdio: "ignore" });
      }
    }
    writeFileSync(join(root, ".installed"), version);
    return bin;
  } finally {
    try {
      rmSync(zipPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

let resolvingChrome: Promise<string> | null = null;

/** Resolve a launchable Chromium-family binary, auto-installing Chrome for
 * Testing when nothing else exists. Concurrent starts share one resolution
 * so a double-click cannot start two downloads. */
export function resolveChrome(): Promise<string> {
  // explicit override always wins
  for (const env of [process.env.MUSTER_CHROME_PATH, process.env.CHROME_PATH]) {
    if (env && existsSync(env)) return Promise.resolve(env);
  }
  for (const entry of CHROME_CANDIDATES) {
    if (entry.platform !== process.platform) continue;
    for (const p of entry.paths) if (existsSync(p)) return Promise.resolve(p);
  }
  const playwright = findPlaywrightChromium();
  if (playwright) return Promise.resolve(playwright);
  const cft = findInstalledCft();
  if (cft) return Promise.resolve(cft);
  if (!resolvingChrome) {
    resolvingChrome = (async () => {
      try {
        return await installChromeForTesting();
      } catch (e) {
        throw new Error(
          `no Chrome/Chromium found and the in-app auto-install failed (${e instanceof Error ? e.message : String(e)}) — install Google Chrome, or point MUSTER_CHROME_PATH at a Chromium binary`,
        );
      } finally {
        resolvingChrome = null;
      }
    })();
  }
  return resolvingChrome;
}

/** Synchronous scan (no auto-install) — for doctor checks and tests. */
export function findChromeSync(): string | null {
  for (const env of [process.env.MUSTER_CHROME_PATH, process.env.CHROME_PATH]) {
    if (env && existsSync(env)) return env;
  }
  for (const entry of CHROME_CANDIDATES) {
    if (entry.platform !== process.platform) continue;
    for (const p of entry.paths) if (existsSync(p)) return p;
  }
  return findPlaywrightChromium() ?? findInstalledCft();
}

/** Navigation guard: http/https only, and refuse loopback/private/reserved
 * hosts — the panel navigates the open internet, not the operator's LAN.
 * IP-literal checks are exact; hostname checks match RFC1918/reserved
 * patterns and the loopback names. */
export function isNavigableUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  // IPv6 literals: loopback, unique-local, link-local
  if (host.includes(":")) {
    const h = host.replace(/^\[|\]$/g, "");
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
    return true;
  }
  // IPv4 literals: loopback / private / reserved / link-local / CGNAT
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  return true;
}

// Commands (including fire-and-forget screencast acknowledgements) all need
// unique numeric IDs on the CDP wire.
let cdpCommandId = 0;

async function cdp(session: Session, method: string, params: Json = {}): Promise<any> {
  const ws = session.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("browser session is not connected");
  return await new Promise((resolve, reject) => {
    const id = ++cdpCommandId;
    const onMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener("message", onMessage);
          if (msg.error) reject(new Error(String(msg.error.message ?? "CDP error")));
          else resolve(msg.result);
        }
      } catch {
        /* non-JSON frame */
      }
    };
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("CDP call timed out"));
    }, 15_000);
    ws.addEventListener("message", onMessage);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      reject(error);
    }
  });
}

/** Minimal JSON value — CDP requests this bridge sends are all built here
 * from literals plus validated strings, never external payloads. */
interface Json {
  [key: string]: string | number | boolean | null | Json | undefined;
}

/** CDP wire decoding. Chromium's /json/list and event frames are external
 * JSON, so both cross a zod schema at this boundary exactly once; anything
 * that fails validation is dropped rather than asserted. */
interface CdpTarget {
  wsUrl: string;
  url: string | null;
  title: string | null;
}

const cdpTargetSchema = z.object({
  type: z.string(),
  webSocketDebuggerUrl: z.string().min(1),
  url: z.string().optional(),
  title: z.string().optional(),
});

const jsonListSchema = z.array(cdpTargetSchema);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the CDP I/O boundary: this zod parse IS the schema run
function decodeTargets(value: unknown): CdpTarget[] {
  const parsed = jsonListSchema.safeParse(value);
  if (!parsed.success) return [];
  // Chrome 152+ headless also lists chrome://omnibox-popup.top-chrome
  // "browser_ui" targets; the real page is the last "page" entry and always
  // beats any UI surface for screencast attach.
  const pages = parsed.data.filter((t) => t.type === "page");
  return pages
    .slice(-1)
    .map((t) => ({ wsUrl: t.webSocketDebuggerUrl, url: t.url ?? null, title: t.title ?? null }));
}

interface ScreencastFrame {
  data: string;
  ackId: string | number | null;
  url: string | null;
  title: string | null;
}

const screencastFrameSchema = z.object({
  data: z.string().optional(),
  // Chrome 152 sends a numeric screencast session id; older builds sent a
  // string — accept either and echo it back verbatim.
  sessionId: z.union([z.string(), z.number()]).nullish(),
  metadata: z
    .object({ url: z.string().optional(), pageTitle: z.string().optional() })
    .loose()
    .optional(),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the CDP I/O boundary: this zod parse IS the schema run
function decodeScreencastFrame(value: unknown): ScreencastFrame | null {
  const parsed = screencastFrameSchema.safeParse(value);
  if (!parsed.success) {
    if (process.env.BROWSER_PANEL_DEBUG) {
      process.stderr.write(`[bpanel] frame decode failed: ${parsed.error.message.slice(0, 300)}\n`);
    }
    return null;
  }
  if (!parsed.data.data) return null;
  return {
    data: parsed.data.data,
    ackId: parsed.data.sessionId ?? null,
    url: parsed.data.metadata?.url ?? null,
    title: parsed.data.metadata?.pageTitle ?? null,
  };
}

// Chrome binds its DevTools http endpoint to whichever loopback stack it
// likes (both 127.0.0.1-only and ::1-only binds observed) — try both; the
// webSocketDebuggerUrl it returns echoes the host we asked with, so the
// CDP websocket lands on the same working stack.
async function cdpHttpJson(port: number, path: string): Promise<string> {
  let lastErr: Error | null = null;
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const res = await fetch(`http://${host}:${port}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("CDP http endpoint unreachable");
}

async function attach(session: Session): Promise<void> {
  const targets = decodeTargets(JSON.parse(await cdpHttpJson(session.cdpPort, "/json/list")));
  const page = targets[0];
  if (!page) throw new Error("no page target in browser session");
  session.url = page.url;
  session.title = page.title;
  session.ws = new WebSocket(page.wsUrl);
  const ws = session.ws;
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    try {
      // SAFETY: CDP frames are Chromium-generated JSON; decodeScreencastFrame
      // zod-validates before anything is read.
      const msg = JSON.parse(String(event.data)) as { method?: unknown; params?: unknown };
      if (process.env.BROWSER_PANEL_DEBUG) process.stderr.write(`[bpanel] event: ${String(msg.method)}\n`);
      if (msg.method === "Page.screencastFrame") {
        const frame = decodeScreencastFrame(msg.params);
        if (!frame) return;
        session.frame = Buffer.from(frame.data, "base64");
        session.frameAt = Date.now();
        if (frame.ackId !== null) {
          ws.send(JSON.stringify({ id: ++cdpCommandId, method: "Page.screencastFrameAck", params: { sessionId: frame.ackId } }));
        }
        if (frame.url) session.url = frame.url;
        if (frame.title) session.title = frame.title;
      }
    } catch {
      /* ignore malformed CDP events */
    }
  });
  await cdp(session, "Page.enable");
  await cdp(session, "Runtime.enable");
  // A reopened profile can restore this target in the background. Activate
  // the selected page so its compositor produces frames for the preview.
  await cdp(session, "Page.bringToFront");
  await cdp(session, "Page.startScreencast", {
    format: "jpeg",
    quality: 55,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });
}

// (string decoding lives in str()/decodeTargets()/decodeScreencastFrame())

// ── Takeover console (opt-in via MUSTER_BROWSER_TAKEOVER) ─────────────

/** Takeover is inert unless the operator explicitly enables it. Absent,
 * empty, or any unrecognized value keeps the whole section below off. */
export function takeoverEnabled(): boolean {
  const flag = (process.env.MUSTER_BROWSER_TAKEOVER ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}

/** Short-lived by construction: an expired console preview link stops
 * resolving on its own, and panelState renews it on every frame poll. */
export const PREVIEW_SIGNATURE_TTL_MS = 10 * 60_000;

function previewHmac(secret: string, botId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${botId}.${expiresAt}`).digest("base64url");
}

/** Token payload: `<expiresAt>.<hmac>`. The expiry is inside the signed
 * payload, so a holder cannot extend its own link, and the bot id is in
 * the payload too, so one bot's link never resolves another bot's frames. */
export function mintPreviewSignature(botId: string, secret: string, issuedAt: number) {
  const expiresAt = issuedAt + PREVIEW_SIGNATURE_TTL_MS;
  return { token: `${expiresAt}.${previewHmac(secret, botId, expiresAt)}`, expiresAt };
}

export function verifyPreviewSignature(botId: string, token: string, secret: string, now: number): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
  const expected = previewHmac(secret, botId, expiresAt);
  const provided = token.slice(dot + 1);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}

/** The console's key whitelist — navigation and editing keys only, bounded
 * at the wire (near-verbatim bound from the OpenMuse worker's input
 * validation; attribution in the file header). */
export const TAKEOVER_KEYS = [
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  "Control+a", "Meta+a", "Shift+Tab",
] as const;
export type TakeoverKey = (typeof TAKEOVER_KEYS)[number];

/** Bounds mirror the fixed 1280×800 viewport the screencast frames are
 * captured at: clicks outside it are rejected, not silently clamped. */
export const takeoverActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().int().min(0).max(1279), y: z.number().int().min(0).max(799) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("key"), key: z.enum(TAKEOVER_KEYS) }),
  z.object({ type: z.literal("scroll"), deltaY: z.number().min(-5000).max(5000) }),
]);
export type TakeoverAction = z.infer<typeof takeoverActionSchema>;

interface TakeoverKeyEvent {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers?: number;
}

type TakeoverKeyEventTable = { [Key in TakeoverKey]: TakeoverKeyEvent };

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const TAKEOVER_KEY_EVENTS: TakeoverKeyEventTable = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8, text: "\b" },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  "Control+a": { key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 2 },
  "Meta+a": { key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 4 },
  "Shift+Tab": { key: "Tab", code: "Tab", keyCode: 9, modifiers: 8 },
};

/** Resolve a signed preview link to the current frame. Refuses when the
 * gate is off, the session is gone, the token is stale, or the signature
 * does not match THIS bot. */
export function previewFrame(botId: string, token: string): Buffer | null {
  try {
    if (!takeoverEnabled()) return null;
    const s = sessions.get(botId);
    if (!s || !s.frame) return null;
    if (!verifyPreviewSignature(botId, token, deploymentSigningSecret(), Date.now())) return null;
    return s.frame;
  } catch {
    return null; // signing secret unavailable → the link simply does not resolve
  }
}

/** One console action over the panel's own CDP session. The gate is
 * checked before anything else — an inert deployment never reaches the
 * browser, and the response frame keeps flowing as before. */
export async function takeoverInput(botId: string, action: TakeoverAction): Promise<BrowserPanelState> {
  if (!takeoverEnabled()) {
    throw new Error("browser takeover is not enabled on this deployment (set MUSTER_BROWSER_TAKEOVER=1)");
  }
  const s = sessions.get(botId);
  if (!s) throw new Error("no browser session open");
  s.takeControl = true; // human is driving
  if (action.type === "click") {
    const base = { x: action.x, y: action.y, button: "left", clickCount: 1 };
    await cdp(s, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await cdp(s, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  } else if (action.type === "text") {
    await cdp(s, "Input.insertText", { text: action.text });
  } else if (action.type === "key") {
    const binding = TAKEOVER_KEY_EVENTS[action.key];
    const shared = {
      key: binding.key,
      code: binding.code,
      windowsVirtualKeyCode: binding.keyCode,
      nativeVirtualKeyCode: binding.keyCode,
      modifiers: binding.modifiers ?? 0,
    };
    const down: Json = { ...shared, type: "keyDown" };
    if (binding.text !== undefined) down.text = binding.text;
    await cdp(s, "Input.dispatchKeyEvent", down);
    await cdp(s, "Input.dispatchKeyEvent", { ...shared, type: "keyUp" });
  } else {
    // wheel at the viewport center — a headless session has no hover point
    await cdp(s, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: action.deltaY });
  }
  return panelState(botId);
}

/** Signed console preview link, or null while the gate is off / no frame
 * exists / the deployment signing secret is unavailable (then the console
 * falls back to the polled frame payload). */
function previewLinkFor(botId: string): string | null {
  if (!takeoverEnabled()) return null;
  try {
    const { token } = mintPreviewSignature(botId, deploymentSigningSecret(), Date.now());
    return `/api/bots/${encodeURIComponent(botId)}/browser-panel/preview?sig=${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
}

export function panelState(botId: string): BrowserPanelState {
  const enabled = takeoverEnabled();
  const s = sessions.get(botId);
  if (!s) {
    return {
      running: false, url: null, title: null, profile: "bot", takeControl: false,
      startedAt: null, error: null, takeoverEnabled: enabled, previewLink: null,
    };
  }
  return {
    running: true,
    url: s.url,
    title: s.title,
    profile: s.profile,
    takeControl: s.takeControl,
    startedAt: s.startedAt,
    error: s.error,
    takeoverEnabled: enabled,
    previewLink: s.frame ? previewLinkFor(botId) : null,
  };
}

export function latestFrame(botId: string): Buffer | null {
  return sessions.get(botId)?.frame ?? null;
}

export function setTakeControl(botId: string, on: boolean): void {
  const s = sessions.get(botId);
  if (s) s.takeControl = on;
}

export function stopPanel(botId: string): void {
  const s = sessions.get(botId);
  if (!s) return;
  s.dying = true;
  try {
    s.ws?.close();
  } catch {
    /* already closed */
  }
  try {
    s.child.kill();
  } catch {
    /* already dead */
  }
  sessions.delete(botId);
  // guest profiles are scratch: wiped the moment the session ends. The
  // bot's own profile persists — that is where its logins live.
  if (s.profile === "guest") {
    setTimeout(() => {
      try {
        rmSync(s.userDataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }, 1500);
  }
}

export function stopAllPanels(): void {
  // stopPanel mutates the map, so iterate a snapshot
  for (const botId of Array.from(sessions.keys())) stopPanel(botId);
}

/** Normalize panel address-bar input to an absolute http(s) URL. Input that
 * already names a scheme must be http/https — prefixing would turn
 * "file:///etc/passwd" into "https://file///…" whose hostname "file" looks
 * like a public site and slips past isNavigableUrl. */
export function toNavigableUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("that address is not allowed — http/https public sites only");
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const navigateResultSchema = z.object({
  frameId: z.string().min(1),
  errorText: z.string().optional(),
  isDownload: z.boolean().optional(),
});

export async function navigatePanel(botId: string, rawUrl: string): Promise<BrowserPanelState> {
  const s = sessions.get(botId);
  if (!s) throw new Error("no browser session open");
  const withScheme = toNavigableUrl(rawUrl);
  if (!isNavigableUrl(withScheme)) throw new Error("that address is not allowed — http/https public sites only");
  s.takeControl = true; // human is driving
  try {
    const parsed = navigateResultSchema.safeParse(await cdp(s, "Page.navigate", { url: withScheme }));
    if (!parsed.success) throw new Error("the browser returned an invalid navigation response");
    if (parsed.data.errorText !== undefined) {
      throw new Error(`could not open that page: ${parsed.data.errorText || "navigation failed"}`);
    }
    if (parsed.data.isDownload) throw new Error("that address started a download; the browser preview cannot display it");
  } catch (error) {
    s.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
  s.error = null;
  s.url = withScheme;
  return panelState(botId);
}

export interface BrowserPanelLauncher {
  spawn(command: string, args: string[], options: { stdio: "ignore"; detached: false }): ChildProcess;
}

const browserPanelLauncher: BrowserPanelLauncher = { spawn };

export async function startPanel(
  botId: string,
  opts: { workspaceDir?: string; profile?: "bot" | "guest" },
  launcher: BrowserPanelLauncher = browserPanelLauncher,
): Promise<BrowserPanelState> {
  const existing = sessions.get(botId);
  if (existing) return panelState(botId);
  // discovery first, auto-install (Chrome for Testing) as the last resort —
  // first run on a bare machine downloads once, then it's cached for good
  const chrome = await resolveChrome();
  const profile = opts.profile === "guest" ? "guest" : "bot";
  const userDataDir =
    profile === "guest"
      ? mkdtempSync(join(tmpdir(), "muster-guest-profile-"))
      : opts.workspaceDir
        ? (() => {
            const dir = join(opts.workspaceDir, "browser-profile");
            if (!existsSync(dir)) {
              // workspace exists; the profile dir is created by chrome itself
              void import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
            }
            return dir;
          })()
        : mkdtempSync(join(tmpdir(), "muster-bot-profile-"));
  const cdpPort = await freeCdpPort();
  // Chromium's setuid sandbox can't work in containers (no user namespaces
  // under the default seccomp profile) and dies as root on any host — so
  // launch sandboxless only there. Desktop, the case that matters, stays
  // sandboxed.
  const isRoot = (process.getuid?.() ?? -1) === 0;
  const inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv") || process.env.OMB_CONTAINER === "1";
  const containerFlags = isRoot || inContainer ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : [];
  const child = launcher.spawn(
    chrome,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=DialMediaRouteProvider",
      "--window-size=1280,800",
      ...containerFlags,
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  const session: Session = {
    child,
    profile,
    userDataDir,
    cdpPort,
    ws: null,
    targetId: null,
    frame: null,
    frameAt: 0,
    url: null,
    title: null,
    takeControl: false,
    startedAt: Date.now(),
    error: null,
    dying: false,
  };
  sessions.set(botId, session);
  child.on("exit", () => {
    if (!session.dying) {
      session.error = "the browser closed unexpectedly";
      sessions.delete(botId);
    }
  });
  // chromium's debugger endpoint needs a beat to come up — and a container's
  // very first launch after boot can take 15s+ (cold page cache, fontconfig
  // building its cache), which exhausted the old 10s budget and 502'd the
  // first panel click after every deploy. 90 × 300ms ≈ 27s covers cold
  // start; a browser that died mid-poll fails fast instead of being polled
  // as a corpse for the full budget.
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((r) => setTimeout(r, 300));
    if (session.error && !session.dying) {
      stopPanel(botId);
      throw new Error(`browser session failed to start: ${session.error}`);
    }
    try {
      await attach(session);
      return panelState(botId);
    } catch (e) {
      if (attempt === 89) {
        session.error = e instanceof Error ? e.message : String(e);
        stopPanel(botId);
        throw new Error(`browser session failed to start: ${session.error}`);
      }
    }
  }
  throw new Error("browser session failed to start");
}
