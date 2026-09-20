import { createDriveState, saveDriveGrant, disconnectDrive, DRIVE_APPDATA_SCOPE } from "./drive-grants.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { drivePullFor, drivePushFor, googleTokensFor } from "./account-drive.ts";
import { downloadBundle, downloadLatestSnapshot, downloadSnapshot, findBundleFile, listSnapshots, uploadBundle, uploadSnapshot } from "./drive-sync.ts";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
  { name: "manual Drive connection", push: async (payload: string) => (await uploadBundle("test-access", payload)).id, pull: () => downloadBundle("test-access"), file: "muster-workspace.enc" },
])("$name", ({ push, pull, file }) => {
  it("creates only after a complete empty search and includes the app folder", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [] }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "created-file" }));
    expect(await push("encrypted-payload")).toBe("created-file");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-access");
    const body = z.string().parse(init?.body);
    expect(body).toContain(`{"name":"${file}","parents":["appDataFolder"]}`);
    expect(body).toContain("encrypted-payload");
    expect(new Headers(init?.headers).get("content-type")).toMatch(/^multipart\/related; boundary=muster-[a-f0-9]{16}$/);
  });

  it("updates the newest existing backup without trying to change its parents", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "newest" }, { id: "old" }] }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "newest" }));
    expect(await push("replacement")).toBe("newest");
    const query = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(query.get("orderBy")).toBe("modifiedTime desc");
    expect(query.get("spaces")).toBe("appDataFolder");
    expect(query.get("q")).toBe(`name = '${file}' and trashed = false`);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain("/files/newest?uploadType=multipart");
    expect(init?.method).toBe("PATCH");
    expect(z.string().parse(init?.body)).toContain(`{"name":"${file}"}`);
    expect(z.string().parse(init?.body)).not.toContain("parents");
  });

  it.each([401, 403, 429, 500])("never writes or hides a failed list response (HTTP %i)", async (status) => {
    fetchMock.mockResolvedValue(Response.json({ error: { message: "unavailable" } }, { status }));
    await expect(push("payload")).rejects.toThrow(status === 401 ? "Drive token expired" : `HTTP ${status}`);
    await expect(pull()).rejects.toThrow(status === 401 ? "Drive token expired" : `HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each([
    null, [], { files: "bad" }, { files: [{}] }, { files: [{ id: "" }] },
    { files: [{ id: "../file" }] }, { error: { message: "bad" } }, { nextPageToken: 7 },
  ])("rejects malformed successful search responses: %j", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expect(push("payload")).rejects.toThrow("unreadable file list");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON search responses before any upload", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>upstream error</html>"));
    await expect(push("payload")).rejects.toThrow("unreadable file list");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not use an incomplete search even when it contains a file", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "partial" }], incompleteSearch: true }));
    await expect(pull()).rejects.toThrow("could not complete");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows empty pages before deciding whether a backup exists", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ nextPageToken: "page 2" }));
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "existing" }] }));
    fetchMock.mockResolvedValueOnce(new Response("encrypted-payload"));
    expect(await pull()).toBe("encrypted-payload");
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("pageToken")).toBe("page 2");
    expect(String(fetchMock.mock.calls[2][0])).toBe("https://www.googleapis.com/drive/v3/files/existing?alt=media");
  });

  it("returns no backup only for a complete empty list", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));
    expect(await pull()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects repeated page tokens instead of looping or creating a duplicate", async () => {
    fetchMock.mockImplementation(async () => Response.json({ files: [], nextPageToken: "same" }));
    await expect(push("payload")).rejects.toThrow("repeated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds searches with endlessly changing page tokens", async () => {
    for (let page = 0; page < 10; page++) {
      fetchMock.mockResolvedValueOnce(Response.json({ nextPageToken: `page-${page}` }));
    }
    await expect(push("payload")).rejects.toThrow("page limit");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it.each([{}, { id: "" }, { id: "../wrong" }, { id: 123 }])("rejects malformed upload receipts: %j", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [] }));
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expect(push("payload")).rejects.toThrow("unreadable upload response");
  });

  it("rejects an update receipt for a different file", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "existing" }] }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "different" }));
    await expect(push("payload")).rejects.toThrow("different backup file");
  });

  it("reports HTTP upload failures", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [] }));
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(push("payload")).rejects.toThrow("Drive upload failed: HTTP 503");
  });

  it.each([403, 500])("reports failed downloads (HTTP %i)", async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "existing" }] }));
    fetchMock.mockResolvedValueOnce(new Response("error", { status }));
    await expect(pull()).rejects.toThrow(`Drive download failed: HTTP ${status}`);
  });

  it("handles a backup removed between list and download", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "removed" }] }));
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await pull()).toBeNull();
  });
});

describe("Drive file identifiers", () => {
  it.each([".", "..", "space here", "bad\\path", "bad?query", "bad#fragment", " trailing", "trailing ", "control\n"])("rejects an unsafe identifier %j", async (id) => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id }] }));
    await expect(findBundleFile("test-access")).rejects.toThrow("unreadable file list");
  });

  it("encodes opaque identifiers when inserting them into a URL path", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "opaque%id" }] }));
    fetchMock.mockResolvedValueOnce(new Response("payload"));
    expect(await downloadBundle("test-access")).toBe("payload");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/opaque%25id?alt=media");
  });
});

describe("Explicit account Drive token selection", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'),('bob');
      CREATE TABLE account (userId TEXT, providerId TEXT, accessToken TEXT, refreshToken TEXT, accessTokenExpiresAt TEXT, createdAt INTEGER)`);
  });
  afterEach(() => db.close());
  const save = (userId = "alice") => {
    const pending = createDriveState(db, { userId, sessionId: "session" });
    return saveDriveGrant(db, { userId, googleSub: userId, expectedGeneration: pending.generation,
      accessToken: "explicit-access", refreshToken: "explicit-refresh", expiresAt: Date.now() + 300000, scopes: [DRIVE_APPDATA_SCOPE] });
  };
  it("does not infer Drive consent from a basic Google login", () => {
    db.prepare("INSERT INTO account VALUES (?, ?, ?, ?, ?, ?)").run("alice", "google", "login-access", "login-refresh", "2099-01-01", 1);
    expect(googleTokensFor(db, "alice")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses only the selected owner's explicit grant", () => {
    const grant = save();
    expect(googleTokensFor(db, "alice")).toEqual({ accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: grant.expiresAt });
    expect(googleTokensFor(db, "bob")).toBeNull();
  });
  it("refuses malformed stored Drive tokens", () => {
    save(); db.prepare("UPDATE drive_grants SET scopes = '[]'").run();
    expect(googleTokensFor(db, "alice")).toBeNull();
  });
  it("does not reuse a superseded consent generation", () => {
    save(); createDriveState(db, { userId: "alice", sessionId: "replacement" });
    expect(googleTokensFor(db, "alice")).toBeNull();
  });
  it("disconnects without deleting another owner's grant", () => {
    save(); save("bob"); disconnectDrive(db, "alice");
    expect(googleTokensFor(db, "alice")).toBeNull();
    expect(googleTokensFor(db, "bob")).not.toBeNull();
  });
});


describe("Account Drive v2 routing and consent", () => {
  it("push POSTs a new snapshot without a prior Drive list search", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "snap-x", name: "muster-workspace-v2-1000-ab.enc" }));
    expect(await drivePushFor("test-access", "encrypted-payload")).toBe("snap-x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name");
  });

  it("does not upload after consent changes before the snapshot POST", async () => {
    let guarded = false;
    const guard = vi.fn(async () => { guarded = true; throw new Error("consent changed"); });
    await expect(drivePushFor("test-access", "encrypted", guard)).rejects.toThrow("consent changed");
    expect(guarded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("does not download after consent changes before the snapshot list", async () => {
    let guarded = false;
    const guard = vi.fn(async () => { guarded = true; throw new Error("consent changed"); });
    await expect(drivePullFor("test-access", guard)).rejects.toThrow("consent changed");
    expect(guarded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("pull lists snapshots then downloads the newest by id", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "newest", name: "muster-workspace-v2-2000-0b.enc", createdTime: "t2", size: "5" }] }));
    fetchMock.mockResolvedValueOnce(new Response("downloaded-payload"));
    expect(await drivePullFor("test-access")).toBe("downloaded-payload");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("q")).toBe("name contains 'muster-workspace-v2-' and trashed = false");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://www.googleapis.com/drive/v3/files/newest?alt=media");
  });

  it("does not follow provider redirects with a credential", async () => {
    fetchMock.mockResolvedValue(Response.json({ files: [] }));
    expect(await drivePullFor("test-access")).toBeNull();
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("error");
  });
});

describe("Immutable v2 snapshots (stale-device overwrite defect)", () => {
  // The legacy v2 transport did findBundleFile -> PATCH onto the single newest
  // file, so a stale/empty device upload erased the only backup in place.
  // uploadSnapshot must instead always POST a fresh, uniquely-named file.
  it("always POSTs a new immutable file and never PATCHes the newest backup", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "snap-1", name: "muster-workspace-v2-1000-ab.enc" }));
    const { id, name } = await uploadSnapshot("test-access", "encrypted-payload");
    expect(id).toBe("snap-1");
    expect(name).toBe("muster-workspace-v2-1000-ab.enc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-access");
    expect(new Headers(init?.headers).get("content-type")).toMatch(/^multipart\/related; boundary=muster-[a-f0-9]{16}$/);
    const body = z.string().parse(init?.body);
    expect(body).toMatch(/"name":"muster-workspace-v2-[0-9]+-[0-9a-f]{8}\.enc"/);
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain("encrypted-payload");
    expect(init?.method).not.toBe("PATCH");
  });

  it("creates a distinct file per upload so a stale device cannot clobber a real backup", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "real-backup", name: "muster-workspace-v2-1000-0a.enc" }));
    const real = await uploadSnapshot("test-access", "real-backup-content");
    fetchMock.mockResolvedValueOnce(Response.json({ id: "stale-garbage", name: "muster-workspace-v2-2000-0b.enc" }));
    const stale = await uploadSnapshot("test-access", "stale-garbage-content");
    expect(real.id).not.toBe(stale.id);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).not.toContain("PATCH");
  });

  it("lists snapshots newest-first and is scoped to snapshot names only", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      files: [
        { id: "s2", name: "muster-workspace-v2-2000-0b.enc", createdTime: "2024-01-02T00:00:00Z", size: "99" },
        { id: "s1", name: "muster-workspace-v2-1000-0a.enc", createdTime: "2024-01-01T00:00:00Z", size: "9" },
      ],
    }));
    const snapshots = await listSnapshots("test-access");
    expect(snapshots).toEqual([
      { id: "s2", name: "muster-workspace-v2-2000-0b.enc", createdTime: "2024-01-02T00:00:00Z", size: "99" },
      { id: "s1", name: "muster-workspace-v2-1000-0a.enc", createdTime: "2024-01-01T00:00:00Z", size: "9" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const query = new URL(String(url)).searchParams;
    expect(query.get("spaces")).toBe("appDataFolder");
    expect(query.get("orderBy")).toBe("modifiedTime desc");
    expect(query.get("q")).toBe("name contains 'muster-workspace-v2-' and trashed = false");
    expect(query.get("fields")).toBe("files(id,name,createdTime,size),nextPageToken,incompleteSearch");
    expect(init?.method).toBeUndefined();
  });

  it("follows page tokens when listing snapshots", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ files: [{ id: "s1", name: "muster-workspace-v2-1000-0a.enc", createdTime: "t1", size: "1" }], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "s2", name: "muster-workspace-v2-2000-0b.enc", createdTime: "t2", size: "2" }] }));
    const snapshots = await listSnapshots("test-access");
    expect(snapshots.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("pageToken")).toBe("page-2");
  });

  it("rejects an incomplete snapshot search before returning partial results", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ id: "s1", name: "muster-workspace-v2-1000-0a.enc", createdTime: "t1", size: "1" }], incompleteSearch: true }));
    await expect(listSnapshots("test-access")).rejects.toThrow("could not complete");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads a chosen snapshot by id (explicit restore selection)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("restored-payload", { status: 200 }));
    expect(await downloadSnapshot("test-access", "snap-42")).toBe("restored-payload");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://www.googleapis.com/drive/v3/files/snap-42?alt=media");
    expect(init?.method).toBeUndefined();
  });

  it("reports a missing snapshot as not found", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "not found" } }, { status: 404 }));
    await expect(downloadSnapshot("test-access", "gone")).rejects.toThrow("Snapshot not found");
  });

  it("downloads the newest snapshot, or null when none exist", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ files: [{ id: "newest", name: "muster-workspace-v2-2000-0b.enc", createdTime: "t2", size: "5" }] }))
      .mockResolvedValueOnce(new Response("newest-payload", { status: 200 }));
    expect(await downloadLatestSnapshot("test-access")).toBe("newest-payload");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://www.googleapis.com/drive/v3/files/newest?alt=media");

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(Response.json({ files: [] }));
    expect(await downloadLatestSnapshot("test-access")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reproduces the defect fix end-to-end: a stale later upload never hides the real backup from explicit restore", async () => {
    // Real backup pushes first (older modified time).
    fetchMock.mockResolvedValueOnce(Response.json({ id: "real-id", name: "muster-workspace-v2-1000-0a.enc" }));
    await uploadSnapshot("test-access", "real-backup");
    // Stale/empty device pushes later — must NOT overwrite or delete the real file.
    fetchMock.mockResolvedValueOnce(Response.json({ id: "stale-id", name: "muster-workspace-v2-2000-0b.enc" }));
    await uploadSnapshot("test-access", "stale-garbage");
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
    // Listing keeps both; the stale upload sorts first by modified time, but the
    // real backup is still recoverable via explicit restore by id.
    fetchMock.mockResolvedValueOnce(Response.json({
      files: [
        { id: "stale-id", name: "muster-workspace-v2-2000-0b.enc", createdTime: "2024-01-02T00:00:00Z", size: "5" },
        { id: "real-id", name: "muster-workspace-v2-1000-0a.enc", createdTime: "2024-01-01T00:00:00Z", size: "5" },
      ],
    }));
    const list = await listSnapshots("test-access");
    expect(list.map((s) => s.id)).toEqual(["stale-id", "real-id"]);
    fetchMock.mockResolvedValueOnce(new Response("real-backup"));
    expect(await downloadSnapshot("test-access", "real-id")).toBe("real-backup");
  });
});
