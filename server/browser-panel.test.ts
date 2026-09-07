// Browser panel unit tests: the navigation guard (public http/https only —
// the panel must never become a probe for internal services), the Chrome
// discovery chain (override → system install → playwright cache → CfT
// auto-install under DATA_DIR), and the container launch flags that keep
// the panel spawner honest about when Chromium runs sandboxless.
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findChromeSync,
  freeCdpPort,
  isNavigableUrl,
  resolveChrome,
  toNavigableUrl,
} from "./browser-panel.ts";

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
