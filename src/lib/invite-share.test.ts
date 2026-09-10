import { afterEach, describe, expect, it, vi } from "vitest";
import { copyShareLink, createWrappedShare, loadReferralInfo } from "./invite-share";

afterEach(() => vi.unstubAllGlobals());

const referral = { code: "invite-fixture", bankedDays: 14, inviteeDays: 7 };
const wrappedPath = "/w/0123456789abcdefghijkl";

describe("referral requests", () => {
  it("loads the server's referral offer without changing reward values", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(referral));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await expect(loadReferralInfo(controller.signal)).resolves.toEqual(referral);
    expect(fetch).toHaveBeenCalledWith("/api/referral/code", expect.objectContaining({ signal: controller.signal, credentials: "include" }));
  });

  it("reports an HTTP failure and permits a subsequent successful retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(referral));
    vi.stubGlobal("fetch", fetch);

    await expect(loadReferralInfo(new AbortController().signal)).rejects.toThrow(/HTTP 503.*Try again/);
    await expect(loadReferralInfo(new AbortController().signal)).resolves.toEqual(referral);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, { ...referral, code: {} }, { ...referral, bankedDays: null }, { code: "invite-fixture" }])(
    "rejects a malformed referral response instead of rendering broken rewards: %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(loadReferralInfo(new AbortController().signal)).rejects.toThrow(/invalid invite link/);
    },
  );

  it("turns a connection rejection into a readable retry message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(loadReferralInfo(new AbortController().signal)).rejects.toThrow(/Check your connection and try again/);
  });

  it("does not start a request after the section has already been cancelled", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();

    await expect(loadReferralInfo(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a pending transport without presenting a connection failure", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    const controller = new AbortController();
    const pending = loadReferralInfo(controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("discards a late response even when the transport ignores cancellation", async () => {
    let release = () => {};
    const response = new Promise<Response>((resolve) => { release = () => resolve(Response.json(referral)); });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(response));
    const controller = new AbortController();
    const pending = loadReferralInfo(controller.signal);
    controller.abort();
    release();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("Wrapped link creation", () => {
  it("returns a local absolute share link after the server creates it", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ url: wrappedPath }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createWrappedShare("http://127.0.0.1:18861", new AbortController().signal))
      .resolves.toBe(`http://127.0.0.1:18861${wrappedPath}`);
    expect(fetch).toHaveBeenCalledWith("/api/wrapped/share", expect.objectContaining({ method: "POST" }));
  });

  it("reports a rejected share request instead of claiming a link was created", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "sign in" }, { status: 401 })));
    await expect(createWrappedShare("http://127.0.0.1:18861", new AbortController().signal)).rejects.toThrow(/HTTP 401/);
  });

  it.each([{ url: "https://example.com/other" }, { url: null }, {}])(
    "rejects a response without a usable local share link: %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(createWrappedShare("http://127.0.0.1:18861", new AbortController().signal)).rejects.toThrow(/invalid Wrapped link/);
    },
  );
});

describe("copying share links", () => {
  it("does not report success before the clipboard write finishes", async () => {
    let finish = () => {};
    const write = new Promise<void>((resolve) => { finish = resolve; });
    const writeText = vi.fn().mockReturnValue(write);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    let copied = false;
    const pending = copyShareLink("https://example.test/sign-up?ref=fixture").then(() => { copied = true; });
    await Promise.resolve();
    expect(copied).toBe(false);
    finish();
    await pending;
    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.test/sign-up?ref=fixture");
  });

  it("provides a manual-copy fallback when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyShareLink("https://example.test/w/fixture")).rejects.toThrow(/Clipboard unavailable.*Select the link/);
  });

  it("reports denied clipboard access instead of a false success", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) } });
    await expect(copyShareLink("https://example.test/w/fixture")).rejects.toThrow(/Could not copy the link/);
  });
});
