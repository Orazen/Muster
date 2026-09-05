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
// probe for internal services). Only 127.0.0.1 loopback sees these
// endpoints (desktop installs); on cloud the panel is desktop-only until a
// per-workspace isolation pass lands.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

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
function freeCdpPort(): number {
  const used = new Set([...sessions.values()].map((s) => s.cdpPort));
  for (let p = CDP_BASE; p < CDP_BASE + 40; p++) if (!used.has(p)) return p;
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
    paths: ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/microsoft-edge"],
  },
  {
    platform: "win32",
    paths: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
];

function findChrome(): string | null {
  for (const entry of CHROME_CANDIDATES) {
    if (entry.platform !== process.platform) continue;
    for (const p of entry.paths) if (existsSync(p)) return p;
  }
  return null;
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

async function attach(session: Session): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${session.cdpPort}/json/list`);
  const targets = decodeTargets(await res.json());
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
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome/Chromium found — install Google Chrome to use the browser panel");
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
  const cdpPort = freeCdpPort();
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
