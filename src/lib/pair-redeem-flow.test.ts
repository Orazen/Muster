import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairRedeemFlow, type PairRedeemState } from "./pair-redeem-flow";
import { parseFragmentCode } from "./pairing-link";

const syntheticCode = "ABCD2345";
const confirmed = { ok: true, email: "owner@example.com", name: "Owner" };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type TestRedeemResponse = null | { ok?: boolean | string; email?: string; name?: string; error?: string };

function jsonResponse(body: TestRedeemResponse, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Browser pairing-code redeem flow", () => {
  // The flow hard-navigates on success; node tests stub the location it
  // replaces so every success path is observable without a real navigation.
  const windowReplace = vi.fn();
  beforeEach(() => {
    windowReplace.mockClear();
    vi.stubGlobal("window", { location: { replace: windowReplace } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("does not redeem while constructing or subscribing — only the explicit start does", () => {
    const transport = vi.fn<typeof fetch>();
    const flow = new PairRedeemFlow(syntheticCode, transport);
    const listener = vi.fn();
    flow.subscribe(listener);
    expect(listener).toHaveBeenCalledWith({ status: "idle" });
    expect(transport).not.toHaveBeenCalled();
    expect(flow.state).toEqual({ status: "idle" });
  });

  it("redeems the carried code, reports success, and hard-navigates to /app", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(confirmed));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    const states: PairRedeemState[] = [];
    flow.subscribe((state) => states.push(state));
    await flow.start();
    expect(states).toEqual([{ status: "idle" }, { status: "redeeming" }, { status: "done" }]);
    expect(transport.mock.calls[0][1]?.body).toBe(JSON.stringify({ code: syntheticCode }));
    expect(windowReplace).toHaveBeenCalledTimes(1);
    expect(windowReplace).toHaveBeenCalledWith("/app");
  });

  it("redeems the code exactly as parseFragmentCode carried it into the page", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(confirmed));
    const carried = parseFragmentCode(`#code=${syntheticCode}`);
    if (!carried) throw new Error("parseFragmentCode rejected a valid carried code");
    const flow = new PairRedeemFlow(carried.code, transport);
    await flow.start();
    expect(transport.mock.calls[0][1]?.body).toBe(JSON.stringify({ code: syntheticCode }));
    expect(flow.state).toEqual({ status: "done" });
    expect(windowReplace).toHaveBeenCalledWith("/app");
  });

  it("does not retry or re-request a consumed or expired code after HTTP 400", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "Pairing code already redeemed" }, 400));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    await flow.start();
    expect(flow.state).toEqual({ status: "error", retryable: false, message: "This code isn't valid or has already been used." });
    await flow.retry();
    await flow.start();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(windowReplace).not.toHaveBeenCalled();
  });

  it("allows a later retry after HTTP 429", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "Too many attempts. Try again in a minute." }, 429));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    await flow.start();
    expect(flow.state).toEqual({ status: "error", retryable: true, message: "Too many attempts. Try again in a minute." });
    await flow.retry();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { ok: false }, { ok: true }, { ok: true, email: "owner@example.com" }, { ok: true, name: "Owner" }])(
    "does not report success, navigate, or repost an unconfirmed HTTP 200 response %j",
    async (body) => {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
      const flow = new PairRedeemFlow(syntheticCode, transport);
      await flow.start();
      expect(flow.state).toEqual({ status: "error", retryable: false,
        message: "The sign-in could not be confirmed. The code cannot be used twice \u2014 reload the page: if you are signed in, you are done." });
      await flow.retry();
      await flow.start();
      expect(transport).toHaveBeenCalledTimes(1);
      expect(windowReplace).not.toHaveBeenCalled();
    },
  );

  it("offers recovery when a successful response is HTML instead of a confirmation", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Proxy error</html>"));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    await flow.start();
    expect(flow.state).toEqual({ status: "error", retryable: false,
      message: "The sign-in could not be confirmed. The code cannot be used twice \u2014 reload the page: if you are signed in, you are done." });
    expect(windowReplace).not.toHaveBeenCalled();
  });

  it("offers recovery from a server outage and surfaces its error on a later attempt", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("<html>Proxy error</html>", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ error: "Temporarily unavailable" }, 500));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    await flow.start();
    expect(flow.state).toEqual({ status: "error", retryable: true,
      message: "This code could not be redeemed right now. Try again." });
    await flow.retry();
    expect(flow.state).toEqual({ status: "error", retryable: true, message: "Temporarily unavailable" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("reports a dropped connection as retryable", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("Connection dropped"));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    await flow.start();
    expect(flow.state).toEqual({ status: "error", retryable: true,
      message: "Could not reach your server. Check your connection, then try again." });
  });

  it("keeps one pending redemption across effect cleanup and re-subscription", async () => {
    const response = deferred<Response>();
    const transport = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const flow = new PairRedeemFlow(syntheticCode, transport);
    const firstListener = vi.fn();
    const detach = flow.subscribe(firstListener);
    const firstRequest = flow.start();
    detach();
    const states: PairRedeemState[] = [];
    flow.subscribe((state) => states.push(state));
    const secondRequest = flow.start();
    expect(secondRequest).toBe(firstRequest);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ status: "redeeming" }]);
    response.resolve(jsonResponse(confirmed));
    await secondRequest;
    expect(states).toEqual([{ status: "redeeming" }, { status: "done" }]);
    // The echo of subscribe (idle) plus the synchronous start publish; nothing
    // after detach reached it.
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(windowReplace).toHaveBeenCalledWith("/app");
  });

  it("finishes a started redeem after leaving without notifying the detached page", async () => {
    const response = deferred<Response>();
    const transport = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const flow = new PairRedeemFlow(syntheticCode, transport);
    const oldListener = vi.fn();
    const detach = flow.subscribe(oldListener);
    detach();
    const request = flow.start();
    response.resolve(jsonResponse(confirmed));
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
    const flow = new PairRedeemFlow(syntheticCode, vi.fn<typeof fetch>().mockReturnValue(response.promise));
    const oldDetach = flow.subscribe(vi.fn());
    const currentListener = vi.fn();
    flow.subscribe(currentListener);
    oldDetach();
    const request = flow.start();
    response.resolve(jsonResponse(confirmed));
    await request;
    expect(currentListener.mock.calls).toEqual([[{ status: "idle" }], [{ status: "redeeming" }], [{ status: "done" }]]);
  });

  it("never redeems an already confirmed single-use code again", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(confirmed));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    const request = flow.start();
    await request;
    expect(flow.start()).toBe(request);
    await flow.retry();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual({ status: "done" });
    expect(windowReplace).toHaveBeenCalledTimes(1);
  });

  it.each(["connection", "server"])("requires an explicit retry after a %s failure and deduplicates retry clicks", async (failure) => {
    const retryResponse = deferred<Response>();
    const transport = vi.fn<typeof fetch>();
    if (failure === "connection") transport.mockRejectedValueOnce(new Error("Connection dropped"));
    else transport.mockResolvedValueOnce(jsonResponse({ error: "Temporarily unavailable" }, 503));
    transport.mockReturnValueOnce(retryResponse.promise);
    const flow = new PairRedeemFlow(syntheticCode, transport);
    const firstRequest = flow.start();
    await firstRequest;
    expect(flow.state).toMatchObject({ status: "error", retryable: true });
    expect(flow.start()).toBe(firstRequest);
    expect(transport).toHaveBeenCalledTimes(1);
    const retryRequest = flow.retry();
    expect(flow.state).toEqual({ status: "redeeming" });
    expect(flow.retry()).toBe(retryRequest);
    expect(flow.start()).toBe(retryRequest);
    expect(transport).toHaveBeenCalledTimes(2);
    retryResponse.resolve(jsonResponse(confirmed));
    await retryRequest;
    expect(flow.state).toEqual({ status: "done" });
    expect(windowReplace).toHaveBeenCalledWith("/app");
  });

  it("sends the carried code only in the JSON body, with same-origin cookies", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(confirmed));
    const flow = new PairRedeemFlow(syntheticCode, transport);
    await flow.start();
    expect(transport).toHaveBeenCalledExactlyOnceWith("/api/pair/redeem-browser", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: syntheticCode }),
    });
  });

  it("calls the browser fetch function without rebinding its receiver to the redeem flow", async () => {
    const browserFetch = vi.fn(function (this: PairRedeemFlow | typeof globalThis | undefined) {
      if (this instanceof PairRedeemFlow) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(confirmed));
    });
    vi.stubGlobal("fetch", browserFetch);
    const flow = new PairRedeemFlow(syntheticCode);
    await flow.start();
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual({ status: "done" });
    expect(windowReplace).toHaveBeenCalledWith("/app");
  });
});
