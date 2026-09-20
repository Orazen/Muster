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
    setConsent(consent: { nonce: string; verifier: string; googleSub?: string; scope?: string }) {
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
  const snapshotsManifest = () => owned("snapshots/manifest.json");
  const snapshotEntrySchema = z.object({ id: z.string(), name: z.string(), createdTime: z.string(), size: z.string() });
  const readSnapshots = (): Array<z.infer<typeof snapshotEntrySchema>> => {
    if (!existsSync(snapshotsManifest())) return [];
    try { return z.array(snapshotEntrySchema).parse(JSON.parse(readFileSync(snapshotsManifest(), "utf8"))); }
    catch { return []; }
  };
  const storeSnapshot = (id: string, name: string, payload: string) => {
    mkdirSync(owned("snapshots"), { recursive: true });
    writeFileSync(owned(`snapshots/${id}.payload`), payload, { mode: 0o600 });
    const manifest = readSnapshots();
    manifest.push({ id, name, createdTime: new Date().toISOString(), size: String(payload.length) });
    writeFileSync(snapshotsManifest(), JSON.stringify(manifest), { mode: 0o600 });
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
        const consent = existsSync(owned("consent.json")) ? z.object({ nonce: z.string(), verifier: z.string(), googleSub: z.string().optional(), scope: z.string().optional() }).parse(JSON.parse(readFileSync(owned("consent.json"), "utf8"))) : null;
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
          .setAudience(settings.clientId).setSubject(consent.googleSub ?? settings.googleSubject).setIssuedAt().setExpirationTime("5m")
          .sign(await importPKCS8(settings.privateKey, "RS256")) : undefined;
        const response: FixtureTokenResponse = {
          access_token: settings.accessToken, refresh_token: settings.refreshToken, expires_in: 3600,
        };
        if (consent) { response.id_token = idToken; response.scope = consent.scope ?? "openid https://www.googleapis.com/auth/drive.appdata"; response.token_type = "Bearer"; }
        return json(JSON.stringify(response));
      }
      record("refresh", mode, body.size === 4 && body.get("refresh_token") === settings.refreshToken
        && body.get("client_id") === settings.clientId && body.get("client_secret") === settings.clientSecret
        && body.get("grant_type") === "refresh_token");
      if (mode === "refresh-error") return json('{"error":"fixture refresh refused"}', 503);
      const refreshed = { access_token: settings.accessToken, expires_in: 3600 };
      return json(JSON.stringify(existsSync(owned("consent.json")) ? { ...refreshed, token_type: "Bearer" } : refreshed));
    }
    if (url.origin !== "https://www.googleapis.com") return blocked();
    const authorized = request.headers.get("authorization") === `Bearer ${settings.accessToken}`;
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      if (url.searchParams.get("spaces") !== "appDataFolder" || !(url.searchParams.get("q")?.includes("muster-workspace") ?? false)) return blocked();
      const q = url.searchParams.get("q") || "";
      record("list", mode, authorized);
      if (mode === "list-error") return json('{"error":"fixture list refused"}', 503);
      // Immutable snapshot searches use "name contains"; legacy v1/v2 bundle
      // searches use "name =" on the single owned file id.
      if (q.includes("name contains")) {
        return json(JSON.stringify({ files: readSnapshots().slice().reverse().map((s) => ({ id: s.id, name: s.name, createdTime: s.createdTime, size: s.size })) }));
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
        storeSnapshot(id, name, payload);
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
      // Immutable v2 snapshots are downloaded by the id assigned at upload time.
      const snapshot = readSnapshots().find((s) => s.id === fileId);
      if (!snapshot) return Response.json({ error: { message: "Snapshot not found" } }, { status: 404 });
      return new Response(readFileSync(owned(`snapshots/${fileId}.payload`), "utf8"));
    }
    return blocked();
  };
}

const settingsPath = process.env.MUSTER_DRIVE_FIXTURE;
if (settingsPath) installTransport(settingsPath);
