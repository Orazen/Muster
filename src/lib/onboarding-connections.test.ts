import { afterEach, describe, expect, it, vi } from "vitest";
import { onboardingConsentUrl, onboardingDriveReturn, prepareOnboardingConsent, readOnboardingDrive, readOnboardingGmail } from "./onboarding-connections";
import { sessionRecheck } from "./session-recheck";

const signal = () => new AbortController().signal;
const catalog = { configured: true, cards: [{ slug: "gmail" }] };
const gate = { required: true, satisfied: true };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

describe("onboarding connection verification", () => {
  it("checks account Drive and fresh server gate without promoting query parameters", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ accountDrive: { available: true, connected: true } }))
      .mockResolvedValueOnce(Response.json({ storageGate: gate }));
    const abort = signal();
    await expect(readOnboardingDrive(abort, fetcher)).resolves.toEqual({ available: true, connected: true, gate, localBackupReady: false });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/workspace/google/status", "/api/config"]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: "GET", credentials: "include", redirect: "error", cache: "no-store", signal: abort });
  });

  it("does not claim connected when the refreshed required gate says otherwise", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ accountDrive: { available: true, connected: true } }))
      .mockResolvedValueOnce(Response.json({ storageGate: { required: true, satisfied: false } }));
    await expect(readOnboardingDrive(signal(), fetcher)).resolves.toMatchObject({ connected: false });
  });

  it("rejects installation-only Drive status rather than presenting an account as connected", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ installationDrive: { configured: true } }))
      .mockResolvedValueOnce(Response.json({ storageGate: gate }));
    await expect(readOnboardingDrive(signal(), fetcher)).rejects.toThrow("Drive status could not be verified");
  });

  for (const local of [true, false]) {
    it(`keeps desktop backup availability distinct from account Drive (${local})`, async () => {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ accountDrive: { available: false, connected: false }, workspaceBackupAvailable: local, installationDrive: { configured: true } }))
        .mockResolvedValueOnce(Response.json({ storageGate: { required: !local, satisfied: false } }));
      await expect(readOnboardingDrive(signal(), fetcher)).resolves.toMatchObject({ connected: false, localBackupReady: local });
    });
  }

  it("keeps an unavailable account optional even when a catalog lists Gmail", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...catalog, configured: false, reason: "Not available to this account" }));
    await expect(readOnboardingGmail(signal(), fetcher)).resolves.toEqual({ kind: "unavailable", reason: "Not available to this account" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not offer a Gmail authorization absent from the configured catalog", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ configured: true, cards: [{ slug: "slack" }] }));
    await expect(readOnboardingGmail(signal(), fetcher)).resolves.toMatchObject({ kind: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  for (const [state, expected] of [
    [{ connected: true, pending: false }, "connected"],
    [{ connected: false, pending: true }, "pending"],
    [{ connected: false, pending: false, status: "EXPIRED" }, "disconnected"],
  ] as const) {
    it(`reads Gmail ${expected} from service status, not the authorization link`, async () => {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(catalog))
        .mockResolvedValueOnce(Response.json({ configured: true, services: { gmail: state } }));
      await expect(readOnboardingGmail(signal(), fetcher)).resolves.toEqual({ kind: expected });
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/connectors/catalog", "/api/connectors?services=gmail"]);
    });
  }

  it("respects a capability being revoked between catalog and status", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json({ configured: false, services: {} }));
    await expect(readOnboardingGmail(signal(), fetcher)).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("keeps a missing Gmail status unknown rather than calling it disconnected", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json({ configured: true, services: {} }));
    await expect(readOnboardingGmail(signal(), fetcher)).rejects.toThrow("Gmail status could not be verified");
  });

  it("preserves provider refusal text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "Connection service is temporarily unavailable" }, { status: 503 }));
    await expect(readOnboardingGmail(signal(), fetcher)).rejects.toThrow("Connection service is temporarily unavailable");
  });

  it("rechecks a connection 401 without claiming that a valid session is signed out", async () => {
    const recheck = vi.fn(async () => {});
    cleanups.push(sessionRecheck.register(recheck));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "Gmail permission needs renewal" }, { status: 401 }));
    await expect(readOnboardingGmail(signal(), fetcher)).rejects.toThrow("Gmail permission needs renewal");
    await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(1));
  });

  it("does not recheck an aborted connection 401 even if the transport ignored abort", async () => {
    const recheck = vi.fn(async () => {});
    cleanups.push(sessionRecheck.register(recheck));
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return Response.json({ error: "Late connection refusal" }, { status: 401 });
    });
    await expect(readOnboardingGmail(controller.signal, fetcher)).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(recheck).not.toHaveBeenCalled();
  });

  it("captures session ownership before a request so a late 401 cannot recheck a replacement account", async () => {
    const original = vi.fn(async () => {}), replacement = vi.fn(async () => {});
    cleanups.push(sessionRecheck.register(original));
    let reply!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => { reply = resolve; }));
    const pending = readOnboardingGmail(signal(), fetcher);
    cleanups.push(sessionRecheck.register(replacement));
    reply(Response.json({}, { status: 401 }));
    await expect(pending).rejects.toThrow("Could not check this connection. Try again.");
    await Promise.resolve();
    expect(original).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  });

  it("discards a response after cancellation even if the transport ignored abort", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return Response.json(catalog);
    });
    await expect(readOnboardingGmail(controller.signal, fetcher)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Drive return marker", () => {
  it("preserves OS shell, other query values and hash after denied consent", () => {
    expect(onboardingDriveReturn({ pathname: "/os", search: "?template=calendar&drive=connect-failed&from=watch", hash: "#today" }))
      .toEqual({ outcome: "connect-failed", cleaned: "/os?template=calendar&from=watch#today" });
  });

  it("does not leave a question mark when the successful marker was the only query", () => {
    expect(onboardingDriveReturn({ pathname: "/app", search: "?drive=connected", hash: "" }))
      .toEqual({ outcome: "connected", cleaned: "/app" });
  });

  it("leaves unrelated or unknown callback values alone", () => {
    expect(onboardingDriveReturn({ pathname: "/app", search: "?drive=other&template=calendar", hash: "#bot" })).toBeNull();
    expect(onboardingDriveReturn({ pathname: "/app", search: "?template=calendar", hash: "" })).toBeNull();
  });
});

describe("explicit connection consent", () => {
  it("requests Drive with GET and Gmail with POST without sending keys or scopes", async () => {
    const drive = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=owned" }));
    const gmail = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: "https://connect.composio.dev/link/owned" }));
    await expect(prepareOnboardingConsent("drive", signal(), drive)).resolves.toBe("https://accounts.google.com/o/oauth2/v2/auth?state=owned");
    await expect(prepareOnboardingConsent("gmail", signal(), gmail)).resolves.toBe("https://connect.composio.dev/link/owned");
    expect(drive.mock.calls[0]).toEqual(["/api/workspace/google/connect", expect.objectContaining({ method: "GET" })]);
    expect(gmail.mock.calls[0]).toEqual(["/api/connectors/gmail/authorize", expect.objectContaining({ method: "POST" })]);
    expect(drive.mock.calls[0][1]).not.toHaveProperty("body");
    expect(gmail.mock.calls[0][1]).not.toHaveProperty("body");
  });

  for (const url of ["javascript:alert(1)", "http://accounts.google.com/o/oauth2/v2/auth", "https://user:secret@accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com.evil.test/o/oauth2/v2/auth", "https://accounts.google.com:8443/o/oauth2/v2/auth", "https://accounts.google.com/signin"]) {
    it(`rejects an unexpected Drive destination: ${url}`, () => {
      expect(() => onboardingConsentUrl({ url }, "drive")).toThrow("could not be verified");
    });
  }

  it("rejects unsafe Gmail schemes and credential-bearing links", () => {
    for (const url of ["javascript:alert(1)", "http://connect.composio.dev/link", "https://user:secret@connect.composio.dev/link", "file:///tmp/consent"]) {
      expect(() => onboardingConsentUrl({ url }, "gmail")).toThrow("could not be verified");
    }
  });
});
