/** Synthetic Google transport installed only in an explicitly owned child.
 * The real server still builds, encrypts, decrypts and restores its bundles.
 * No Google account, network listener or successful product response is faked.
 */
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { importPKCS8, SignJWT } from "jose";

const modeSchema = z.enum(["ok", "refresh-error", "list-error", "upload-error", "download-error", "corrupt-download", "hold-download", "hold-exchange"]);
export type DriveFixtureMode = z.infer<typeof modeSchema>;
const settingsSchema = z.object({ directory: z.string(), refreshToken: z.string(), clientId: z.string(), clientSecret: z.string(), accessToken: z.string(), googleSubject: z.string(), privateKey: z.string(), jwk: z.record(z.string(), z.unknown()) });
const entrySchema = z.object({ operation: z.enum(["refresh", "list", "upload", "download", "exchange"]), mode: modeSchema, credentialsMatch: z.boolean() });
interface FixtureTokenResponse { access_token: string; refresh_token: string; expires_in: number; id_token?: string; scope?: string; token_type?: string }
const fixtureFileId = "owned-workspace-file";
/** One synthetic Google account's transport identity and its own app-data
 *  folder. Real `drive.appdata` is scoped to the Google account behind the
 *  bearer token, so two accounts on one Muster install have DISJOINT record sets
 *  and a listing made with one token cannot see the other's records. The
 *  fixture models that: it is the only reason a two-account test can fail for
 *  the right reason instead of passing because both accounts shared a store. */
const accountRecordSchema = z.object({
  key: z.string().min(1),
  googleSubject: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});
type AccountRecord = z.infer<typeof accountRecordSchema>;
const PRIMARY_ACCOUNT_KEY = "primary";
const ACCOUNTS_FILE = "accounts.json";
const SNAPSHOTS_DIR = "snapshots";

/** Its credential values are synthetic and must remain in owned fixture files. */
export function createWorkspaceDriveFixture(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signing = { googleSubject: `owned-google-${randomBytes(12).toString("hex")}`, privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), jwk: { ...keys.publicKey.export({ format: "jwk" }), kid: "owned-drive-key", use: "sig", alg: "RS256" } };
  const settings = { ...signing, directory, refreshToken: randomBytes(24).toString("hex"), clientId: randomBytes(24).toString("hex"), clientSecret: randomBytes(24).toString("hex"), accessToken: randomBytes(24).toString("hex") };
  const settingsPath = join(directory, "settings.json");
  const controlPath = join(directory, "control.json");
  const journalPath = join(directory, "transport.jsonl");
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  writeFileSync(controlPath, JSON.stringify({ mode: "ok" }), { mode: 0o600 });
  const readAccounts = (): AccountRecord[] => {
    const path = join(directory, ACCOUNTS_FILE);
    if (!existsSync(path)) return [];
    try { return z.array(accountRecordSchema).parse(JSON.parse(readFileSync(path, "utf8"))); }
    catch { return []; }
  };
  /** Register another synthetic Google account with its own tokens and its own
   *  app-data folder. Call it BEFORE the child boots: the child's transport
   *  installs once, at preload, and reads its account list then. The primary
   *  account is the one the fixture has always had and keeps its store path, so
   *  a suite that never calls this is entirely unaffected. */
  const createAccount = (key: string): AccountRecord => {
    const record: AccountRecord = {
      key,
      googleSubject: `owned-google-${key}-${randomBytes(8).toString("hex")}`,
      accessToken: randomBytes(24).toString("hex"),
      refreshToken: randomBytes(24).toString("hex"),
    };
    writeFileSync(join(directory, ACCOUNTS_FILE), JSON.stringify([...readAccounts(), record]), { mode: 0o600 });
    return record;
  };
  return {
    preloadPath: fileURLToPath(import.meta.url),
    env: { MUSTER_DRIVE_FIXTURE: settingsPath, GOOGLE_CLIENT_ID: settings.clientId, GOOGLE_CLIENT_SECRET: settings.clientSecret },
    googleSubject: settings.googleSubject,
    clientId: settings.clientId,
    refreshToken: settings.refreshToken,
    accessToken: settings.accessToken,
    payloadPath: join(directory, "uploaded-bundle.txt"),
    networkLog: join(directory, "outbound-attempts.txt"),
    heldExchangePath: join(directory, "exchange-held"),
    heldDownloadPath: join(directory, "download-held"),
    createAccount,
    /** The key the fixture's own account is registered under, when a suite wants
     *  to address it by key rather than through the token it was handed. */
    primaryAccountKey: PRIMARY_ACCOUNT_KEY,
    /** The record ids stored in one account's app-data folder, upload order.
     *  The read side a two-account test needs: the only way to assert what the
     *  transport actually HOLDS for an account, as opposed to what a route said
     *  about it. */
    accountRecordIds(key: string): string[] {
      const folder = key === PRIMARY_ACCOUNT_KEY ? join(directory, SNAPSHOTS_DIR) : join(directory, SNAPSHOTS_DIR, key);
      const manifest = join(folder, "manifest.json");
      if (!existsSync(manifest)) return [];
      try { return z.array(z.object({ id: z.string() })).parse(JSON.parse(readFileSync(manifest, "utf8"))).map((row) => row.id); }
      catch { return []; }
    },
    /** The ciphertext one uploaded record is stored as, or null when no account
     *  holds it. The read side for "what did this account actually put in
     *  Drive" — a test that could otherwise only inspect a route's claims. */
    snapshotPayload(id: string): string | null {
      for (const key of [PRIMARY_ACCOUNT_KEY, ...readAccounts().map((account) => account.key)]) {
        const path = key === PRIMARY_ACCOUNT_KEY
          ? join(directory, SNAPSHOTS_DIR, `${id}.payload`)
          : join(directory, SNAPSHOTS_DIR, key, `${id}.payload`);
        if (existsSync(path)) return readFileSync(path, "utf8");
      }
      return null;
    },
    setConsent(consent: { nonce: string; verifier: string; googleSub?: string; scope?: string; account?: string }) {
      writeFileSync(join(directory, "consent.json"), JSON.stringify(consent), { mode: 0o600 });
    },
    setMode(mode: DriveFixtureMode) { writeFileSync(controlPath, JSON.stringify({ mode }), { mode: 0o600 }); },
    entries() {
      return existsSync(journalPath) ? readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean).map((line) => entrySchema.parse(JSON.parse(line))) : [];
    },
  };
}

function installTransport(settingsPath: string): void {
  const settings = settingsSchema.parse(JSON.parse(readFileSync(settingsPath, "utf8")));
  const owned = (name: string) => join(settings.directory, name);
  const blocked = (): never => {
    appendFileSync(owned("outbound-attempts.txt"), "blocked\n", { mode: 0o600 });
    throw new Error("Outbound network disabled in workspace Drive fixture");
  };
  Socket.prototype.connect = blocked;
  const currentMode = () => z.object({ mode: modeSchema }).parse(JSON.parse(readFileSync(owned("control.json"), "utf8"))).mode;
  const record = (operation: z.infer<typeof entrySchema>["operation"], mode: DriveFixtureMode, credentialsMatch: boolean) => {
    appendFileSync(owned("transport.jsonl"), JSON.stringify({ operation, mode, credentialsMatch }) + "\n", { mode: 0o600 });
    if (!credentialsMatch) throw new Error("Synthetic Drive credential boundary mismatch");
  };
  const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
  // The consent currently on file, which is also WHICH Google account is
  // completing it. Unset means the primary account — the fixture's only account
  // unless a suite calls createAccount — so every existing suite is unaffected.
  const readConsent = () => {
    if (!existsSync(owned("consent.json"))) return null;
    return z.object({ nonce: z.string(), verifier: z.string(), googleSub: z.string().optional(), scope: z.string().optional(), account: z.string().optional() })
      .parse(JSON.parse(readFileSync(owned("consent.json"), "utf8")));
  };
  // Registered before this child booted. Read from the file rather than from
  // settings.json because the transport is installed once, at preload, exactly
  // like settings.json — an account created afterwards could not reach a child
  // that is already running.
  const readAccounts = (): AccountRecord[] => {
    if (!existsSync(owned(ACCOUNTS_FILE))) return [];
    try { return z.array(accountRecordSchema).parse(JSON.parse(readFileSync(owned(ACCOUNTS_FILE), "utf8"))); }
    catch { return []; }
  };
  const primaryAccount = (): AccountRecord => ({ key: PRIMARY_ACCOUNT_KEY, googleSubject: settings.googleSubject, accessToken: settings.accessToken, refreshToken: settings.refreshToken });
  const accountByKey = (key: string): AccountRecord | null =>
    key === PRIMARY_ACCOUNT_KEY ? primaryAccount() : (readAccounts().find((account) => account.key === key) ?? null);
  const accountByToken = (token: string): AccountRecord | null =>
    [primaryAccount(), ...readAccounts()].find((account) => account.accessToken === token) ?? null;
  const accountByRefreshToken = (token: string): AccountRecord | null =>
    [primaryAccount(), ...readAccounts()].find((account) => account.refreshToken === token) ?? null;
  /** Each account's own app-data folder. The primary keeps the directory the
   *  fixture has always used, because account-drive-roundtrip.test.ts reads an
   *  uploaded snapshot straight out of it. */
  const appDataDir = (account: AccountRecord) => account.key === PRIMARY_ACCOUNT_KEY
    ? owned(SNAPSHOTS_DIR)
    : join(settings.directory, SNAPSHOTS_DIR, account.key);
  const snapshotsManifest = (account: AccountRecord) => join(appDataDir(account), "manifest.json");
  const snapshotEntrySchema = z.object({ id: z.string(), name: z.string(), createdTime: z.string(), size: z.string() });
  const readSnapshots = (account: AccountRecord): Array<z.infer<typeof snapshotEntrySchema>> => {
    const manifest = snapshotsManifest(account);
    if (!existsSync(manifest)) return [];
    try { return z.array(snapshotEntrySchema).parse(JSON.parse(readFileSync(manifest, "utf8"))); }
    catch { return []; }
  };
  const storeSnapshot = (account: AccountRecord, id: string, name: string, payload: string) => {
    mkdirSync(appDataDir(account), { recursive: true });
    writeFileSync(join(appDataDir(account), `${id}.payload`), payload, { mode: 0o600 });
    const manifest = readSnapshots(account);
    manifest.push({ id, name, createdTime: new Date().toISOString(), size: String(payload.length) });
    writeFileSync(snapshotsManifest(account), JSON.stringify(manifest), { mode: 0o600 });
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const mode = currentMode();
    if (request.url === "https://www.googleapis.com/oauth2/v3/certs" && request.method === "GET") return json(JSON.stringify({ keys: [settings.jwk] }));
    if (request.url === "https://oauth2.googleapis.com/token" && request.method === "POST") {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") === "authorization_code") {
        // Consent-code exchange for the opt-in Drive connect. Same credential
        // boundary as refresh: client id/secret must match the captured ones
        // and the redirect_uri must be this deployment's own callback path.
        const consent = readConsent();
        // Which Google account is completing consent, and therefore which
        // subject and token pair the exchange mints. Naming an account is how a
        // suite gives two Muster accounts two different Google accounts.
        const consenting = (consent?.account !== undefined ? accountByKey(consent.account) : null) ?? primaryAccount();
        record("exchange", mode, body.size === (consent ? 6 : 5) && (!consent || body.get("code_verifier") === consent.verifier) && body.get("client_id") === settings.clientId
          && body.get("client_secret") === settings.clientSecret && body.get("grant_type") === "authorization_code"
          && body.get("redirect_uri")?.includes("/api/workspace/google/callback") === true);
        if (mode === "hold-exchange") {
          writeFileSync(owned("exchange-held"), "held", { mode: 0o600 });
          const deadline = Date.now() + 20_000;
          try {
            while (currentMode() === "hold-exchange") {
              request.signal.throwIfAborted();
              if (Date.now() >= deadline) throw new Error("Owned exchange hold expired");
              await new Promise<void>(resolve => setTimeout(resolve, 20));
            }
          } finally { rmSync(owned("exchange-held"), { force: true }); }
        }
        if (mode === "refresh-error") return json('{"error":"fixture exchange refused"}', 503);
        const idToken = consent ? await new SignJWT({ nonce: consent.nonce })
          .setProtectedHeader({ alg: "RS256", kid: "owned-drive-key" }).setIssuer("https://accounts.google.com")
          .setAudience(settings.clientId).setSubject(consent.googleSub ?? consenting.googleSubject).setIssuedAt().setExpirationTime("5m")
          .sign(await importPKCS8(settings.privateKey, "RS256")) : undefined;
        const response: FixtureTokenResponse = {
          access_token: consenting.accessToken, refresh_token: consenting.refreshToken, expires_in: 3600,
        };
        if (consent) { response.id_token = idToken; response.scope = consent.scope ?? "openid https://www.googleapis.com/auth/drive.appdata"; response.token_type = "Bearer"; }
        return json(JSON.stringify(response));
      }
      // A refresh mints for the account the refresh token belongs to, never for
      // whoever happens to be asking. An unknown refresh token is a credential
      // boundary violation, exactly like an unknown bearer token below.
      const refreshing = accountByRefreshToken(body.get("refresh_token") ?? "");
      record("refresh", mode, body.size === 4 && refreshing !== null
        && body.get("client_id") === settings.clientId && body.get("client_secret") === settings.clientSecret
        && body.get("grant_type") === "refresh_token");
      if (mode === "refresh-error") return json('{"error":"fixture refresh refused"}', 503);
      // SAFETY: `record` above throws unless the refresh token resolved to a
      // registered account, so this is non-null on every line below.
      const refreshed = { access_token: refreshing!.accessToken, expires_in: 3600 };
      return json(JSON.stringify(existsSync(owned("consent.json")) ? { ...refreshed, token_type: "Bearer" } : refreshed));
    }
    if (url.origin !== "https://www.googleapis.com") return blocked();
    // The bearer token IS the account. Drive's appDataFolder is scoped to the
    // Google identity behind it, so the account resolved here decides which
    // records a list can see and which a download can reach.
    const caller = accountByToken((request.headers.get("authorization") ?? "").replace(/^Bearer /u, ""));
    const authorized = caller !== null;
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      if (url.searchParams.get("spaces") !== "appDataFolder" || !(url.searchParams.get("q")?.includes("muster-workspace") ?? false)) return blocked();
      const q = url.searchParams.get("q") || "";
      record("list", mode, authorized);
      if (mode === "list-error") return json('{"error":"fixture list refused"}', 503);
      // Immutable snapshot searches use "name contains"; legacy v1/v2 bundle
      // searches use "name =" on the single owned file id.
      if (q.includes("name contains")) {
        return json(JSON.stringify({ files: readSnapshots(caller!).slice().reverse().map((s) => ({ id: s.id, name: s.name, createdTime: s.createdTime, size: s.size })) }));
      }
      const v2 = q.includes("muster-workspace-v2.enc") === true;
      return json(JSON.stringify({ files: existsSync(owned(v2 ? "uploaded-bundle-v2.txt" : "uploaded-bundle.txt")) ? [{ id: fixtureFileId }] : [] }));
    }
    const v2Name = "muster-workspace-v2.enc";
    const existing = url.pathname === `/upload/drive/v3/files/${fixtureFileId}` && request.method === "PATCH";
    if (existing || (url.pathname === "/upload/drive/v3/files" && request.method === "POST")) {
      const fields = url.searchParams.get("fields") || "";
      if (url.searchParams.get("uploadType") !== "multipart" || (fields !== "id" && fields !== "id,name")) return blocked();
      record("upload", mode, authorized);
      if (mode === "upload-error") return json('{"error":"fixture upload refused"}', 503);
      const boundary = request.headers.get("content-type")?.match(/^multipart\/related; boundary=(.+)$/)?.[1];
      if (!boundary) throw new Error("Fixture expected the real multipart upload");
      const parts = (await request.text()).split(`--${boundary}`);
      const metadataPart = parts.find((part) => part.includes("Content-Type: application/json"));
      const payloadPart = parts.find((part) => part.startsWith("\r\nContent-Type: application/octet-stream\r\n\r\n"));
      if (!metadataPart || !payloadPart) throw new Error("Fixture upload has no metadata or encrypted payload");
      const metadata = z.object({ name: z.string().min(1), parents: z.array(z.literal("appDataFolder")).optional() })
        .parse(JSON.parse(metadataPart.slice(metadataPart.indexOf("\r\n\r\n") + 4).trim()));
      if (!existing && metadata.parents?.[0] !== "appDataFolder") throw new Error("Fixture upload is not appDataFolder scoped");
      const name = metadata.name;
      const payload = payloadPart.slice("\r\nContent-Type: application/octet-stream\r\n\r\n".length, -2);
      // The v1 bundle is the colon-string form; the v2 bundle is a JSON
      // envelope whose kdf/cipher fields carry the encryption. Either way the
      // fixture must refuse raw plaintext workspace bytes.
      const v1Envelope = payload.startsWith("muster-workspace-bundle:1:");
      const v2Envelope = payload.startsWith(`{"magic":"muster-workspace-bundle","schema":`)
        && payload.includes('"kdf"') && payload.includes('"cipher"');
      if (!v1Envelope && !v2Envelope) throw new Error(`Fixture received an unencrypted workspace (head: ${payload.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")})`);
      if (name === v2Name) {
        writeFileSync(owned("uploaded-bundle-v2.txt"), payload, { mode: 0o600 });
        return json(JSON.stringify({ id: fixtureFileId }));
      }
      if (name === "muster-workspace.enc") {
        writeFileSync(owned("uploaded-bundle.txt"), payload, { mode: 0o600 });
        return json(JSON.stringify({ id: fixtureFileId }));
      }
      // Immutable v2 snapshot: a fresh, uniquely-named file per push so a
      // stale device can never clobber the newest backup.
      if (/^muster-workspace-v2-[0-9]+-[0-9a-f]{8}\.enc$/.test(name)) {
        const id = `snap-${randomBytes(6).toString("hex")}`;
        storeSnapshot(caller!, id, name, payload);
        return json(JSON.stringify({ id, name }));
      }
      throw new Error(`Fixture does not recognize bundle name: ${name}`);
    }
    if (url.pathname.startsWith("/drive/v3/files/") && url.search === "?alt=media" && request.method === "GET") {
      const fileId = decodeURIComponent(url.pathname.slice("/drive/v3/files/".length));
      record("download", mode, authorized);
      if (mode === "download-error") return json('{"error":"fixture download refused"}', 503);
      if (mode === "corrupt-download") return new Response("fixture-corrupt-bundle");
      if (mode === "hold-download") {
        writeFileSync(owned("download-held"), "held", { mode: 0o600 });
        const deadline = Date.now() + 20_000;
        try {
          while (currentMode() === "hold-download") {
            request.signal.throwIfAborted();
            if (Date.now() >= deadline) throw new Error("Owned download hold expired");
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
        } finally { rmSync(owned("download-held"), { force: true }); }
      }
      if (fileId === fixtureFileId) {
        // The two bundle names share one file id, so the stored payload decides
        // which to hand back.
        const storedV2 = existsSync(owned("uploaded-bundle-v2.txt"));
        return new Response(readFileSync(owned(storedV2 ? "uploaded-bundle-v2.txt" : "uploaded-bundle.txt"), "utf8"));
      }
      // Immutable v2 snapshots are downloaded by the id assigned at upload time,
      // and only out of the CALLER's own app-data folder. An id that exists for
      // another Google account is a 404 here, exactly as Drive answers one: this
      // is the boundary a two-account test rests on, so it has to be real rather
      // than "the fixture only ever had one account anyway".
      const snapshot = readSnapshots(caller!).find((s) => s.id === fileId);
      if (!snapshot) return Response.json({ error: { message: "Snapshot not found" } }, { status: 404 });
      return new Response(readFileSync(join(appDataDir(caller!), `${fileId}.payload`), "utf8"));
    }
    return blocked();
  };
}

const settingsPath = process.env.MUSTER_DRIVE_FIXTURE;
if (settingsPath) installTransport(settingsPath);
