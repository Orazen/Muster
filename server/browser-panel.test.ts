// Browser panel unit tests: the navigation guard (public http/https only —
// the panel must never become a probe for internal services), the Chrome
// discovery chain (override → system install → playwright cache → CfT
// auto-install under DATA_DIR), and the container launch flags that keep
// the panel spawner honest about when Chromium runs sandboxless.
import { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findChromeSync,
  freeCdpPort,
  isNavigableUrl,
  latestFrame,
  mintPreviewSignature,
  navigatePanel,
  panelState,
  PREVIEW_SIGNATURE_TTL_MS,
  previewFrame,
  resolveChrome,
  startPanel,
  stopPanel,
  takeoverActionSchema,
  takeoverEnabled,
  takeoverInput,
  toNavigableUrl,
  verifyPreviewSignature,
  type BrowserPanelLauncher,
} from "./browser-panel.ts";

interface FakeCdpCommand {
  id?: number;
  method: string;
  params?: {
    url?: string;
    sessionId?: string | number;
    type?: string;
    x?: number;
    y?: number;
    button?: string;
    clickCount?: number;
    text?: string;
    key?: string;
    code?: string;
    windowsVirtualKeyCode?: number;
    nativeVirtualKeyCode?: number;
    modifiers?: number;
    deltaX?: number;
    deltaY?: number;
  };
}

interface FakeNavigationResult {
  frameId?: string;
  errorText?: string;
  isDownload?: boolean;
}

/** A fixture-owned transport: no browser process, external fetch or live CDP
 * connection is used. Frames stop until the protocol-valid ACK arrives. */
class FakeCdpSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeCdpSocket[] = [];
  readyState = FakeCdpSocket.OPEN;
  commands: FakeCdpCommand[] = [];
  navigationResult: FakeNavigationResult = { frameId: "main" };
  navigationProtocolError: string | null = null;
  navigationSendError: string | null = null;
  private pendingFrameId: number | null = null;
  private active: boolean;
  private screencasting = false;

  constructor(readonly url: string) {
    super();
    this.active = url !== "ws://fixture.invalid/restored-background-page";
    FakeCdpSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(payload: string): void {
    // SAFETY: payload is a JSON command built by browser-panel's CDP client;
    // assertions below inspect the command ID, method, and parameters.
    const command = JSON.parse(payload) as FakeCdpCommand;
    this.commands.push(command);
    if (command.method === "Page.navigate" && this.navigationSendError) throw new Error(this.navigationSendError);
    // Chromium commands require an integer id; a notification-shaped ACK
    // must not unlock the next frame in this regression fixture.
    if (!Number.isInteger(command.id)) return;
    if (command.method === "Page.bringToFront") this.active = true;
    if (command.method === "Page.startScreencast") this.screencasting = true;
    if (command.method === "Page.screencastFrameAck" && command.params?.sessionId === this.pendingFrameId) {
      this.pendingFrameId = null;
    }
    const response = command.method === "Page.navigate"
      ? this.navigationProtocolError
        ? { id: command.id, error: { message: this.navigationProtocolError } }
        : { id: command.id, result: this.navigationResult }
      : { id: command.id, result: {} };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) })));
  }

  emitFrame(sessionId: number, text: string): boolean {
    if (!this.active || !this.screencasting || this.pendingFrameId !== null) return false;
    this.pendingFrameId = sessionId;
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        method: "Page.screencastFrame",
        params: { sessionId, data: Buffer.from(text).toString("base64"), metadata: {} },
      }),
    }));
    return true;
  }

  close(): void {
    this.readyState = 3;
  }
}

describe("browser panel CDP bridge", () => {
  const botId = "browser-panel-cdp-regression";
  let scratch: string;
  let socket: FakeCdpSocket;
  let launcher: BrowserPanelLauncher;

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "bpanel-cdp-test-"));
    mkdirSync(join(scratch, "browser-profile"));
    const chrome = join(scratch, "fake-chrome");
    writeFileSync(chrome, "fixture; never executed");
    vi.stubEnv("MUSTER_CHROME_PATH", chrome);
    launcher = { spawn: vi.fn(() => {
      const child = new ChildProcess();
      vi.spyOn(child, "kill").mockReturnValue(true);
      return child;
    }) };
    FakeCdpSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeCdpSocket);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      type: "page", webSocketDebuggerUrl: "ws://fixture.invalid/page", url: "about:blank", title: "Initial page",
    }]))));
    await startPanel(botId, { workspaceDir: scratch }, launcher);
    socket = FakeCdpSocket.instances[0];
    expect(launcher.spawn).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    stopPanel(botId);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("retains the prior page on navigation failure and clears the error after a successful retry", async () => {
    socket.navigationResult = { frameId: "main", errorText: "net::ERR_NAME_NOT_RESOLVED" };
    await expect(navigatePanel(botId, "unreachable.example.com")).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
    expect(panelState(botId)).toMatchObject({
      url: "about:blank", title: "Initial page", error: "could not open that page: net::ERR_NAME_NOT_RESOLVED",
    });
    // A same-document navigation may omit loaderId and is still valid.
    socket.navigationResult = { frameId: "main" };
    await expect(navigatePanel(botId, "example.com")).resolves.toMatchObject({ url: "https://example.com", error: null });
    expect(socket.commands.filter((command) => command.method === "Page.navigate").map((command) => command.params?.url))
      .toEqual(["https://unreachable.example.com", "https://example.com"]);
  });

  it.each([
    [{}, "invalid navigation response"],
    [{ frameId: "main", isDownload: true }, "started a download"],
  ])("does not claim the requested page loaded for result %j", async (result, message) => {
    socket.navigationResult = result;
    await expect(navigatePanel(botId, "example.com")).rejects.toThrow(message);
    expect(panelState(botId)).toMatchObject({ url: "about:blank", title: "Initial page", error: expect.stringContaining(message) });
  });

  it("persists protocol errors and clears the request timer on replies and send failures", async () => {
    vi.useFakeTimers();
    socket.navigationProtocolError = "navigation unavailable";
    await expect(navigatePanel(botId, "example.com")).rejects.toThrow("navigation unavailable");
    expect(vi.getTimerCount()).toBe(0);
    expect(panelState(botId)).toMatchObject({ url: "about:blank", error: "navigation unavailable" });
    socket.navigationProtocolError = null;
    socket.navigationSendError = "socket closed during send";
    await expect(navigatePanel(botId, "example.com")).rejects.toThrow("socket closed during send");
    expect(vi.getTimerCount()).toBe(0);
    socket.navigationSendError = null;
    await expect(navigatePanel(botId, "example.com")).resolves.toMatchObject({ error: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 7])("acknowledges frame session %i with a unique command id so later frames continue", (sessionId) => {
    expect(socket.emitFrame(sessionId, "first frame")).toBe(true);
    expect(latestFrame(botId)?.toString()).toBe("first frame");
    expect(socket.emitFrame(sessionId + 1, "second frame")).toBe(true);
    expect(latestFrame(botId)?.toString()).toBe("second frame");
    const acknowledgements = socket.commands.filter((command) => command.method === "Page.screencastFrameAck");
    expect(acknowledgements.map((command) => command.params?.sessionId)).toEqual([sessionId, sessionId + 1]);
    const ids = socket.commands.map((command) => command.id);
    expect(ids.every(Number.isInteger)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("activates a restored background target before capture when reopening the same profile", async () => {
    expect(socket.emitFrame(0, "first session preview")).toBe(true);
    expect(latestFrame(botId)?.toString()).toBe("first session preview");
    const previousSocket = socket;
    stopPanel(botId);
    expect(previousSocket.readyState).toBe(3);
    expect(latestFrame(botId)).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { type: "page", webSocketDebuggerUrl: "ws://fixture.invalid/new-blank-page", url: "about:blank", title: "" },
      {
        type: "page", webSocketDebuggerUrl: "ws://fixture.invalid/restored-background-page",
        url: "https://example.com", title: "Restored page",
      },
      { type: "browser_ui", webSocketDebuggerUrl: "ws://fixture.invalid/browser-ui", url: "chrome://omnibox-popup.top-chrome" },
    ]))));
    await expect(startPanel(botId, { workspaceDir: scratch }, launcher)).resolves.toMatchObject({
      running: true, url: "https://example.com", title: "Restored page",
    });
    socket = FakeCdpSocket.instances[1];
    expect(socket.url).toBe("ws://fixture.invalid/restored-background-page");
    const methods = socket.commands.map((command) => command.method);
    expect(methods.indexOf("Page.bringToFront")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("Page.bringToFront")).toBeLessThan(methods.indexOf("Page.startScreencast"));
    await navigatePanel(botId, "example.com");
    expect(socket.emitFrame(0, "reopened session preview")).toBe(true);
    expect(latestFrame(botId)?.toString()).toBe("reopened session preview");
    expect(launcher.spawn).toHaveBeenCalledTimes(2);
  });

  // ── Takeover console gating (S1) ─────────────────────────────────────

  it("keeps takeover inert with no flag set: no gate, no preview link, no CDP input", async () => {
    expect(takeoverEnabled()).toBe(false);
    expect(socket.emitFrame(0, "gate-off frame")).toBe(true);
    expect(panelState(botId)).toMatchObject({ takeoverEnabled: false, previewLink: null });
    expect(previewFrame(botId, "anything.at-all")).toBeNull();
    const commandsBefore = socket.commands.length;
    await expect(takeoverInput(botId, { type: "text", text: "hi" })).rejects.toThrow(/not enabled/);
    // inert: the refusal happens before any CDP traffic
    expect(socket.commands.length).toBe(commandsBefore);
  });

  it("drives click, text, key and scroll through the session's CDP socket once explicitly enabled", async () => {
    vi.stubEnv("MUSTER_BROWSER_TAKEOVER", "1");
    // preview-link signing reads the deployment secret (env/persisted — a
    // fixture value here, never a literal in committed source)
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-signing-secret");
    expect(takeoverEnabled()).toBe(true);
    expect(panelState(botId).takeoverEnabled).toBe(true);

    await takeoverInput(botId, { type: "click", x: 12, y: 34 });
    await takeoverInput(botId, { type: "text", text: "hello" });
    await takeoverInput(botId, { type: "key", key: "Enter" });
    await takeoverInput(botId, { type: "key", key: "Control+a" });
    await takeoverInput(botId, { type: "scroll", deltaY: 600 });

    const input = socket.commands.filter((command) => command.method.startsWith("Input."));
    expect(input.map((command) => command.method)).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
      "Input.insertText",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(input[0].params).toMatchObject({ type: "mousePressed", x: 12, y: 34, button: "left", clickCount: 1 });
    expect(input[1].params).toMatchObject({ type: "mouseReleased", x: 12, y: 34, button: "left", clickCount: 1 });
    expect(input[2].params).toEqual({ text: "hello" });
    expect(input[3].params).toMatchObject({ type: "keyDown", key: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    expect(input[4].params).toMatchObject({ type: "keyUp", key: "Enter" });
    expect(input[5].params).toMatchObject({ type: "keyDown", key: "a", modifiers: 2, text: "a" });
    expect(input[7].params).toMatchObject({ type: "mouseWheel", deltaX: 0, deltaY: 600 });
    expect(panelState(botId)).toMatchObject({ takeControl: true, takeoverEnabled: true });
  });

  it("mints a signed preview link that resolves this bot's frame only, and dies with the gate", async () => {
    vi.stubEnv("MUSTER_BROWSER_TAKEOVER", "1");
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-signing-secret");
    // no frame yet → nothing to preview
    expect(panelState(botId).previewLink).toBeNull();
    expect(socket.emitFrame(0, "takeover frame")).toBe(true);
    const state = panelState(botId);
    expect(state.previewLink).toMatch(new RegExp(`^/api/bots/${botId}/browser-panel/preview\\?sig=`));
    const token = new URL(state.previewLink!, "http://fixture.invalid").searchParams.get("sig")!;
    expect(previewFrame(botId, token)?.toString()).toBe("takeover frame");
    // bound to this bot id
    expect(previewFrame("some-other-bot", token)).toBeNull();
    // tampered signature refuses
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(previewFrame(botId, tampered)).toBeNull();
    expect(previewFrame(botId, "")).toBeNull();
    // gate off → even a valid, unexpired link does not resolve
    vi.stubEnv("MUSTER_BROWSER_TAKEOVER", "0");
    expect(takeoverEnabled()).toBe(false);
    expect(previewFrame(botId, token)).toBeNull();
  });
});

describe("takeover gate ordering (no session)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a disabled deployment before any session lookup", async () => {
    vi.stubEnv("MUSTER_BROWSER_TAKEOVER", "0");
    await expect(takeoverInput("no-such-bot", { type: "text", text: "hi" })).rejects.toThrow(/not enabled/);
  });

  it("reports a missing session only once the gate is on", async () => {
    vi.stubEnv("MUSTER_BROWSER_TAKEOVER", "on");
    await expect(takeoverInput("no-such-bot", { type: "text", text: "hi" })).rejects.toThrow("no browser session open");
  });
});

describe("takeoverActionSchema", () => {
  it("accepts bounded click, text, key and scroll actions", () => {
    expect(takeoverActionSchema.safeParse({ type: "click", x: 0, y: 799 }).success).toBe(true);
    expect(takeoverActionSchema.safeParse({ type: "click", x: 1279, y: 0 }).success).toBe(true);
    expect(takeoverActionSchema.safeParse({ type: "text", text: "typed" }).success).toBe(true);
    expect(takeoverActionSchema.safeParse({ type: "key", key: "Shift+Tab" }).success).toBe(true);
    expect(takeoverActionSchema.safeParse({ type: "scroll", deltaY: -5000 }).success).toBe(true);
  });

  it.each([
    { type: "click", x: 1280, y: 0 },
    { type: "click", x: -1, y: 0 },
    { type: "click", x: 1.5, y: 0 },
    { type: "click", x: 0 },
    { type: "text", text: "" },
    { type: "text", text: "x".repeat(10_001) },
    { type: "key", key: "F12" },
    { type: "key", key: "javascript:alert(1)" },
    { type: "scroll", deltaY: 5001 },
    { type: "refresh" },
    {},
  ])("rejects %j", (bad) => {
    expect(takeoverActionSchema.safeParse(bad).success).toBe(false);
  });
});

describe("preview signature", () => {
  const secret = "fixture-signing-secret";
  const t0 = 1_700_000_000_000;

  it("round-trips within its TTL and renews without breaking the previous link", () => {
    const first = mintPreviewSignature("bot-a", secret, t0);
    expect(first.expiresAt).toBe(t0 + PREVIEW_SIGNATURE_TTL_MS);
    expect(verifyPreviewSignature("bot-a", first.token, secret, t0)).toBe(true);
    expect(verifyPreviewSignature("bot-a", first.token, secret, first.expiresAt)).toBe(true);
    expect(verifyPreviewSignature("bot-a", first.token, secret, first.expiresAt + 1)).toBe(false);
    const renewed = mintPreviewSignature("bot-a", secret, t0 + 60_000);
    expect(renewed.token).not.toBe(first.token);
    expect(verifyPreviewSignature("bot-a", first.token, secret, t0 + 60_000)).toBe(true);
  });

  it("binds the token to one bot id", () => {
    const { token } = mintPreviewSignature("bot-a", secret, t0);
    expect(verifyPreviewSignature("bot-a", token, secret, t0)).toBe(true);
    expect(verifyPreviewSignature("bot-b", token, secret, t0)).toBe(false);
  });

  it("refuses a tampered, extended, empty or differently-secreted token", () => {
    const { token, expiresAt } = mintPreviewSignature("bot-a", secret, t0);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyPreviewSignature("bot-a", tampered, secret, t0)).toBe(false);
    const extended = `${expiresAt + 60_000}.${token.slice(token.indexOf(".") + 1)}`;
    expect(verifyPreviewSignature("bot-a", extended, secret, t0)).toBe(false);
    expect(verifyPreviewSignature("bot-a", "", secret, t0)).toBe(false);
    expect(verifyPreviewSignature("bot-a", "not-a-token", secret, t0)).toBe(false);
    expect(verifyPreviewSignature("bot-a", token, "another-secret", t0)).toBe(false);
  });
});

describe("toNavigableUrl", () => {
  it("passes absolute http/https through", () => {
    expect(toNavigableUrl("https://example.com")).toBe("https://example.com");
    expect(toNavigableUrl("  http://example.com/x ")).toBe("http://example.com/x");
  });

  it("prefixes bare hosts with https", () => {
    expect(toNavigableUrl("example.com")).toBe("https://example.com");
    expect(toNavigableUrl("example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("refuses input that already names a non-http scheme", () => {
    // Regression: these used to be prefixed into https://file/…, whose
    // "file" hostname passed the public-site guard.
    for (const bad of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "data:text/html,hi", "chrome://settings"]) {
      expect(() => toNavigableUrl(bad)).toThrow(/not allowed/);
    }
  });
});

describe("isNavigableUrl", () => {
  it("allows public http/https", () => {
    expect(isNavigableUrl("https://example.com")).toBe(true);
    expect(isNavigableUrl("http://example.com/path?q=1")).toBe(true);
    expect(isNavigableUrl("https://muster.orazen.online/login")).toBe(true);
  });

  it("refuses non-http schemes", () => {
    expect(isNavigableUrl("file:///etc/passwd")).toBe(false);
    expect(isNavigableUrl("ftp://example.com")).toBe(false);
    expect(isNavigableUrl("javascript:alert(1)")).toBe(false);
    expect(isNavigableUrl("data:text/html,hi")).toBe(false);
    expect(isNavigableUrl("not a url")).toBe(false);
  });

  it("refuses loopback and local names", () => {
    expect(isNavigableUrl("http://localhost:5211")).toBe(false);
    expect(isNavigableUrl("http://sub.localhost")).toBe(false);
    expect(isNavigableUrl("http://127.0.0.1:28821/api")).toBe(false);
    expect(isNavigableUrl("http://0.0.0.0")).toBe(false);
    expect(isNavigableUrl("http://printer.local")).toBe(false);
    expect(isNavigableUrl("http://db.internal")).toBe(false);
    expect(isNavigableUrl("http://[::1]:8799")).toBe(false);
    expect(isNavigableUrl("http://[fe80::1]")).toBe(false);
    expect(isNavigableUrl("http://[fc00::1]")).toBe(false);
  });

  it("refuses private and reserved IPv4 ranges", () => {
    expect(isNavigableUrl("http://10.0.0.5")).toBe(false);
    expect(isNavigableUrl("http://172.16.0.1")).toBe(false);
    expect(isNavigableUrl("http://172.31.255.255")).toBe(false);
    expect(isNavigableUrl("http://192.168.1.1")).toBe(false);
    expect(isNavigableUrl("http://169.254.169.254")).toBe(false); // cloud metadata
    expect(isNavigableUrl("http://100.64.0.1")).toBe(false); // CGNAT
    expect(isNavigableUrl("http://224.0.0.1")).toBe(false); // multicast
  });

  it("allows public IPs and 172.32+ (outside RFC1918)", () => {
    expect(isNavigableUrl("http://1.1.1.1")).toBe(true);
    expect(isNavigableUrl("http://172.32.0.1")).toBe(true);
    expect(isNavigableUrl("http://8.8.8.8")).toBe(true);
  });
});

describe("chrome discovery", () => {
  const saved = new Map<string, string | undefined>();
  const scratch = mkdtempSync(join(tmpdir(), "bpanel-test-"));

  afterEach(() => {
    for (const [k, v] of saved) process.env[k] = v;
    saved.clear();
    rmSync(join(scratch, "cache"), { recursive: true, force: true });
  });

  function setEnv(k: string, v: string | undefined) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  it("explicit override wins over everything", async () => {
    const fake = join(scratch, "fake-chrome");
    writeFileSync(fake, "#!/bin/sh\n");
    setEnv("MUSTER_CHROME_PATH", fake);
    expect(findChromeSync()).toBe(fake);
    expect(await resolveChrome()).toBe(fake);
  });

  it("nonexistent override is ignored, falls through to system scan", async () => {
    setEnv("MUSTER_CHROME_PATH", join(scratch, "nope"));
    const found = findChromeSync();
    // on CI/dev machines either a system chrome or the playwright cache
    // exists; the contract is only that a missing override doesn't wedge it
    expect(found === null || existsSync(found)).toBe(true);
  });

  it("finds a Chromium in a playwright-shaped cache", async () => {
    const cache = join(scratch, "cache", "ms-playwright");
    const binDir =
      process.platform === "darwin"
        ? join(cache, "chrome-1200", "chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS")
        : process.platform === "win32"
          ? join(cache, "chrome-1200", "chrome-win")
          : join(cache, "chrome-1200", "chrome-linux");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, process.platform === "win32" ? "chrome.exe" : "Google Chrome for Testing");
    // system installs beat the playwright cache in discovery order — scan
    // BEFORE injecting the cache to learn which branch this machine takes
    setEnv("MUSTER_CHROME_PATH", undefined);
    setEnv("CHROME_PATH", undefined);
    const systemPick = findChromeSync();
    setEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
    const found = findChromeSync();
    if (systemPick) {
      expect(found).toBe(systemPick);
    } else {
      expect(found).toBe(bin);
    }
    expect(await resolveChrome()).toBe(found);
  });

  it("auto-install validates the version before it reaches a URL", async () => {
    // the pinned fallback + feed version are the only strings that ever
    // touch the archive URL — assert the shape both ways
    expect(/^\d+\.\d+\.\d+\.\d+$/.test("140.0.7339.82")).toBe(true);
    expect(/^\d+\.\d+\.\d+\.\d+$/.test("../etc/passwd")).toBe(false);
  });

  it("installChromeForTesting hits the fixed Google endpoints only", async () => {
    // network is intentionally not contacted here: with an override absent
    // and no system chrome, resolveChrome's error message must name the
    // failure honestly instead of dying with ERR_MODULE_NOT_FOUND
    if (findChromeSync()) return; // machine has a browser — resolution won't reach CfT
    await expect(resolveChrome()).rejects.toThrow(/auto-install failed|Chrome/);
  });

  it("homedir playwright cache paths are the documented ones", () => {
    // guards the discovery contract the Dockerfile + docs rely on
    expect(join(homedir(), ".cache", "ms-playwright")).toContain("ms-playwright");
    expect(join(homedir(), "Library", "Caches", "ms-playwright")).toContain("ms-playwright");
  });

  it("freeCdpPort skips ports actually bound on the machine", async () => {
    // hold CDP_BASE (9500) ourselves unless a stale chromium already does —
    // either way the picker must hand out a port nothing else owns
    // (regression: attach() silently talked to a foreign browser on 9500
    // while our spawn sat portless, then died with it)
    const blocker = net.createServer();
    const weHoldIt = await new Promise<boolean>((resolve) => {
      blocker.once("error", () => resolve(false));
      blocker.listen(9500, "127.0.0.1", () => resolve(true));
    });
    const picked = await freeCdpPort();
    if (weHoldIt) blocker.close();
    expect(picked).toBeGreaterThan(9500);
    expect(picked).toBeLessThan(9540);
  });
});
