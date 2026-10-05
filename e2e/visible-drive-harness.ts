/** Owned signed account/server fixture. Only official Google transport is
 * synthetic; actual routes, grants, readers, encryption and parser execute. */
import { z } from "zod";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { connect } from "node:net";
import { pairingServerEnvironment, waitForOwnedServer } from "./pairing-harness.ts";
import { freePortBlock } from "../server/testing/ports.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Mount the actual provider/card together, with a fixture-only recovery
 * control. It invokes the real signed session endpoint without replacing
 * useAuth, card hooks, or any product success response. */
export async function visibleSessionCardFixture(): Promise<string> {
  const result = await build({
    absWorkingDir: ROOT, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    tsconfig: join(ROOT, "tsconfig.json"), define: { "process.env.NODE_ENV": '"development"' },
    stdin: { resolveDir: ROOT, sourcefile: "owned-visible-session-card.tsx", loader: "tsx", contents: `
      import { createRoot } from "react-dom/client";
      import { AuthProvider, useAuth } from "./src/lib/auth";
      import { VisibleDriveCard } from "./src/components/VisibleDriveCard";
      function SessionRecoveryControl() {
        const auth = useAuth();
        return <><button onClick={() => void auth.retrySession()}>Recheck owned signed session</button>
          <output aria-label="Owned session identity">{auth.session?.id ?? "checking"}</output></>;
      }
      createRoot(document.getElementById("owned-session-card")!).render(
        <AuthProvider><SessionRecoveryControl /><VisibleDriveCard /></AuthProvider>);
    ` },
  });
  const script = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
  return `<!doctype html><title>Owned actual AuthProvider session fixture</title><div id="owned-session-card"></div><script>${script}</script>`;
}
type OwnedRequestBody = Record<string, string | boolean>;
const copiesSchema = z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), user: z.enum(["alice", "bob"]), mimeType: z.string() }));
const PREFIX = "/api/workspace/drive-visible";
const preload = String.raw`
import { Socket } from 'node:net';
import * as dns from 'node:dns';
import * as dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, sign } from 'node:crypto';
import { join } from 'node:path';
const directory = process.env.MUSTER_VISIBLE_BROWSER_FIXTURE;
const settings = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const log = join(directory, 'outbound.txt');
const deny = () => { appendFileSync(log, 'denied-outbound\n'); throw new Error('Owned fixture refuses outbound transport'); };
Socket.prototype.connect = deny;
dns.default.lookup = (host, options, callback) => {
 if (host !== '127.0.0.1' && host !== '::1') return deny();
 const done = typeof options === 'function' ? options : callback; const family = host === '::1' ? 6 : 4;
 queueMicrotask(() => options?.all ? done(null, [{address:host,family}]) : done(null,host,family));
};
for (const key of Object.keys(dns.default)) if (/^resolve|^reverse$/.test(key) && typeof dns.default[key] === 'function') dns.default[key] = deny;
for (const key of Object.keys(dns.default.promises)) if (/^(lookup|resolve|reverse)/.test(key)) dns.default.promises[key] = async () => deny();
dgram.default.createSocket = deny; syncBuiltinESMExports();
const filesPath = join(directory, 'copies.json');
const files = () => JSON.parse(readFileSync(filesPath, 'utf8'));
const save = values => writeFileSync(filesPath, JSON.stringify(values));
const digest = bytes => createHash('md5').update(bytes).digest('hex');
const journal = (operation, user) => appendFileSync(join(directory,'transport.jsonl'), JSON.stringify({operation,user,credentialsMatch:true})+'\n');
const json = value => Response.json(value);
const body = init => typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : deny();
globalThis.fetch = async (input, init = {}) => {
 const url = new URL(String(input)); const method = init.method || 'GET';
 if (init.redirect !== 'error') return deny();
 if (url.href === 'https://www.googleapis.com/oauth2/v3/certs' && method === 'GET') { journal('jwks','none'); return json({keys:[settings.jwk]}); }
 if (url.href === 'https://oauth2.googleapis.com/token' && method === 'POST') {
  const params = new URLSearchParams(body(init));
  if (params.get('client_id') !== settings.clientId || params.get('client_secret') !== settings.clientSecret) return deny();
  if (params.get('grant_type') === 'refresh_token') {
   const user = ['alice','bob'].find(user => params.get('refresh_token') === 'synthetic-refresh-'+user); if (!user) return deny();
   journal('refresh',user); return json({access_token:'synthetic-access-'+user,expires_in:3600,token_type:'Bearer',scope:'openid https://www.googleapis.com/auth/drive.file'});
  }
  if (params.get('grant_type') !== 'authorization_code' || params.get('redirect_uri') !== settings.origin+settings.callback) return deny();
  const offered = JSON.parse(Buffer.from(params.get('code') || '', 'base64url').toString('utf8'));
  if (!['alice','bob'].includes(offered.user) || !offered.nonce || createHash('sha256').update(params.get('code_verifier') || '').digest('base64url') !== offered.challenge) return deny();
  journal('exchange',offered.user);
  if (JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).mode === 'hold-exchange') {
   writeFileSync(join(directory,'exchange-held'),'entered');
   while (JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).mode === 'hold-exchange') await new Promise(done => setTimeout(done,25));
  }
  const header = Buffer.from(JSON.stringify({alg:'RS256',kid:'owned-visible-key'})).toString('base64url');
  const claims = Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:settings.clientId,sub:'google-'+offered.user,nonce:offered.nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
  const token = header+'.'+claims+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+claims),settings.privateKey).toString('base64url');
  return json({access_token:'synthetic-access-'+offered.user,refresh_token:'synthetic-refresh-'+offered.user,expires_in:3600,token_type:'Bearer',scope:'openid https://www.googleapis.com/auth/drive.file',id_token:token});
 }
 if (url.origin !== 'https://www.googleapis.com') return deny();
 const headers = new Headers(init.headers); const authorization = headers.get('authorization');
 const user = ['alice','bob'].find(user => authorization === 'Bearer synthetic-access-'+user); if (!user) return deny();
 const current = files();
 if (url.pathname === '/drive/v3/files/root' && method === 'GET' && url.searchParams.get('fields') === 'id') { journal('root',user); return json({id:'owned-root-'+user}); }
 if (url.pathname === '/drive/v3/files' && method === 'GET') {
  if (url.searchParams.get('spaces') !== 'drive' || url.searchParams.get('corpora') !== 'user' || url.searchParams.get('pageSize') !== '1000') return deny();
  const q = url.searchParams.get('q') || ''; const name = q.match(/name = '([^']+)'/)?.[1]; const parent = q.match(/'([^']+)' in parents/)?.[1];
  if (!name || !parent || !q.includes('trashed = false')) return deny();
  journal('list',user); return json({files:current.filter(file => file.user === user && file.name === name && file.parents.includes(parent)).map(({user,bytes,...file})=>file)});
 }
 if (url.pathname === '/drive/v3/files' && method === 'POST') {
  const offered = JSON.parse(body(init)); if (offered.mimeType !== 'application/vnd.google-apps.folder' || !['Muster','backups'].includes(offered.name) || offered.parents.length !== 1) return deny();
  const file = {id:'owned-folder-'+user+'-'+current.length,user,name:offered.name,parents:offered.parents,mimeType:offered.mimeType}; current.push(file);save(current);journal('folder',user);return json(file);
 }
 if (url.pathname === '/upload/drive/v3/files' && method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
  const match = headers.get('content-type')?.match(/^multipart\/related; boundary=([A-Za-z0-9_-]+)$/); if (!match) return deny();
  const raw = Buffer.from(init.body); const split = raw.indexOf('\r\n\r\n'); const metaEnd = raw.indexOf('\r\n--'+match[1],split+4);
  const metadata = JSON.parse(raw.subarray(split+4,metaEnd).toString('utf8')); const binaryHeader = raw.indexOf('\r\n\r\n',metaEnd); const binaryEnd = raw.lastIndexOf('\r\n--'+match[1]+'--');
  const bytes = raw.subarray(binaryHeader+4,binaryEnd);
  if (metadata.mimeType !== 'application/octet-stream' || !/^muster-account-recovery-v1-[a-f0-9]{64}\.enc$/.test(metadata.name) || !bytes.length || bytes.includes(Buffer.from('Owned visible browser'))) return deny();
  const id = 'owned-copy-'+user+'-'+current.length; const file = {id,user,name:metadata.name,parents:metadata.parents,mimeType:metadata.mimeType,md5Checksum:digest(bytes),size:String(bytes.length),capabilities:{canDownload:true}};
  writeFileSync(join(directory,id+'.bin'),bytes); current.push(file);save(current);journal('upload',user);return json(file);
 }
 const id = url.pathname.match(/^\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/)?.[1]; const file = current.find(file => file.user === user && file.id === id);
 if (method === 'GET' && id && file) {
  if (url.searchParams.get('alt') === 'media') { journal('download',user);return new Response(readFileSync(join(directory,id+'.bin'))); }
  journal('metadata',user);return json(file);
 }
 if (method === 'GET' && id) return new Response('{}',{status:404});
 return deny();
};
`;

async function closed(port: number): Promise<boolean> {
  return new Promise((done, reject) => {
    const socket = connect({ host: "127.0.0.1", port }); socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); done(false); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Owned port did not settle")); });
    socket.once("error", (failure: NodeJS.ErrnoException) => { socket.destroy(); if (failure.code === "ECONNREFUSED") done(true); else reject(failure); });
  });
}

export async function startVisibleDriveHarness() {
  if (!existsSync(join(ROOT, "dist/index.html"))) throw new Error("Build the actual owned app before browser acceptance.");
  const directory = mkdtempSync(join(tmpdir(), "muster-visible-browser-"));
  const dataDir = join(directory, "data");
  for (const path of [dataDir, join(directory, "home"), join(directory, "companion"), join(directory, "transport")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Owned offline fixture" } } }), { mode: 0o600 });
  const ports = await freePortBlock([0, 1], 39_000, 5000);
  const origin = `http://127.0.0.1:${ports}`;
  const secret = randomBytes(32).toString("hex");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const transportDir = join(directory, "transport");
  writeFileSync(join(transportDir, "fixture.json"), JSON.stringify({ origin, callback: `${PREFIX}/callback`, clientId: "owned-visible-client",
    clientSecret: "owned-visible-secret", privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwk: { ...keys.publicKey.export({ format: "jwk" }), kid: "owned-visible-key", use: "sig", alg: "RS256" } }), { mode: 0o600 });
  writeFileSync(join(transportDir, "copies.json"), "[]"); writeFileSync(join(transportDir, "control.json"), '{"mode":"ok"}');
  const preloadPath = join(directory, "google-fixture.mjs"); writeFileSync(preloadPath, preload, { mode: 0o600 });
  const env = pairingServerEnvironment({ home: join(directory, "home"), dataDirectory: dataDir, companionDirectory: join(directory, "companion"),
    staticDir: join(ROOT, "dist"), port: ports, webhookPort: ports + 1, secret });
  Object.assign(env, { GOOGLE_CLIENT_ID: "owned-visible-client", GOOGLE_CLIENT_SECRET: "owned-visible-secret", MUSTER_VISIBLE_BROWSER_FIXTURE: transportDir, TELEGRAM_CHANNEL_BOT_ID: "" });
  const child = spawn(process.execPath, ["--import", preloadPath, "--experimental-strip-types", join(ROOT, "server/index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; const append = (chunk: Buffer) => { log = (log + String(chunk)).slice(-32_768); };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  let db: DatabaseSync | undefined;
  let stopped = false;
  const cleanup = async () => {
    if (stopped) return; stopped = true; db?.close();
    await waitForExit(child, { signal: "SIGTERM", graceMs: 5000 });
    const exited = child.exitCode !== null || child.signalCode !== null;
    const closedPorts = await Promise.all([ports, ports + 1].map(closed));
    const noOutbound = !existsSync(join(transportDir, "outbound.txt"));
    const copies = copiesSchema.parse(JSON.parse(readFileSync(join(transportDir, "copies.json"), "utf8")));
    const artifacts = copies.filter(file => file.mimeType === "application/octet-stream").map(file => {
      const bytes = readFileSync(join(transportDir, `${file.id}.bin`)); return { id: file.id, user: file.user, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const receipt = { sourceRoot: ROOT, fixtureDirectory: directory, pid: child.pid, ports: [ports, ports + 1], exited, closedPorts, noOutbound, artifacts };
    if (exited && closedPorts.every(Boolean)) await removeTempDir(directory);
    if (!exited || !closedPorts.every(Boolean) || !noOutbound) throw new Error(JSON.stringify(receipt));
    return { ...receipt, removed: !existsSync(directory), log };
  };
  const sessionTokens = { alice: "alice-owned-session-token", bob: "bob-owned-session-token" };
  const cookie = (user: "alice" | "bob") => {
    const token = sessionTokens[user];
    return { name: "better-auth.session_token", value: encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`), url: origin, httpOnly: true, sameSite: "Lax" as const };
  };
  const request = (path: string, user: "alice" | "bob" = "alice", offered?: OwnedRequestBody) => fetch(`${origin}${path}`, {
    method: offered === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { origin, cookie: `${cookie(user).name}=${cookie(user).value}`, "content-type": "application/json" },
    body: offered === undefined ? undefined : JSON.stringify(offered),
  });
  try {
    await waitForOwnedServer(child, origin);
    db = new DatabaseSync(join(dataDir, "auth.db")); db.exec("PRAGMA foreign_keys=ON");
    for (const [ordinal, user] of ["alice", "bob"].entries()) {
      const createdAt = new Date(Date.now() - (2 - ordinal) * 86_400_000).toISOString();
      db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)")
        .run(user, `Owned ${user}`, `${user}@owned.example.test`, 1, createdAt, createdAt);
      db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES(?,?,?,?)").run(`${user}-org`, user, user, createdAt);
      db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)").run(`${user}-member`, `${user}-org`, user, "owner", createdAt);
      db.prepare("INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt,activeOrganizationId) VALUES(?,?,?,?,?,?,?)")
        .run(`${user}-session`, user, `${user}-owned-session-token`, new Date(Date.now() + 86_400_000).toISOString(), createdAt, createdAt, `${user}-org`);
    }
    const created = await request("/api/bots", "alice", { name: "Owned visible browser", title: "Synthetic backup fixture" });
    if (!created.ok) throw new Error(`Owned bot creation failed: ${created.status}`);
    return { origin, directory, dataDir, transportDir, child, db, cookie, request, cleanup,
      replaceSession(user: "alice" | "bob") {
        const id = `${user}-replacement-${randomBytes(8).toString("hex")}`;
        const token = randomBytes(32).toString("hex");
        db!.prepare("UPDATE session SET id=?,token=?,updatedAt=? WHERE userId=?").run(id, token, new Date().toISOString(), user);
        sessionTokens[user] = token;
        return { id, cookie: cookie(user) };
      },
      setMode(mode: "ok" | "hold-exchange") { writeFileSync(join(transportDir, "control.json"), JSON.stringify({ mode })); },
      copies() { return copiesSchema.parse(JSON.parse(readFileSync(join(transportDir, "copies.json"), "utf8"))); },
    };
  } catch (failure) { await cleanup(); throw failure; }
}
