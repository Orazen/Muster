/** Synthetic Google transport installed only in an explicitly owned child.
 * The real server still builds, encrypts, decrypts and restores its bundles.
 * No Google account, network listener or successful product response is faked.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const modeSchema = z.enum(["ok", "refresh-error", "list-error", "upload-error", "download-error", "corrupt-download", "hold-download"]);
export type DriveFixtureMode = z.infer<typeof modeSchema>;
const settingsSchema = z.object({ directory: z.string(), refreshToken: z.string(), clientId: z.string(), clientSecret: z.string(), accessToken: z.string() });
const entrySchema = z.object({ operation: z.enum(["refresh", "list", "upload", "download"]), mode: modeSchema, credentialsMatch: z.boolean() });
const fixtureFileId = "owned-workspace-file";

/** Its credential values are synthetic and must remain in owned fixture files. */
export function createWorkspaceDriveFixture(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const settings = { directory, refreshToken: randomBytes(24).toString("hex"), clientId: randomBytes(24).toString("hex"), clientSecret: randomBytes(24).toString("hex"), accessToken: randomBytes(24).toString("hex") };
  const settingsPath = join(directory, "settings.json");
  const controlPath = join(directory, "control.json");
  const journalPath = join(directory, "transport.jsonl");
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  writeFileSync(controlPath, JSON.stringify({ mode: "ok" }), { mode: 0o600 });
  return {
    preloadPath: fileURLToPath(import.meta.url),
    env: { MUSTER_DRIVE_FIXTURE: settingsPath, GOOGLE_CLIENT_ID: settings.clientId, GOOGLE_CLIENT_SECRET: settings.clientSecret },
    refreshToken: settings.refreshToken,
    payloadPath: join(directory, "uploaded-bundle.txt"),
    networkLog: join(directory, "outbound-attempts.txt"),
    heldDownloadPath: join(directory, "download-held"),
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
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const mode = currentMode();
    if (request.url === "https://oauth2.googleapis.com/token" && request.method === "POST") {
      const body = new URLSearchParams(await request.text());
      record("refresh", mode, body.size === 4 && body.get("refresh_token") === settings.refreshToken
        && body.get("client_id") === settings.clientId && body.get("client_secret") === settings.clientSecret
        && body.get("grant_type") === "refresh_token");
      return mode === "refresh-error" ? json('{"error":"fixture refresh refused"}', 503) : json(JSON.stringify({ access_token: settings.accessToken, expires_in: 3600 }));
    }
    if (url.origin !== "https://www.googleapis.com") return blocked();
    const authorized = request.headers.get("authorization") === `Bearer ${settings.accessToken}`;
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      if (url.searchParams.get("spaces") !== "appDataFolder" || !url.searchParams.get("q")?.includes("muster-workspace.enc")) return blocked();
      record("list", mode, authorized);
      return mode === "list-error" ? json('{"error":"fixture list refused"}', 503)
        : json(JSON.stringify({ files: existsSync(owned("uploaded-bundle.txt")) ? [{ id: fixtureFileId }] : [] }));
    }
    const existing = url.pathname === `/upload/drive/v3/files/${fixtureFileId}`;
    if ((existing && request.method === "PATCH") || (url.pathname === "/upload/drive/v3/files" && request.method === "POST")) {
      if (url.searchParams.get("uploadType") !== "multipart" || url.searchParams.get("fields") !== "id") return blocked();
      record("upload", mode, authorized);
      if (mode === "upload-error") return json('{"error":"fixture upload refused"}', 503);
      const boundary = request.headers.get("content-type")?.match(/^multipart\/related; boundary=(.+)$/)?.[1];
      if (!boundary) throw new Error("Fixture expected the real multipart upload");
      const parts = (await request.text()).split(`--${boundary}`);
      const metadataPart = parts.find((part) => part.includes("Content-Type: application/json"));
      const payloadPart = parts.find((part) => part.startsWith("\r\nContent-Type: application/octet-stream\r\n\r\n"));
      if (!metadataPart || !payloadPart) throw new Error("Fixture upload has no metadata or encrypted payload");
      const metadata = z.object({ name: z.literal("muster-workspace.enc"), parents: z.array(z.literal("appDataFolder")).optional() })
        .parse(JSON.parse(metadataPart.slice(metadataPart.indexOf("\r\n\r\n") + 4).trim()));
      if (!existing && metadata.parents?.[0] !== "appDataFolder") throw new Error("Fixture upload is not appDataFolder scoped");
      const payload = payloadPart.slice("\r\nContent-Type: application/octet-stream\r\n\r\n".length, -2);
      if (!payload.startsWith("muster-workspace-bundle:1:")) throw new Error("Fixture received an unencrypted workspace");
      writeFileSync(owned("uploaded-bundle.txt"), payload, { mode: 0o600 });
      return json(JSON.stringify({ id: fixtureFileId }));
    }
    if (url.pathname === `/drive/v3/files/${fixtureFileId}` && url.search === "?alt=media" && request.method === "GET") {
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
      return new Response(readFileSync(owned("uploaded-bundle.txt"), "utf8"));
    }
    return blocked();
  };
}

const settingsPath = process.env.MUSTER_DRIVE_FIXTURE;
if (settingsPath) installTransport(settingsPath);
