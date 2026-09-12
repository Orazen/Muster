import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { WorkspaceBackupCapability } from "../../server/contracts";
import { createWorkspaceRequestScope, readWorkspaceCapability, readWorkspaceReply, workspaceCapabilitySchema, workspaceResponse } from "./workspace-capability";

const local: WorkspaceBackupCapability = {
  capabilityVersion: 1,
  workspaceBackupAvailable: true,
  unavailableReason: null,
  drive: false,
  installationDrive: { configured: true, operationsAvailable: true },
  accountDrive: { available: false, code: "ACCOUNT_DRIVE_UNAVAILABLE" },
};
const hosted: WorkspaceBackupCapability = {
  ...local,
  workspaceBackupAvailable: false,
  unavailableReason: "Workspace backups are only available on a local installation.",
  installationDrive: { configured: false, operationsAvailable: false },
};

function scope() {
  const requests = createWorkspaceRequestScope();
  requests.activate();
  return requests;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function delayedBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    response: new Response(body),
    finish(text: string) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
  };
}

describe("workspace capability contract", () => {
  it.each([
    ["configured local", local],
    ["unconfigured local", { ...local, installationDrive: { configured: false, operationsAvailable: false } }],
    ["hosted", hosted],
  ])("accepts the explicit %s capability", (_label, value) => {
    expect(workspaceCapabilitySchema.parse(value)).toEqual(value);
  });

  it.each([
    ["legacy flags", { drive: true, lastPush: { at: 1, channel: "google-drive" } }],
    ["missing version", { ...local, capabilityVersion: undefined }],
    ["unknown version", { ...local, capabilityVersion: 2 }],
    ["string availability", { ...local, workspaceBackupAvailable: "true" }],
    ["legacy drive true", { ...local, drive: true }],
    ["missing installation", { ...local, installationDrive: undefined }],
    ["inconsistent local operations", { ...local, installationDrive: { configured: true, operationsAvailable: false } }],
    ["unconfigured operations", { ...local, installationDrive: { configured: false, operationsAvailable: true } }],
    ["missing hosted explanation", { ...hosted, unavailableReason: null }],
    ["blank hosted explanation", { ...hosted, unavailableReason: " \n" }],
    ["hosted configured drive", { ...hosted, installationDrive: local.installationDrive }],
    ["local rejection reason", { ...local, unavailableReason: "Unavailable" }],
    ["account grant inference", { ...local, accountDrive: { available: true, code: "ACCOUNT_DRIVE_UNAVAILABLE" } }],
    ["unknown account code", { ...local, accountDrive: { available: false, code: "OTHER" } }],
    ["old stamp", { ...local, lastPush: { at: 1 } }],
    ["unexpected nested field", { ...local, installationDrive: { ...local.installationDrive, connected: true } }],
    ["null", null],
  ])("rejects %s without fallback", (_label, value) => {
    expect(workspaceCapabilitySchema.safeParse(value).success).toBe(false);
  });

  it("reads the exact status route with cookies, no cache and no redirects", async () => {
    const request = scope().beginStatus()!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(local));
    expect(await readWorkspaceCapability(request, fetcher)).toEqual(local);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/workspace/google/status", expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store", redirect: "error", signal: request.signal }));
  });

  it.each(["legacy", "version", "HTML"])("reports %s responses as unavailable", async (kind) => {
    const response = kind === "legacy" ? Response.json({ drive: true }) : kind === "version" ? Response.json({ ...local, capabilityVersion: 2 }) : new Response("<html>not JSON</html>");
    await expect(readWorkspaceCapability(scope().beginStatus()!, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow();
  });

  it("preserves a current server error exactly and allows an explicit status retry", async () => {
    const requests = scope();
    const first = requests.beginStatus()!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: "Server backup is unavailable — retry later." }, { status: 503 })).mockResolvedValueOnce(Response.json(local));
    await expect(readWorkspaceCapability(first, fetcher)).rejects.toThrow("Server backup is unavailable — retry later.");
    first.finish();
    expect(await readWorkspaceCapability(requests.beginStatus()!, fetcher)).toEqual(local);
  });

  it("preserves a network failure instead of enabling old Drive flags", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Owned network failure"));
    await expect(readWorkspaceCapability(scope().beginStatus()!, fetcher)).rejects.toThrow("Owned network failure");
  });
});

describe("workspace account/session request retirement", () => {
  it("supersedes an old status even when its transport ignores cancellation", async () => {
    const requests = scope();
    const old = requests.beginStatus()!;
    const pending = deferred<Response>();
    const oldRead = readWorkspaceCapability(old, vi.fn<typeof fetch>().mockReturnValue(pending.promise));
    const fresh = requests.beginStatus()!;
    expect(old.signal.aborted).toBe(true);
    expect(await readWorkspaceCapability(fresh, vi.fn<typeof fetch>().mockResolvedValue(Response.json(hosted)))).toEqual(hosted);
    pending.resolve(Response.json(local));
    expect(await oldRead).toBeNull();
    expect(old.commit(() => { throw new Error("must not publish"); })).toBe(false);
    old.finish();
    expect(fresh.current()).toBe(true);
  });

  it("retires status body reads and does not resurrect them on StrictMode reactivation", async () => {
    const requests = scope();
    const old = requests.beginStatus()!;
    const body = delayedBody();
    const read = readWorkspaceCapability(old, vi.fn<typeof fetch>().mockResolvedValue(body.response));
    await Promise.resolve();
    requests.dispose();
    requests.activate();
    body.finish(JSON.stringify(local));
    expect(await read).toBeNull();
    expect(old.current()).toBe(false);
    expect(requests.beginStatus()!.current()).toBe(true);
  });

  it("blocks synchronous double submissions until the physical operation finishes", () => {
    const requests = scope();
    const first = requests.beginOperation()!;
    expect(requests.busy).toBe(true);
    expect(requests.beginOperation()).toBeNull();
    first.finish();
    expect(requests.busy).toBe(false);
    expect(requests.beginOperation()).not.toBeNull();
  });

  it("does not let an old finally release a new session's physical operation", () => {
    const requests = scope();
    const old = requests.beginOperation()!;
    requests.dispose();
    requests.activate();
    const fresh = requests.beginOperation()!;
    old.finish();
    expect(requests.busy).toBe(true);
    expect(fresh.current()).toBe(true);
    expect(old.current()).toBe(false);
  });

  it("performs no work on activation and rejects requests after disposal", () => {
    const requests = createWorkspaceRequestScope();
    expect(requests.beginOperation()).toBeNull();
    requests.activate();
    expect(requests.busy).toBe(false);
    requests.dispose();
    expect(requests.beginStatus()).toBeNull();
    expect(requests.beginOperation()).toBeNull();
  });

  it("suppresses a late export download while a new account remains usable", async () => {
    const oldAccount = scope();
    const request = oldAccount.beginOperation()!;
    const pending = deferred<Response>();
    const response = readWorkspaceReply(request, "/api/workspace/export", JSON.stringify({ passphrase: "owned-passphrase" }), z.object({ payload: z.string() }), vi.fn<typeof fetch>().mockReturnValue(pending.promise));
    oldAccount.dispose();
    const newAccount = scope();
    const download = vi.fn();
    pending.resolve(Response.json({ payload: "owned encrypted fixture" }));
    expect(await response).toBeNull();
    expect(request.commit(download)).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(newAccount.beginOperation()!.current()).toBe(true);
  });

  it("does not post a file whose text resolves after retirement", async () => {
    const requests = scope();
    const request = requests.beginOperation()!;
    const fileText = deferred<string>();
    const fetcher = vi.fn<typeof fetch>();
    const restore = (async () => {
      const payload = await fileText.promise;
      return workspaceResponse(request, "/api/workspace/restore", JSON.stringify({ payload }), fetcher);
    })();
    requests.dispose();
    fileText.resolve("owned encrypted fixture");
    expect(await restore).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("suppresses a reload when a restore body completes after logout", async () => {
    const requests = scope();
    const request = requests.beginOperation()!;
    const body = delayedBody();
    const read = readWorkspaceReply(request, "/api/workspace/drive/pull", "{}", z.object({ restored: z.boolean() }), vi.fn<typeof fetch>().mockResolvedValue(body.response));
    await Promise.resolve();
    requests.dispose();
    body.finish(JSON.stringify({ restored: true }));
    expect(await read).toBeNull();
    const reload = vi.fn();
    expect(request.commit(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores an old 401 instead of applying it to the current session", async () => {
    const requests = scope();
    const request = requests.beginOperation()!;
    const pending = deferred<Response>();
    const read = workspaceResponse(request, "/api/workspace/export", "{}", vi.fn<typeof fetch>().mockReturnValue(pending.promise));
    requests.dispose();
    pending.resolve(Response.json({ error: "Old session expired" }, { status: 401 }));
    expect(await read).toBeNull();
    expect(request.current()).toBe(false);
  });

  it("retains the exact current 401 error without navigation", async () => {
    const request = scope().beginOperation()!;
    await expect(workspaceResponse(request, "/api/workspace/export", "{}", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "Please sign in again." }, { status: 401 })))).rejects.toThrow("Please sign in again.");
  });

  it("validates current operation replies before permitting caller effects", async () => {
    const request = scope().beginOperation()!;
    await expect(readWorkspaceReply(request, "/api/workspace/export", "{}", z.object({ payload: z.string() }), vi.fn<typeof fetch>().mockResolvedValue(Response.json({ payload: false })))).rejects.toThrow("invalid backup response");
  });
});
