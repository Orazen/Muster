// Browser panel session manager — a harness-owned Chromium the HUMAN can
// watch and drive from the chat's Browser side panel (the OpenMausBot
// "Quill's browser" pattern). This is deliberately NOT the bot's Obscura
// browser: obscura is stealth + headless and lives only for the duration of
// a turn, spawned by the CLI's MCP layer. This session is long-lived,
// visible, and shared: the human types a URL or watches frames; a future
// step attaches the bot's browser tools to the same session so "take
// control" pauses the bot mid-task.
//
// One Chromium per bot. Profiles keep logins separate: "Bot's own"
// (persistent user-data-dir under the bot's workspace) vs "Guest" (a scratch
// dir wiped on switch). CDP drives navigation and the Page.startScreencast
// frame feed; frames are kept in memory, one JPEG deep, and served to the
// panel. Take-control is a flag the panel and (later) the bot's attach
// layer read — while it is set, the panel shows the takeover banner.
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
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";

export interface BrowserPanelState {
  running: boolean;
  url: string | null;
  title: string | null;
  profile: "bot" | "guest";
  takeControl: boolean;
  startedAt: number | null;
  error: string | null;
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

async function cdp(session: Session, method: string, params: Json = {}): Promise<any> {
  const ws = session.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("browser session is not connected");
  return await new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id === id) {
          ws.removeEventListener("message", onMessage);
          if (msg.error) reject(new Error(String(msg.error.message ?? "CDP error")));
          else resolve(msg.result);
        }
      } catch {
        /* non-JSON frame */
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("CDP call timed out"));
    }, 15_000);
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
        if (frame.ackId) {
          ws.send(JSON.stringify({ method: "Page.screencastFrameAck", params: { sessionId: frame.ackId } }));
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
  await cdp(session, "Page.startScreencast", {
    format: "jpeg",
    quality: 55,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });
}

// (string decoding lives in str()/decodeTargets()/decodeScreencastFrame())

export function panelState(botId: string): BrowserPanelState {
  const s = sessions.get(botId);
  if (!s) return { running: false, url: null, title: null, profile: "bot", takeControl: false, startedAt: null, error: null };
  return {
    running: true,
    url: s.url,
    title: s.title,
    profile: s.profile,
    takeControl: s.takeControl,
    startedAt: s.startedAt,
    error: s.error,
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

export async function navigatePanel(botId: string, rawUrl: string): Promise<BrowserPanelState> {
  const s = sessions.get(botId);
  if (!s) throw new Error("no browser session open");
  const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  if (!isNavigableUrl(withScheme)) throw new Error("that address is not allowed — http/https public sites only");
  s.takeControl = true; // human is driving
  await cdp(s, "Page.navigate", { url: withScheme });
  s.url = withScheme;
  return panelState(botId);
}

export async function startPanel(botId: string, opts: { workspaceDir?: string; profile?: "bot" | "guest" }): Promise<BrowserPanelState> {
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
  const child = spawn(
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
  // chromium's debugger endpoint needs a beat to come up
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await attach(session);
      return panelState(botId);
    } catch (e) {
      if (attempt === 39) {
        session.error = e instanceof Error ? e.message : String(e);
        stopPanel(botId);
        throw new Error(`browser session failed to start: ${session.error}`);
      }
    }
  }
  throw new Error("browser session failed to start");
}
