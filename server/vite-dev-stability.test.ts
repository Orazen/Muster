// Real Vite watcher/HMR traffic against an owned minimal app. The optional
// config path is only for an immutable pre-change baseline; normal runs load
// the repository config, including its actual plugins and watcher settings.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile, preview, type InlineConfig, type PreviewServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const payloadSchema = z.object({ type: z.string(), path: z.string().optional(), updates: z.array(z.object({ path: z.string() })).optional() });
type Payload = z.infer<typeof payloadSchema>;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const source = (version: string) => `document.querySelector('#status').textContent = ${JSON.stringify(version)}; if (import.meta.hot) import.meta.hot.accept();\n`;
const html = (label: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owned Vite stability</title></head><body><h1>${label}</h1><p id="status">Loading</p><script type="module" src="/src/main.ts"></script></body></html>`;

describe("owned Vite development stability", () => {
  let directory: string | undefined;
  let vite: ViteDevServer | undefined;
  let occupied: Server | undefined;
  let upstream: Server | undefined;
  let previewServer: PreviewServer | undefined;
  let socket: WebSocket | undefined;
  let port: number | undefined;
  let starts = 0;
  const ownedPorts = new Set<number>();

  async function prepare(backendPort?: number) {
    directory = mkdtempSync(join(tmpdir(), "muster-vite-stability-"));
    mkdirSync(join(directory, "src"));
    mkdirSync(join(directory, ".omb-scratch", "owned-copy"), { recursive: true });
    writeFileSync(join(directory, "index.html"), html("Owned local fixture"));
    writeFileSync(join(directory, "src", "main.ts"), source("first source"));
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
    writeFileSync(join(directory, ".omb-scratch", "owned-copy", "tsconfig.json"), "{}");
    const configPath = process.env.MUSTER_VITE_STABILITY_CONFIG ?? join(ROOT, "vite.config.ts");
    const keys = ["OMB_PORT", "OGB_PORT", "MUSTER_DEV_SERVER_PID"] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    let loaded;
    try {
      if (backendPort !== undefined) {
        process.env.OMB_PORT = String(backendPort);
        delete process.env.OGB_PORT; delete process.env.MUSTER_DEV_SERVER_PID;
      }
      loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, configPath, ROOT);
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    if (!loaded) throw new Error("The actual Vite configuration could not be loaded");
    port = await freePortBlock([0, 1], 35_000, 5_000);
    ownedPorts.add(port); ownedPorts.add(port + 1);
    starts = 0;
    const config: InlineConfig = {
      ...loaded.config, configFile: false, root: directory, envDir: directory,
      cacheDir: join(directory, ".vite"), logLevel: "silent",
      plugins: [...(loaded.config.plugins ?? []), { name: "owned-start-observer", configureServer() { starts++; } }],
      server: { ...loaded.config.server, host: "127.0.0.1", port },
    };
    vite = await createServer(config);
    return { directory, port, vite, config, origin: `http://127.0.0.1:${port}` };
  }

  afterEach(async () => {
    socket?.close();
    await vite?.close();
    for (const server of [occupied, upstream, previewServer?.httpServer]) if (server?.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    const closedPorts = await Promise.all([...ownedPorts].map((ownedPort) => new Promise<boolean>((resolve) => {
      const probe = createConnection({ host: "127.0.0.1", port: ownedPort });
      probe.setTimeout(2_000);
      probe.once("connect", () => { probe.destroy(); resolve(false); });
      probe.once("timeout", () => { probe.destroy(); resolve(false); });
      probe.once("error", (error) => { probe.destroy(); resolve("code" in error && error.code === "ECONNREFUSED"); });
    })));
    const closed = closedPorts.every(Boolean);
    if (directory && closed) rmSync(directory, { recursive: true, force: true });
    const removed = directory === undefined || !existsSync(directory);
    console.info(JSON.stringify({ scope: "owned Vite cleanup", ports: [...ownedPorts], closedPorts, closed, removed, serverClosed: !vite?.httpServer?.listening, blockerClosed: !occupied?.listening, upstreamClosed: !upstream?.listening, previewClosed: !previewServer?.httpServer.listening }));
    socket = undefined; vite = undefined; occupied = undefined; upstream = undefined; previewServer = undefined; directory = undefined; port = undefined; ownedPorts.clear();
    expect({ closed, removed }).toEqual({ closed: true, removed: true });
  });

  it("ignores scratch tsconfig writes while real source and HTML changes still reach HMR", async () => {
    const app = await prepare();
    await app.vite.listen();
    const originalServer = app.vite.httpServer;
    const delivered: Payload[] = [];
    let closed = 0;
    socket = new WebSocket(`ws://127.0.0.1:${app.port}/?token=${app.vite.config.webSocketToken}`, "vite-hmr");
    socket.addEventListener("message", (event) => delivered.push(payloadSchema.parse(JSON.parse(String(event.data)))));
    socket.addEventListener("close", () => { closed++; });
    await expect.poll(() => delivered.some((message) => message.type === "connected")).toBe(true);
    expect((await fetch(app.origin + "/", { redirect: "error" })).status).toBe(200);
    const script = await fetch(app.origin + "/src/main.ts", { redirect: "error" });
    expect(script.status).toBe(200); expect(await script.text()).toContain("first source");
    await expect.poll(() => Object.values(app.vite.watcher.getWatched()).some((files) => files.includes("main.ts"))).toBe(true);

    writeFileSync(join(app.directory, "src", "main.ts"), source("source control"));
    await expect.poll(() => delivered.some((message) => message.type === "update" && message.updates?.some((update) => update.path === "/src/main.ts"))).toBe(true);
    delivered.length = 0;
    writeFileSync(join(app.directory, ".omb-scratch", "owned-copy", "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    mkdirSync(join(app.directory, ".omb-scratch", "new-copy"));
    writeFileSync(join(app.directory, ".omb-scratch", "new-copy", "tsconfig.json"), "{}");
    await pause(1_000);
    expect(delivered.filter((message) => message.type === "full-reload" || message.type === "error")).toEqual([]);
    expect(starts).toBe(1); expect(closed).toBe(0); expect(app.vite.httpServer).toBe(originalServer);

    delivered.length = 0;
    writeFileSync(join(app.directory, "src", "main.ts"), source("source after scratch"));
    await expect.poll(() => delivered.some((message) => message.type === "update" && message.updates?.some((update) => update.path === "/src/main.ts"))).toBe(true);
    expect(await (await fetch(app.origin + "/src/main.ts", { redirect: "error" })).text()).toContain("source after scratch");
    delivered.length = 0;
    writeFileSync(join(app.directory, "index.html"), html("Changed real HTML"));
    await expect.poll(() => delivered.some((message) => message.type === "full-reload" && message.path === "/index.html")).toBe(true);
    expect(await (await fetch(app.origin + "/", { redirect: "error" })).text()).toContain("Changed real HTML");
  });

  it("refuses an occupied configured UI port instead of silently choosing another", async () => {
    const app = await prepare();
    occupied = createHttpServer((_request, response) => response.end("owned port holder"));
    await new Promise<void>((resolve, reject) => {
      occupied!.once("error", reject);
      occupied!.listen(app.port, "127.0.0.1", resolve);
    });
    let failure: string | null = null;
    try { await app.vite.listen(); } catch (error) { if (!(error instanceof Error)) throw error; failure = error.message; }
    expect(failure).toMatch(/already in use/);
    expect(await (await fetch(app.origin, { redirect: "error" })).text()).toBe("owned port holder");
    expect(app.vite.httpServer?.listening).toBe(false);
  });

  it.each(["development", "preview"])("guards the real %s proxy before forwarding a POST", async (mode) => {
    let recognized = false;
    const seen: { method: string; path: string; cookie?: string; authorization?: string; body: string }[] = [];
    upstream = createHttpServer((request, response) => {
      let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        seen.push({ method: request.method ?? "", path: request.url ?? "", cookie: request.headers.cookie, authorization: request.headers.authorization, body });
        response.writeHead(request.url === "/api/health" ? 200 : 202, { "content-type": "application/json" });
        response.end(JSON.stringify(request.url === "/api/health" ? { app: recognized ? "muster" : "different-app", pid: process.pid } : { ok: true }));
      });
    });
    await new Promise<void>((resolve, reject) => { upstream!.once("error", reject); upstream!.listen(0, "127.0.0.1", resolve); });
    const backendPort = z.object({ port: z.number() }).parse(upstream.address()).port;
    ownedPorts.add(backendPort);
    const app = await prepare(backendPort);
    if (mode === "preview") {
      await app.vite.close(); vite = undefined;
      const dist = join(app.directory, "dist"); mkdirSync(dist); writeFileSync(join(dist, "index.html"), html("Owned preview fixture"));
      previewServer = await preview({ ...app.config, build: { ...app.config.build, outDir: dist }, preview: { ...app.config.preview, host: "127.0.0.1", port: app.port } });
    } else await app.vite.listen();
    const post = () => fetch(app.origin + "/api/bots/owned/messages?probe=1", {
      method: "POST", body: "exact synthetic draft", headers: { cookie: "owned-fixture=1", authorization: "Bearer synthetic-owned" }, redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    const refused = await post();
    expect(refused.status).toBe(503); expect(await refused.text()).toContain("No API request was forwarded");
    const health = { method: "GET", path: "/api/health", cookie: undefined, authorization: undefined, body: "" };
    expect(seen).toEqual([health]);
    recognized = true;
    const accepted = await post();
    expect(accepted.status).toBe(202); expect(await accepted.json()).toEqual({ ok: true });
    expect(seen).toEqual([health, health, { method: "POST", path: "/api/bots/owned/messages?probe=1", cookie: "owned-fixture=1", authorization: "Bearer synthetic-owned", body: "exact synthetic draft" }]);
  });
});
