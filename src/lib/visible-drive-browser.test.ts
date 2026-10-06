import { describe, expect, it, vi } from "vitest";
import { createVisibleBrowserClient, visibleAuthorizationUrl, visibleBrowserErrorText, visibleConsentSchema, visibleFailureText,
  visiblePopupResult, visibleStatusSchema, visibleRestoreSchema, VISIBLE_DRIVE_PREFIX } from "./visible-drive-browser";

const binding = { userId: "alice", sessionId: "alice-session", sessionToken: "synthetic-alice-token", origin: "http://127.0.0.1:43901" };
const session = (extra = {}) => ({ user: { id: "alice" }, session: { id: "alice-session", userId: "alice", token: "synthetic-alice-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(), activeOrganizationId: "alice-org", ...extra } });
const status = { available: true, connected: false, scope: "account-owned", restoreApply: "unsupported", settingsCaptured: false, viewRevision: "v".repeat(43), grantRevision: "g".repeat(43) };
const state = "s".repeat(43);
const attempt = () => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: "synthetic-client", response_type: "code", state,
    redirect_uri: `${binding.origin}${VISIBLE_DRIVE_PREFIX}/callback`, scope: "openid https://www.googleapis.com/auth/drive.file" }).toString();
  return { viewRevision: status.viewRevision, grantRevision: "c".repeat(43), state, authorizationUrl: url.toString(), expiresAt: Date.now() + 60_000 };
};
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; };

describe("optional visible Drive browser boundary", () => {
  it("uses exact live signed-session proofs around a real route response without credential bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async path => Response.json(String(path).startsWith("/api/auth/get-session") ? session() : status));
    const client = createVisibleBrowserClient(binding, () => true, fetcher);
    expect(await client.request("status", visibleStatusSchema)).toEqual(status);
    expect(fetcher.mock.calls.map(([path]) => String(path))).toEqual(["/api/auth/get-session?disableCookieCache=true", `${VISIBLE_DRIVE_PREFIX}/status`, "/api/auth/get-session?disableCookieCache=true", `${VISIBLE_DRIVE_PREFIX}/status`, "/api/auth/get-session?disableCookieCache=true"]);
    expect(fetcher.mock.calls.every(([, options]) => options?.credentials === "include" && options.cache === "no-store" && options.redirect === "error")).toBe(true);
    expect(fetcher.mock.calls.every(([, options]) => !options?.body)).toBe(true); client.dispose();
  });
  it.each([{ token: "rotated" }, { id: "other-session" }, { userId: "bob" }, { expiresAt: "2020-01-01T00:00:00Z" }, { expiresAt: "bad" }])("refuses changed/expired session %j before mutation", async extra => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(session(extra)));
    const client = createVisibleBrowserClient(binding, () => true, fetcher);
    await expect(client.request("consent", visibleConsentSchema, {})).rejects.toThrow("account or connection changed");
    expect(fetcher).toHaveBeenCalledTimes(1); client.dispose();
  });
  it("an actual resolved-workspace revision change after response denies later writes", async () => {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async path => Response.json(String(path).startsWith("/api/auth/get-session")
      ? session() : { ...status, viewRevision: ++reads > 1 ? "w".repeat(43) : status.viewRevision }));
    const client = createVisibleBrowserClient(binding, () => true, fetcher);
    await expect(client.request("status", visibleStatusSchema)).rejects.toThrow("workspace or connection changed");
    await expect(client.request("disconnect", visibleStatusSchema, {})).rejects.toThrow("workspace or connection changed");
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/disconnect"))).toHaveLength(0); client.dispose();
  });
  it("rejects a late grant winner but accepts custody refreshed by the owned action", async () => {
    for (const winner of [true, false]) {
      let statusReads = 0;
      const offered = { ...attempt(), grantRevision: "r".repeat(43) };
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
        if (String(path).startsWith("/api/auth")) return Response.json(session({ activeOrganizationId: null }));
        if (String(path).endsWith("/consent")) {
          expect(new Headers(init?.headers).get("x-muster-visible-view")).toBe(status.viewRevision);
          expect(new Headers(init?.headers).get("x-muster-visible-grant")).toBe(status.grantRevision);
          expect(init?.body).toBe("{}"); return Response.json(offered);
        }
        return Response.json({ ...status, grantRevision: ++statusReads > 1 ? (winner ? "n".repeat(43) : offered.grantRevision) : status.grantRevision });
      });
      const client = createVisibleBrowserClient(binding, () => true, fetcher);
      if (winner) await expect(client.request("consent", visibleConsentSchema, {})).rejects.toThrow("connection changed");
      else expect(await client.request("consent", visibleConsentSchema, {})).toEqual(offered);
      client.dispose();
    }
  });
  it("account retirement fences late response-body results even when transport ignores abort", async () => {
    const held = deferred<unknown>(); let bound = true;
    const entered = deferred<void>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async path => {
      if (String(path).startsWith("/api/auth")) return Response.json(session());
      entered.resolve();
      // SAFETY: this seam owns the only two response members used by the client; it simulates a held JSON read.
      return { ok: true, json: () => held.promise } as Response;
    });
    const client = createVisibleBrowserClient(binding, () => bound, fetcher);
    const pending = client.request("status", visibleStatusSchema); await entered.promise;
    bound = false; held.resolve(status);
    await expect(pending).rejects.toThrow("account or connection changed"); client.dispose();
  });
  it("unmount aborts an ignored transport immediately and denies later actions", async () => {
    const entered = deferred<void>(); const held = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async path => {
      if (String(path).startsWith("/api/auth")) return Response.json(session());
      entered.resolve(); return held.promise;
    });
    const client = createVisibleBrowserClient(binding, () => true, fetcher);
    const pending = client.request("status", visibleStatusSchema); await entered.promise; client.dispose();
    await expect(pending).rejects.toThrow("cancelled");
    await expect(client.request("consent", visibleConsentSchema, {})).rejects.toThrow("account or connection changed");
    held.resolve(Response.json(status));
  });
  it.each([false, true])("retirement cancels the owned state only after current signed proof (rotated=%s)", async rotated => {
    let retired = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/auth")) return Response.json(session(retired && rotated ? { token: "rotated" } : {}));
      if (String(path).endsWith("/cancel")) {
        expect(init?.body).toBe(JSON.stringify({ state }));
        expect(new Headers(init?.headers).get("x-muster-visible-view")).toBe(status.viewRevision);
        expect(new Headers(init?.headers).get("x-muster-visible-grant")).toBe(status.grantRevision);
        return Response.json({ cancelled: true, viewRevision: status.viewRevision, grantRevision: status.grantRevision });
      }
      return Response.json(status);
    });
    const client = createVisibleBrowserClient(binding, () => true, fetcher);
    await client.request("status", visibleStatusSchema); fetcher.mockClear(); retired = true; client.dispose(state);
    if (rotated) {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/cancel"))).toHaveLength(0);
    } else await vi.waitFor(() => expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/cancel"))).toHaveLength(1));
    expect(client.current()).toBe(false);
  });
  it("rejects malformed status and sanitizes arbitrary upstream/transport messages", async () => {
    let mode = "malformed";
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async path => {
      if (String(path).startsWith("/api/auth")) return Response.json(session());
      if (mode === "throw") throw new Error("private-token-do-not-render");
      return mode === "error" ? Response.json({ error: "private-token-do-not-render" }, { status: 502 }) : Response.json({ connected: true });
    });
    const client = createVisibleBrowserClient(binding, () => true, fetcher);
    await expect(client.request("status", visibleStatusSchema)).rejects.toThrow("unsupported response");
    for (mode of ["throw", "error"]) await expect(client.request("status", visibleStatusSchema)).rejects.toThrow("could not be confirmed");
    client.dispose();
  });
  it("accepts only exact official consent endpoint, state, own callback and closed scopes", () => {
    expect(visibleAuthorizationUrl(attempt(), binding.origin)).toBe(attempt().authorizationUrl);
    for (const [field, value] of [["state", "x".repeat(43)], ["redirect_uri", "https://evil.invalid/callback"], ["scope", "openid https://www.googleapis.com/auth/drive"], ["response_type", "token"]]) {
      const changed = attempt(); const url = new URL(changed.authorizationUrl); url.searchParams.set(field, value); changed.authorizationUrl = url.toString();
      expect(() => visibleAuthorizationUrl(changed, binding.origin)).toThrow("could not be verified");
    }
    for (const url of ["https://accounts.google.com.evil.invalid/o/oauth2/v2/auth", "javascript:alert(1)", "broken", `${attempt().authorizationUrl}&state=${state}`])
      expect(() => visibleAuthorizationUrl({ ...attempt(), authorizationUrl: url }, binding.origin)).toThrow("could not be verified");
  });
  it("an existing connected status or unrelated callback never proves new consent completion", () => {
    const callback = `${binding.origin}${VISIBLE_DRIVE_PREFIX}/callback?state=${state}&code=synthetic-code`;
    const connected = JSON.stringify({ connected: true, scope: "account-owned", viewRevision: status.viewRevision, grantRevision: status.grantRevision });
    expect(visiblePopupResult(callback, connected, state, binding.origin)).toEqual({ status: "connected", viewRevision: status.viewRevision, grantRevision: status.grantRevision });
    for (const href of [callback.replace(state, "x".repeat(43)), callback.replace("/callback", "/status"), callback.replace(binding.origin, "https://evil.invalid"), callback.replace("&code=synthetic-code", "")])
      expect(visiblePopupResult(href, connected, state, binding.origin)).toBeNull();
    expect(visiblePopupResult(callback, JSON.stringify(status), state, binding.origin)).toBeNull();
    expect(visiblePopupResult(callback, JSON.stringify({ connected: true, scope: "account-owned" }), state, binding.origin)).toBeNull();
    expect(visiblePopupResult(callback, JSON.stringify({ error: "consent-changed" }), state, binding.origin)).toEqual({ status: "declined" });
  });
  it("partial copies and reconnect are distinct from verified copy/restore success", () => {
    expect(visibleFailureText({ error: "verification-failed", copyPreserved: true, createdFileId: "owned-copy" })).toContain("verification failed");
    expect(visibleFailureText({ error: "refresh-failed", reconnectRequired: true })).toContain("Reconnect");
    expect(visibleFailureText({ error: "secret-value" })).not.toContain("secret-value");
    expect(visibleBrowserErrorText(new Error("private-cookie-do-not-render"))).not.toContain("private-cookie");
  });
  it("accepts durable additive receipts only with exact account/grant proof and target-copy evidence",async()=>{
    const operationId="11111111-1111-4111-8111-111111111111",ready={...status,restoreApply:"additive",connected:true,engineChoices:[{label:"Owned model",selection:{instanceId:"fakeApi:alice",model:"fake-1"}}]};
    const receipt={viewRevision:status.viewRevision,grantRevision:status.grantRevision,status:"committed",operationId,scope:"account-owned",mode:"additive",sourceDigest:"a".repeat(64),mapping:{bot:{},group:{},thread:{},plan:{}},execution:"not-started",rollback:"pending-only",history:"archive-only",durability:"process-restart-only",targetCopy:{sha256:"b".repeat(64),sourceDigest:"c".repeat(64),keyMode:"provided-secret-as-passphrase"}};
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async(path,init)=>{
      if(String(path).startsWith("/api/auth"))return Response.json(session());
      if(String(path).endsWith("restore/receipt")){expect(init?.body).toBe(JSON.stringify({operationId}));return Response.json(receipt);}return Response.json(ready);
    });
    const client=createVisibleBrowserClient(binding,()=>true,fetcher);expect(await client.request("restore/receipt",visibleRestoreSchema,{operationId})).toEqual(receipt);client.dispose();
    for(const patch of [{execution:"started"},{rollback:"committed-undo"},{targetCopy:undefined},{mapping:{bot:{old:"not-fresh"},group:{},thread:{},plan:{}}}])expect(visibleRestoreSchema.safeParse({...receipt,...patch}).success).toBe(false);
  });
  it("keeps an unconfirmed apply distinct from rollback and exposes receipt reconciliation",async()=>{
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async path=>Response.json(String(path).startsWith("/api/auth")?session():String(path).endsWith("restore/apply")?{unsupported:"ambiguous committed response"}:status));
    const client=createVisibleBrowserClient(binding,()=>true,fetcher);
    await expect(client.request("restore/apply",visibleRestoreSchema,{format:"account-recovery-v1",fileId:"owned-copy",passphrase:"owned-key",operationId:"11111111-1111-4111-8111-111111111111",expectedSourceDigest:"a".repeat(64),selection:{instanceId:"fakeApi:alice",model:"fake-1"}})).rejects.toThrow("check the restore receipt");client.dispose();
    expect(visibleFailureText({error:"rolled-back"})).toContain("rolled back");expect(visibleFailureText({error:"rollback-failed"})).toContain("reconciliation");
  });

});
