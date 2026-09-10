import { describe, expect, it, vi } from "vitest";
import { ClaimFlow, parseClaimFragment, type ClaimState } from "./claim-flow";

const syntheticCode = "ABCD2345";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type TestClaimResponse = null | { ok?: boolean | string; error?: string };

function jsonResponse(body: TestClaimResponse, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Single-use device claim flow", () => {
  it.each(["", "#", "#%", "#%E0%A4%A", "#ABCDEFG0", "#ABCDEFGI", "#ABCDEFG", "#ABCD23456"])(
    "offers recovery without sending an invalid fragment %j to the server",
    async (fragment) => {
      const transport = vi.fn<typeof fetch>();
      expect(parseClaimFragment(fragment)).toEqual({ message: expect.any(String) });
      const flow = new ClaimFlow(fragment, transport);
      expect(flow.state).toMatchObject({ status: "error", retryable: false });
      await flow.start();
      await flow.retry();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(["#abcd2345", "#%20%61bcd2345%20"])("normalizes a valid fragment %j", async (fragment) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const flow = new ClaimFlow(fragment, transport);
    expect(parseClaimFragment(fragment)).toEqual({ code: syntheticCode });
    await flow.start();
    expect(transport.mock.calls[0][1]?.body).toBe(JSON.stringify({ code: syntheticCode }));
    expect(flow.state).toEqual({ status: "done" });
  });

  it("does not consume a claim while constructing or subscribing during render setup", () => {
    const transport = vi.fn<typeof fetch>();
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    const listener = vi.fn();
    flow.subscribe(listener);
    expect(listener).toHaveBeenCalledWith({ status: "claiming" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps one pending redemption across StrictMode effect cleanup and re-subscription", async () => {
    const response = deferred<Response>();
    const transport = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    const firstListener = vi.fn();
    const detach = flow.subscribe(firstListener);
    const firstRequest = flow.start();
    detach();
    const states: ClaimState[] = [];
    flow.subscribe((state) => states.push(state));
    const secondRequest = flow.start();
    expect(secondRequest).toBe(firstRequest);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ status: "claiming" }]);
    response.resolve(jsonResponse({ ok: true }));
    await secondRequest;
    expect(states).toEqual([{ status: "claiming" }, { status: "done" }]);
    expect(firstListener).toHaveBeenCalledTimes(1);
  });

  it("finishes a consumed request after leaving without notifying the detached page", async () => {
    const response = deferred<Response>();
    const transport = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    const oldListener = vi.fn();
    const detach = flow.subscribe(oldListener);
    const request = flow.start();
    detach();
    response.resolve(jsonResponse({ ok: true }));
    await request;
    expect(oldListener).toHaveBeenCalledTimes(1);
    const resumedListener = vi.fn();
    flow.subscribe(resumedListener);
    expect(resumedListener).toHaveBeenCalledExactlyOnceWith({ status: "done" });
    await flow.start();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not let stale cleanup detach the current page subscriber", async () => {
    const response = deferred<Response>();
    const flow = new ClaimFlow(`#${syntheticCode}`, vi.fn<typeof fetch>().mockReturnValue(response.promise));
    const oldDetach = flow.subscribe(vi.fn());
    const currentListener = vi.fn();
    flow.subscribe(currentListener);
    oldDetach();
    const request = flow.start();
    response.resolve(jsonResponse({ ok: true }));
    await request;
    expect(currentListener.mock.calls).toEqual([[{ status: "claiming" }], [{ status: "done" }]]);
  });

  it("never redeems an already confirmed single-use code again", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    const request = flow.start();
    await request;
    expect(flow.start()).toBe(request);
    await flow.retry();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual({ status: "done" });
  });

  it.each(["connection", "server"])("requires an explicit retry after a %s failure and deduplicates retry clicks", async (failure) => {
    const retryResponse = deferred<Response>();
    const transport = vi.fn<typeof fetch>();
    if (failure === "connection") transport.mockRejectedValueOnce(new Error("Connection dropped"));
    else transport.mockResolvedValueOnce(jsonResponse({ error: "Temporarily unavailable" }, 503));
    transport.mockReturnValueOnce(retryResponse.promise);
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    const firstRequest = flow.start();
    await firstRequest;
    expect(flow.state).toMatchObject({ status: "error", retryable: true });
    expect(flow.start()).toBe(firstRequest);
    expect(transport).toHaveBeenCalledTimes(1);
    const retryRequest = flow.retry();
    expect(flow.state).toEqual({ status: "claiming" });
    expect(flow.retry()).toBe(retryRequest);
    expect(flow.start()).toBe(retryRequest);
    expect(transport).toHaveBeenCalledTimes(2);
    retryResponse.resolve(jsonResponse({ ok: true }));
    await retryRequest;
    expect(flow.state).toEqual({ status: "done" });
  });

  it.each([400, 401, 409, 410])("does not retry a rejected or consumed code after HTTP %i", async (status) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "Scan a fresh QR." }, status));
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    await flow.start();
    expect(flow.state).toEqual({ status: "error", retryable: false, message: "Scan a fresh QR." });
    await flow.retry();
    await flow.start();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { ok: false }, { ok: "true" }])("does not report success or repost an unconfirmed HTTP 200 response %j", async (body) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", retryable: false });
    await flow.retry();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("offers recovery when a successful response is HTML instead of a confirmation", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Proxy error</html>"));
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", retryable: false });
    await flow.retry();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("uses a fallback error for a malformed rejection and allows recovery from a server outage", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("Unavailable", { status: 502 }));
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    await flow.start();
    expect(flow.state).toMatchObject({ status: "error", retryable: true, message: expect.any(String) });
  });

  it("sends the claim credential only in the JSON body, with same-origin cookies", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const flow = new ClaimFlow(`#${syntheticCode}`, transport);
    await flow.start();
    expect(transport).toHaveBeenCalledExactlyOnceWith("/api/pair/claim", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: syntheticCode }),
    });
  });

  it("calls the browser fetch function without rebinding its receiver to the claim flow", async () => {
    const browserFetch = vi.fn(function (this: ClaimFlow | typeof globalThis | undefined) {
      if (this instanceof ClaimFlow) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal("fetch", browserFetch);
    try {
      const flow = new ClaimFlow(`#${syntheticCode}`);
      await flow.start();
      expect(browserFetch).toHaveBeenCalledTimes(1);
      expect(flow.state).toEqual({ status: "done" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
