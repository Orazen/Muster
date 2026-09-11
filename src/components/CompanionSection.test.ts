import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { companionPairingLink } from "../lib/companion-pairing";
import { CompanionPairingCopy, CompanionStateRequests, copyCompanionPairingLink } from "./CompanionSection";

const currentTime = 10_000;
const expiresAt = 20_000;
const link = companionPairingLink({ address: "mac.local", port: 8810, token: `omb_pair_${"a".repeat(43)}`, code: "004209" });
function clock() { return vi.spyOn(Date, "now").mockReturnValue(currentTime); }
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type CompanionState = NonNullable<Awaited<ReturnType<CompanionStateRequests["read"]>>>;
const openWindow: CompanionState = {
  enabled: true, port: 8810, devices: [],
  pairing: { token: `omb_pair_${"a".repeat(43)}`, code: "004209", expiresAt },
};
const closedWindow: CompanionState = { ...openWindow, pairing: null };

describe("desktop companion state response ordering", () => {
  it("does not restore the old pairing window when a poll finishes after cancellation", async () => {
    const requests = new CompanionStateRequests();
    const oldPoll = deferred<CompanionState>();
    const reading = requests.read(() => oldPoll.promise);
    expect(await requests.mutate(async () => closedWindow)).toEqual(closedWindow);
    oldPoll.resolve(openWindow);
    expect(await reading).toBeNull();
  });

  it("skips polls and duplicate actions while a mutation is pending, then resumes reads", async () => {
    const requests = new CompanionStateRequests();
    const changing = deferred<CompanionState>();
    const mutation = requests.mutate(() => changing.promise);
    const poll = vi.fn(async () => openWindow);
    const repeatedAction = vi.fn(async () => closedWindow);
    expect(requests.mutating).toBe(true);
    expect(await requests.read(poll)).toBeNull();
    expect(await requests.mutate(repeatedAction)).toBeNull();
    expect(poll).not.toHaveBeenCalled();
    expect(repeatedAction).not.toHaveBeenCalled();
    changing.resolve(closedWindow);
    expect(await mutation).toEqual(closedWindow);
    expect(requests.mutating).toBe(false);
    expect(await requests.read(poll)).toEqual(openWindow);
  });

  it("keeps a newer poll when an older poll completes later", async () => {
    const requests = new CompanionStateRequests();
    const oldPoll = deferred<CompanionState>();
    const reading = requests.read(() => oldPoll.promise);
    expect(await requests.read(async () => closedWindow)).toEqual(closedWindow);
    oldPoll.resolve(openWindow);
    expect(await reading).toBeNull();
  });

  it("retains mutation errors and unlocks an explicit retry without restoring an older poll", async () => {
    const requests = new CompanionStateRequests();
    const oldPoll = deferred<CompanionState>();
    const reading = requests.read(() => oldPoll.promise);
    await expect(requests.mutate(async () => { throw new Error("Companion unavailable"); })).rejects.toThrow("Companion unavailable");
    expect(requests.mutating).toBe(false);
    oldPoll.resolve(openWindow);
    expect(await reading).toBeNull();
    expect(await requests.mutate(async () => closedWindow)).toEqual(closedWindow);
  });

  it.each(["read", "mutate"] as const)("invalidates a pending %s when its panel unmounts", async (operation) => {
    const requests = new CompanionStateRequests();
    const pending = deferred<CompanionState>();
    const response = requests[operation](() => pending.promise);
    requests.invalidate();
    pending.resolve(openWindow);
    expect(await response).toBeNull();
  });
});

describe("desktop pairing clipboard boundary", () => {
  it("copies the exact generated invitation, including its token and leading-zero code", async () => {
    clock();
    const write = vi.fn(async (_text: string) => undefined);
    expect(await copyCompanionPairingLink(link, expiresAt, write, () => true)).toBe("copied");
    expect(write).toHaveBeenCalledExactlyOnceWith(link);
    expect(new URL(write.mock.calls[0][0]).searchParams.get("code")).toBe("004209");
  });

  it.each([
    { link: null, expiry: expiresAt, current: true },
    { link, expiry: currentTime, current: true },
    { link, expiry: currentTime - 1, current: true },
    { link, expiry: Number.NaN, current: true },
    { link, expiry: expiresAt, current: false },
  ])("never writes a missing, expired or replaced invitation (%j)", async (input) => {
    clock();
    const write = vi.fn(async () => undefined);
    expect(await copyCompanionPairingLink(input.link, input.expiry, write, () => input.current)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("suppresses a late %s after a pairing-window replacement or unmount", async (outcome) => {
    clock();
    const clipboard = deferred();
    let current = true;
    const pending = copyCompanionPairingLink(link, expiresAt, () => clipboard.promise, () => current);
    current = false;
    if (outcome === "resolve") clipboard.resolve();
    else clipboard.reject(new Error("Old clipboard failure"));
    expect(await pending).toBeNull();
  });

  it("does not report success after the window expires while the clipboard is pending", async () => {
    const now = clock();
    const clipboard = deferred();
    const pending = copyCompanionPairingLink(link, expiresAt, () => clipboard.promise, () => true);
    now.mockReturnValue(expiresAt);
    clipboard.resolve();
    expect(await pending).toBeNull();
  });

  it("reports clipboard rejection and permits a later explicit retry", async () => {
    clock();
    const write = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Permission denied"))
      .mockResolvedValueOnce(undefined);
    expect(await copyCompanionPairingLink(link, expiresAt, write, () => true)).toBe("error");
    expect(await copyCompanionPairingLink(link, expiresAt, write, () => true)).toBe("copied");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("handles an unavailable clipboard that throws before returning a promise", async () => {
    clock();
    expect(await copyCompanionPairingLink(link, expiresAt, () => { throw new Error("Clipboard unavailable"); }, () => true)).toBe("error");
  });
});

describe("desktop pairing copy control (SSR)", () => {
  it("offers an explicit copy action without writing or exposing the invitation during render", () => {
    clock();
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const html = renderToStaticMarkup(createElement(CompanionPairingCopy, { link, expiresAt }));
    expect(html).toContain("Copy pairing link");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("omb_pair_");
    expect(html).not.toContain("Link copied");
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    { link: null, expiresAt },
    { link, expiresAt: currentTime },
    { link, expiresAt: Number.NaN },
    { link, expiresAt, disabled: true },
  ])("disables copying without a usable pairing window (%j)", (props) => {
    clock();
    const html = renderToStaticMarkup(createElement(CompanionPairingCopy, props));
    expect(html).toContain('disabled=""');
    expect(html).toContain("Copy pairing link");
  });
});
