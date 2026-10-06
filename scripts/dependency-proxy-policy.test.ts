// Exercise the declared Electron builder -> @electron/get -> Got consumer.
// Children own all proxy globals, loopback ports and temporary artifact data.
// The socket checks below are process-local fixture guards, not OS isolation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Agent, ClientRequest, ClientRequestArgs, IncomingMessage, Server } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const electronBuilderRequire = createRequire(rootRequire.resolve("electron-builder/package.json"));
const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib/package.json"));
const getPackage = builderRequire.resolve("@electron/get/package.json");
const getRequire = createRequire(getPackage);
const proxyPackage = getRequire.resolve("global-agent/package.json");
const proxyRequire = createRequire(proxyPackage);
const gotRequire = createRequire(getRequire.resolve("got/package.json"));
const cacheRequire = createRequire(gotRequire.resolve("cacheable-request/package.json"));
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "muster-proxy-policy-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Generate test-only keys in memory. Minimal DER encodes fixture certificates;
// Node/OpenSSL performs the actual TLS signature, trust and hostname checks.
// No fixed private key, external certificate tool or production trust is used.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts);
  const hex = value.length.toString(16).padStart(value.length.toString(16).length + value.length.toString(16).length % 2, "0");
  const size = value.length < 128 ? Buffer.from([value.length]) : Buffer.concat([
    Buffer.from([128 + hex.length / 2]), Buffer.from(hex, "hex"),
  ]);
  return Buffer.concat([Buffer.from([tag]), size, value]);
}
const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, "hex"));
const signatureAlgorithm = sequence(oid("2a864886f70d01010b"), der(0x05));
const distinguishedName = (name: string): Buffer => sequence(der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from(name)))));
const pem = (label: string, bytes: Buffer): string => `-----BEGIN ${label}-----\n${bytes.toString("base64").match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
const caKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serverKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const caName = distinguishedName("Muster ephemeral fixture CA");
function certificate(ca: boolean, hostnameMismatch = false): string {
  const keys = ca ? caKeys : serverKeys;
  const serial = randomBytes(15);
  serial[0] |= 0x80; // The leading zero below is required only for this sign bit.
  const constraints = sequence(oid("551d13"), der(0x01, Buffer.from([255])), der(0x04, sequence(...(ca ? [der(0x01, Buffer.from([255]))] : []))));
  const names = hostnameMismatch ? [der(0x82, Buffer.from("wrong.fixture.invalid"))] : [der(0x87, Buffer.from([127, 0, 0, 1]))];
  const extensions = [constraints, ...(ca ? [] : [sequence(oid("551d11"), der(0x04, sequence(...names)))])];
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.concat([Buffer.from([0]), serial])),
    signatureAlgorithm, caName,
    sequence(der(0x18, Buffer.from("20200101000000Z")), der(0x18, Buffer.from("20400101000000Z"))),
    ca ? caName : distinguishedName("Muster loopback fixture"),
    keys.publicKey.export({ type: "spki", format: "der" }), der(0xa3, sequence(...extensions)),
  );
  return pem("CERTIFICATE", sequence(tbs, signatureAlgorithm, der(0x03, Buffer.from([0]), sign("sha256", tbs, caKeys.privateKey))));
}
const caPath = join(scratch, "ca.pem");
const certPath = join(scratch, "server.pem");
const wrongHostCertPath = join(scratch, "wrong-host.pem");
const keyPath = join(scratch, "server-key.pem");
writeFileSync(caPath, certificate(true));
writeFileSync(certPath, certificate(false));
writeFileSync(wrongHostCertPath, certificate(false, true));
writeFileSync(keyPath, serverKeys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

type Scenario = "http-proxy" | "https-proxy" | "https-direct" | "https-proxy-node-ca" | "direct" | "no-proxy" | "no-proxy-list" | "no-proxy-wildcard"
  | "runtime-proxy" | "runtime-bypass" | "separate-https-proxy" | "explicit-agent-forced" | "explicit-agent-direct"
  | "untrusted-ca" | "hostname-mismatch" | "explicit-tls-opt-out" | "proxy-refused" | "connect-refused"
  | "proxy-outage" | "connect-timeout" | "origin-error" | "abort" | "checksum-mismatch"
  | "connect-delayed" | "connect-repeated-response" | "connect-timeout-late-data" | "connect-timeout-close"
  | "connect-request-timeout" | "connect-abort-signal" | "connect-abort-successor" | "connect-abort-own-descriptor" | "connect-pre-aborted-signal" | "connect-abort-native-successor"
  | "connect-default-timeout" | "connect-explicit-timeout" | "connect-zero-timeout";
interface ChildConfig { scenario: Scenario; getPackage: string; scratch: string; caPath: string; certPath: string; wrongHostCertPath: string; keyPath: string }
interface ChildModules {
  assert: typeof assert;
  http: typeof import("node:http"); https: typeof import("node:https"); net: typeof import("node:net");
  fs: typeof import("node:fs"); path: typeof import("node:path");
  createRequire: typeof createRequire; createHash: typeof createHash;
  z: typeof z;
}
interface ProxyController { HTTP_PROXY: string | null; HTTPS_PROXY: string | null; NO_PROXY: string | null }
interface ProxyConnection { host: string; port: number; proxy: { hostname: string; port: number }; tls: import("node:tls").ConnectionOptions }
type ProxyConnectionCallback = (error: Error | null, socket?: Socket) => void;
interface HttpsProxyPrototype {
  socketConnectionTimeout: number;
  createConnection(configuration: ProxyConnection, callback: ProxyConnectionCallback, request?: ClientRequest): void;
}
interface ProxyAgentPrototype { addRequest(request: ClientRequest, configuration: ClientRequestArgs): void }
interface DownloadOptions {
  quiet: boolean; retry: number; timeout: { request: number }; followRedirect: boolean;
  https?: { certificateAuthority?: Buffer; rejectUnauthorized?: boolean };
  agent?: { http: Agent };
  request?: (url: URL, options: ClientRequestArgs) => ClientRequest;
}

// Kept self-contained so the transpiled function can run in a fresh Node child.
async function consumerChild(config: ChildConfig, modules: ChildModules): Promise<void> {
  const assert: ChildModules["assert"] = modules.assert;
  const { http, https, net, fs, path, createRequire, createHash, z } = modules;
  const require = createRequire(config.getPackage);
  const owned = fs.mkdtempSync(path.join(config.scratch, "child-"));
  const tempDirectory = path.join(owned, "temp");
  const cacheRoot = path.join(owned, "cache");
  fs.mkdirSync(tempDirectory);
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const servers: Server[] = [];
  const allowedPorts = new Set<number>();
  const originPorts = new Set<number>();
  const nativeHttpRequest = http.request;
  const nativeHttpGet = http.get;
  const nativeHttpsRequest = https.request;
  const nativeHttpsGet = https.get;
  const nativeHttpAgent = http.globalAgent;
  const nativeHttpsAgent = https.globalAgent;
  const forwardingAgent = new http.Agent({ keepAlive: false });
  const nativeSocketConnect = net.Socket.prototype.connect;
  // SAFETY: This fresh child has no proxy controller until the version-bound
  // @electron/get initializer creates global-agent's documented three fields.
  const childGlobals = globalThis as typeof globalThis & { GLOBAL_AGENT?: ProxyController };
  const body = Buffer.from("Owned synthetic Electron download fixture.\n");
  const checksum = createHash("sha256").update(body).digest("hex");
  const counts = { httpProxy: 0, secondProxy: 0, connect: 0, secondConnect: 0, origin: 0, abort: 0,
    connectionCallbacks: 0, socketTransfers: 0, destroyRestorations: 0, lateProxyEvents: 0,
    requestErrors: 0, requestCloses: 0, requestSockets: 0, connectionTimeoutMs: 0 };
  const scenario = config.scenario;
  const expectedConnectionTimeout = scenario === "connect-default-timeout" ? 60_000 : scenario === "connect-explicit-timeout" ? 900 : scenario === "connect-zero-timeout" ? 0 : scenario === "connect-request-timeout" ? 2000 : 400;
  const tlsScenario = scenario.startsWith("connect-") || ["https-proxy", "https-direct", "https-proxy-node-ca", "separate-https-proxy", "untrusted-ca", "hostname-mismatch", "explicit-tls-opt-out"].includes(scenario);
  const proxyRequire = createRequire(require.resolve("global-agent/package.json"));
  const proxyModule = z.object({ default: z.instanceof(Function) }).parse(proxyRequire("./dist/classes/HttpsProxyAgent.js"));
  // SAFETY: This version-bound prototype observer calls the installed method
  // unchanged; it records its real callback/transfer and request restoration.
  const proxyPrototype = z.custom<HttpsProxyPrototype>((value) =>
    z.object({ createConnection: z.instanceof(Function) }).safeParse(value).success,
  ).parse(proxyModule.default.prototype);
  const nativeCreateConnection = proxyPrototype.createConnection;
  let successorDestroy: ClientRequest["destroy"] | undefined;
  let successorDescriptor: PropertyDescriptor | undefined;
  let expectedAbortError: Error | undefined;
  let nativeRequestDestroy: ClientRequest["destroy"] | undefined;
  const requestClosures: Promise<void>[] = [];
  const agentModule = z.object({ default: z.instanceof(Function) }).parse(proxyRequire("./dist/classes/Agent.js"));
  const agentPrototype = z.custom<ProxyAgentPrototype>((value) =>
    z.object({ addRequest: z.instanceof(Function) }).safeParse(value).success,
  ).parse(agentModule.default.prototype);
  const nativeAddRequest = agentPrototype.addRequest;
  const observedRequests = new WeakSet<ClientRequest>();
  const observeRequest = (request: ClientRequest): void => {
    if (observedRequests.has(request)) return;
    observedRequests.add(request);
    if (scenario === "connect-abort-own-descriptor") Object.defineProperty(request, "destroy", { value: request.destroy, enumerable: true, configurable: true, writable: false });
    const originalDestroy = request.destroy;
    if (scenario === "connect-abort-native-successor") nativeRequestDestroy = originalDestroy;
    const originalDescriptor = Object.getOwnPropertyDescriptor(request, "destroy");
    request.on("error", (error: Error) => {
      counts.requestErrors += 1;
      if (scenario === "connect-abort-successor" || scenario === "connect-abort-native-successor") assert.equal(error, expectedAbortError);
    });
    request.on("socket", () => { assert.equal(request.destroyed, false); counts.requestSockets += 1; });
    requestClosures.push(new Promise<void>((resolve) => request.once("close", () => {
      counts.requestCloses += 1;
      assert.equal(request.destroy, successorDestroy ?? originalDestroy);
      assert.deepEqual(Object.getOwnPropertyDescriptor(request, "destroy"), successorDescriptor ?? originalDescriptor);
      resolve();
    })));
  };
  agentPrototype.addRequest = function (request, configuration): void {
    observeRequest(request);
    nativeAddRequest.call(this, request, configuration);
  };
  proxyPrototype.createConnection = function (configuration, callback, request): void {
    assert(request, "The installed Agent must supply its real ClientRequest");
    assert.equal(this.socketConnectionTimeout, expectedConnectionTimeout, "The actual bound agent must retain configured timeout precedence");
    counts.connectionTimeoutMs = this.socketConnectionTimeout;
    const originalDestroy = request.destroy;
    const originalDescriptor = Object.getOwnPropertyDescriptor(request, "destroy");
    nativeCreateConnection.call(this, configuration, (error, socket) => {
      counts.connectionCallbacks += 1;
      assert.equal(counts.connectionCallbacks, 1, "Pending CONNECT must complete only once");
      assert.equal(request.destroy, successorDestroy ?? originalDestroy);
      assert.deepEqual(Object.getOwnPropertyDescriptor(request, "destroy"), successorDescriptor ?? originalDescriptor);
      if (scenario === "connect-abort-successor") { assert.equal(error, expectedAbortError); assert.equal(request.destroyed, true); }
      if (scenario === "connect-request-timeout") { z.object({ name: z.literal("TimeoutError"), event: z.literal("request") }).parse(error); assert.equal(request.destroyed, true); }
      counts.destroyRestorations += 1;
      if (socket) { assert.equal(request.destroyed, false, "Cancelled requests must never receive a late socket"); counts.socketTransfers += 1; }
      callback(error, socket);
    }, request);
  };
  const recordSocket = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const deadline = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
    return timer;
  };
  // net.connect and tls.connect eventually use this method. This prevents a
  // fixture regression from dialing a non-owned host/port in this process.
  const guardedConnect = function (this: Socket, ...args: Parameters<Socket["connect"]>): Socket {
    const target = z.preprocess((first) => Array.isArray(first) ? first[0] : Number.isInteger(first) ? { port: first, host: args[1] } : first,
      z.object({ port: z.coerce.number().int(), host: z.literal("127.0.0.1") })).parse(args[0]);
    assert(allowedPorts.has(target.port), "Only owned fixture ports are allowed");
    recordSocket(this);
    return nativeSocketConnect.apply(this, args);
  };
  // SAFETY: The native overloaded method receives its original arguments
  // unchanged; the wrapper validates every TCP target before forwarding it.
  net.Socket.prototype.connect = guardedConnect as Socket["connect"];
  const listen = async (server: Server): Promise<number> => {
    servers.push(server);
    server.on("connection", recordSocket);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = z.object({ address: z.literal("127.0.0.1"), family: z.literal("IPv4"), port: z.number().int().positive() }).parse(server.address());
    allowedPorts.add(address.port);
    return address.port;
  };
  const originHandler = (request: IncomingMessage, response: import("node:http").ServerResponse): void => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/fixture.bin");
    counts.origin += 1;
    if (scenario === "origin-error") { response.writeHead(503); response.end("owned unavailable"); return; }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length, "cache-control": "no-store" });
    if (scenario === "abort") {
      response.write(body.subarray(0, 4));
      deadline(() => response.end(body.subarray(4)), 600);
    } else response.end(body);
  };
  const makeProxy = (second = false): Server => {
    const proxy = http.createServer((request, response) => {
      if (second) counts.secondProxy += 1; else counts.httpProxy += 1;
      assert.equal(request.method, "GET");
      const target = new URL(request.url ?? "");
      assert.equal(target.protocol, "http:");
      assert.equal(target.hostname, "127.0.0.1");
      assert(originPorts.has(Number(target.port)));
      if (scenario === "proxy-outage") { request.socket.destroy(); return; }
      const upstream = nativeHttpRequest(target, { method: "GET", agent: forwardingAgent, headers: { host: target.host } }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on("error", () => { response.destroy(); });
      request.on("aborted", () => upstream.destroy());
      response.once("close", () => upstream.destroy());
      upstream.end();
    });
    proxy.on("connect", (request, socket, head) => {
      if (second) counts.secondConnect += 1; else counts.connect += 1;
      assert.equal(request.method, "CONNECT");
      const target = new URL(`http://${request.url}`);
      assert.equal(target.hostname, "127.0.0.1");
      assert(originPorts.has(Number(target.port)));
      socket.on("error", () => { /* The fixture owns expected late writes after cancellation. */ });
      if (scenario === "connect-refused") { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
      if (["connect-timeout", "connect-request-timeout", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor"].includes(scenario)) return;
      if (scenario === "connect-timeout-late-data") {
        deadline(() => { counts.lateProxyEvents += 1; socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); }, 650);
        return;
      }
      if (scenario === "connect-timeout-close") {
        deadline(() => { counts.lateProxyEvents += 1; socket.destroy(); }, 650);
        return;
      }
      if (scenario === "connect-repeated-response") {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        deadline(() => { counts.lateProxyEvents += 1; socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); }, 20);
        return;
      }
      const connectTarget = (): void => {
        const upstream = recordSocket(net.connect(Number(target.port), "127.0.0.1"));
        upstream.once("connect", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        socket.once("close", () => upstream.destroy());
      };
      if (["connect-delayed", "connect-abort-native-successor", "connect-explicit-timeout", "connect-zero-timeout"].includes(scenario)) deadline(connectTarget, 200);
      else connectTarget();
    });
    return proxy;
  };
  let failure: unknown;
  let expectedErrorCode: string | undefined;
  let downloadedHash: string | undefined;
  try {
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(process.env.ELECTRON_GET_NO_PROGRESS, "1");
    const origin = tlsScenario ? https.createServer({ key: fs.readFileSync(config.keyPath), cert: fs.readFileSync(scenario === "hostname-mismatch" ? config.wrongHostCertPath : config.certPath) }, originHandler) : http.createServer(originHandler);
    const originPort = await listen(origin);
    originPorts.add(originPort);
    const proxy = makeProxy();
    const proxyPort = await listen(proxy);
    const secondProxy = makeProxy(true);
    const secondProxyPort = await listen(secondProxy);
    if (!["direct", "https-direct"].includes(scenario)) process.env.GLOBAL_AGENT_HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    if (scenario === "proxy-refused") await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    if (scenario === "separate-https-proxy") process.env.GLOBAL_AGENT_HTTPS_PROXY = `http://127.0.0.1:${secondProxyPort}`;
    if (scenario === "no-proxy") process.env.GLOBAL_AGENT_NO_PROXY = "127.0.0.1";
    if (scenario === "no-proxy-list") process.env.GLOBAL_AGENT_NO_PROXY = "unused.fixture.invalid,\n127.0.0.1";
    if (scenario === "no-proxy-wildcard") process.env.GLOBAL_AGENT_NO_PROXY = "*";
    if (scenario === "explicit-agent-direct") process.env.GLOBAL_AGENT_FORCE_GLOBAL_AGENT = "false";
    if (scenario !== "connect-default-timeout") process.env.GLOBAL_AGENT_SOCKET_CONNECTION_TIMEOUT = scenario === "connect-explicit-timeout" ? "100" : String(expectedConnectionTimeout);
    if (scenario === "connect-explicit-timeout") {
      const proxyApi = z.object({ bootstrap: z.function({ input: [z.object({ socketConnectionTimeout: z.number() })], output: z.boolean() }) }).parse(proxyRequire("./dist/index.js"));
      assert.equal(proxyApi.bootstrap({ socketConnectionTimeout: expectedConnectionTimeout }), true);
    }
    // SAFETY: The package/version and source hashes are bound in the parent
    // test. This is @electron/get3's actual public API, not a mock downloader.
    const downloader = require(require.resolve("./dist/cjs/index.js")) as {
      initializeProxy(): void;
      downloadArtifact(details: { version: string; isGeneric: boolean; artifactName: string; force: boolean; cacheRoot: string; tempDirectory: string; checksums: Record<string, string>; mirrorOptions: { resolveAssetURL: () => Promise<string> }; downloadOptions: DownloadOptions }): Promise<string>;
    };
    downloader.initializeProxy();
    const control = childGlobals.GLOBAL_AGENT;
    assert(control, "@electron/get must initialize its resolved global-agent");
    assert.equal(control.HTTP_PROXY, process.env.GLOBAL_AGENT_HTTP_PROXY || null);
    const options: DownloadOptions = { quiet: true, retry: 0, timeout: { request: 800 }, followRedirect: false,
      request: (url, requestOptions): ClientRequest => {
        const request = (tlsScenario ? https : http).request(url, requestOptions);
        observeRequest(request);
        return request;
      } };
    if (tlsScenario && !["untrusted-ca", "explicit-tls-opt-out", "https-proxy-node-ca"].includes(scenario)) options.https = { certificateAuthority: fs.readFileSync(config.caPath) };
    if (scenario === "explicit-tls-opt-out") options.https = { rejectUnauthorized: false };
    const explicitAgent = new http.Agent({ keepAlive: false });
    if (scenario.startsWith("explicit-agent")) options.agent = { http: explicitAgent };
    if (scenario === "abort") {
      // Got11 has no AbortSignal option. Its supported request adapter invokes
      // the real patched Node request, then explicitly destroys that request.
      options.request = (url, requestOptions): ClientRequest => {
        const request = http.request(url, requestOptions);
        observeRequest(request);
        deadline(() => {
          counts.abort += 1;
          const error = Object.assign(new Error("Owned fixture request aborted"), { code: "ABORT_ERR" });
          request.destroy(error);
        }, 100);
        return request;
      };
    }
    if (["connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-pre-aborted-signal", "connect-abort-native-successor"].includes(scenario)) {
      // Got11's supported adapter passes AbortSignal to the real Node request;
      // Got11 itself does not accept an invented top-level signal option.
      options.request = (url, requestOptions): ClientRequest => {
        const controller = new AbortController();
        if (scenario === "connect-pre-aborted-signal") { counts.abort += 1; controller.abort(); }
        const request = https.request(url, { ...requestOptions, signal: controller.signal });
        observeRequest(request);
        if (scenario === "connect-abort-successor" || scenario === "connect-abort-native-successor") {
          const pendingDestroy = scenario === "connect-abort-native-successor" ? nativeRequestDestroy : request.destroy;
          assert(pendingDestroy, "The actual native destroy method must be captured before CONNECT");
          successorDestroy = function (this: ClientRequest, ...args: Parameters<ClientRequest["destroy"]>): ClientRequest {
            return pendingDestroy.apply(this, args);
          };
          request.destroy = successorDestroy;
          successorDescriptor = Object.getOwnPropertyDescriptor(request, "destroy");
          deadline(() => {
            counts.abort += 1;
            expectedAbortError = Object.assign(new Error("Owned CONNECT abort"), { code: "ABORT_ERR" });
            assert.equal(request.destroy(expectedAbortError), request);
          }, 100);
        } else if (scenario !== "connect-pre-aborted-signal") deadline(() => { counts.abort += 1; controller.abort(); }, 100);
        return request;
      };
    }
    const fetch = async (): Promise<void> => {
      const file = await downloader.downloadArtifact({ version: "44.5.1", isGeneric: true, artifactName: "fixture.bin", force: true,
        cacheRoot, tempDirectory, checksums: { "fixture.bin": scenario === "checksum-mismatch" ? "0".repeat(64) : checksum },
        mirrorOptions: { resolveAssetURL: async () => `${tlsScenario ? "https" : "http"}://127.0.0.1:${originPort}/fixture.bin` }, downloadOptions: options });
      assert(file.startsWith(`${owned}${path.sep}`), "Artifact output must remain in owned scratch");
      downloadedHash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      assert.equal(downloadedHash, checksum);
    };
    const negative = ["untrusted-ca", "hostname-mismatch", "proxy-refused", "connect-refused", "proxy-outage", "connect-timeout", "origin-error", "abort", "checksum-mismatch",
      "connect-repeated-response", "connect-timeout-late-data", "connect-timeout-close", "connect-request-timeout", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-pre-aborted-signal", "connect-abort-native-successor"].includes(scenario);
    if (negative) {
      let captured: Error | undefined;
      try { await fetch(); } catch (error) { captured = z.instanceof(Error).parse(error); }
      assert(captured, "The actual checked download must reject this negative scenario");
      {
        const error = captured;
        const code = z.object({ code: z.string().optional() }).parse(error).code;
        expectedErrorCode = code ?? error.name;
        if (scenario === "untrusted-ca") assert(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(code ?? ""));
        if (scenario === "hostname-mismatch") assert.equal(code, "ERR_TLS_CERT_ALTNAME_INVALID");
        if (scenario === "proxy-refused") assert.equal(code, "ECONNREFUSED");
        if (scenario === "connect-refused") assert.match(error.message, /Proxy server refused connecting.*403/);
        if (scenario === "proxy-outage") assert.equal(code, "ECONNRESET");
        if (["connect-timeout", "connect-timeout-late-data", "connect-timeout-close", "connect-request-timeout"].includes(scenario)) assert.equal(code, "ETIMEDOUT");
        if (scenario === "connect-request-timeout") {
          z.object({ name: z.literal("TimeoutError"), event: z.literal("request") }).parse(error);
          assert.equal(error.message, "Timeout awaiting 'request' for 800ms");
        }
        if (["connect-timeout", "connect-timeout-late-data", "connect-timeout-close"].includes(scenario)) assert.equal(error.message, "Proxy connection timed out");
        if (scenario === "connect-repeated-response") assert.equal(code, "EPROTO");
        if (scenario === "origin-error") assert.equal(code, "ERR_NON_2XX_3XX_RESPONSE");
        if (["abort", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-pre-aborted-signal", "connect-abort-native-successor"].includes(scenario)) assert.equal(code, "ABORT_ERR");
        if (scenario === "checksum-mismatch") assert.match(error.message, /checksum|hash mismatch/i);
      }
      assert.equal(downloadedHash, undefined);
      assert.equal(fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).length : 0, 0, "Failed artifacts must not enter the cache");
      if (scenario === "connect-timeout-late-data" || scenario === "connect-timeout-close") await new Promise<void>((resolve) => deadline(resolve, 750));
    } else {
      await fetch();
      if (scenario === "runtime-proxy") { control.HTTP_PROXY = `http://127.0.0.1:${secondProxyPort}`; await fetch(); }
      if (scenario === "runtime-bypass") { control.NO_PROXY = "127.0.0.1"; await fetch(); }
    }
    await Promise.all(requestClosures);
    const bypass = ["direct", "https-direct", "no-proxy", "no-proxy-list", "no-proxy-wildcard", "explicit-agent-direct"].includes(scenario);
    assert.equal(counts.httpProxy, bypass || tlsScenario || scenario === "proxy-refused" ? 0 : 1);
    assert.equal(counts.secondProxy, scenario === "runtime-proxy" ? 1 : 0);
    assert.equal(counts.connect, tlsScenario && !["separate-https-proxy", "https-direct", "connect-pre-aborted-signal"].includes(scenario) ? 1 : 0);
    assert.equal(counts.secondConnect, scenario === "separate-https-proxy" ? 1 : 0);
    const noOrigin = ["untrusted-ca", "hostname-mismatch", "proxy-refused", "connect-refused", "proxy-outage", "connect-timeout",
      "connect-repeated-response", "connect-timeout-late-data", "connect-timeout-close", "connect-request-timeout", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-pre-aborted-signal", "connect-abort-native-successor"].includes(scenario);
    assert.equal(counts.origin, noOrigin ? 0 : scenario.startsWith("runtime-") ? 2 : 1);
    assert.equal(counts.abort, ["abort", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-pre-aborted-signal", "connect-abort-native-successor"].includes(scenario) ? 1 : 0);
    const proxiedTls = tlsScenario && !["https-direct", "connect-pre-aborted-signal"].includes(scenario);
    assert.equal(counts.connectionCallbacks, proxiedTls ? 1 : 0);
    assert.equal(counts.destroyRestorations, proxiedTls ? 1 : 0);
    const failedConnect = ["connect-refused", "connect-timeout", "connect-timeout-late-data", "connect-timeout-close", "connect-request-timeout", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-abort-native-successor"].includes(scenario);
    assert.equal(counts.socketTransfers, proxiedTls && !failedConnect ? 1 : 0);
    assert.equal(counts.lateProxyEvents, ["connect-repeated-response", "connect-timeout-late-data", "connect-timeout-close"].includes(scenario) ? 1 : 0);
    assert.equal(counts.requestCloses, scenario.startsWith("runtime-") ? 2 : 1);
    const nativeRequestError = negative && !["origin-error", "checksum-mismatch"].includes(scenario);
    assert.equal(counts.requestErrors, nativeRequestError ? 1 : 0);
    if (failedConnect || scenario === "connect-pre-aborted-signal") assert.equal(counts.requestSockets, 0);
    explicitAgent.destroy();
  } catch (error) { failure = error; }
  finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const socketClosures = [...sockets].map((socket) => new Promise<void>((resolve) => {
      if (socket.closed) { sockets.delete(socket); resolve(); return; }
      socket.once("close", resolve);
      socket.destroy();
    }));
    forwardingAgent.destroy();
    nativeHttpAgent.destroy();
    nativeHttpsAgent.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    await Promise.all(socketClosures);
    proxyPrototype.createConnection = nativeCreateConnection;
    agentPrototype.addRequest = nativeAddRequest;
    net.Socket.prototype.connect = nativeSocketConnect;
    http.request = nativeHttpRequest; http.get = nativeHttpGet; http.globalAgent = nativeHttpAgent;
    https.request = nativeHttpsRequest; https.get = nativeHttpsGet; https.globalAgent = nativeHttpsAgent;
    delete childGlobals.GLOBAL_AGENT;
    fs.rmSync(owned, { recursive: true, force: true });
  }
  const cleanup = { serversClosed: servers.every((server) => !server.listening), socketsClosed: sockets.size === 0, scratchRemoved: !fs.existsSync(owned), timersCleared: timers.size === 0, globalsRestored: http.request === nativeHttpRequest && https.request === nativeHttpsRequest && http.globalAgent === nativeHttpAgent && https.globalAgent === nativeHttpsAgent && proxyPrototype.createConnection === nativeCreateConnection && agentPrototype.addRequest === nativeAddRequest };
  console.log(JSON.stringify({ scenario, counts, expectedErrorCode, downloadedHash, cleanup, error: failure instanceof Error ? failure.stack : failure ? String(failure) : undefined }));
  assert.deepEqual(cleanup, { serversClosed: true, socketsClosed: true, scratchRemoved: true, timersCleared: true, globalsRestored: true });
  if (failure) throw failure;
}

const resultSchema = z.object({ scenario: z.string(), counts: z.object({ httpProxy: z.number(), secondProxy: z.number(), connect: z.number(), secondConnect: z.number(), origin: z.number(), abort: z.number(), connectionCallbacks: z.number(), socketTransfers: z.number(), destroyRestorations: z.number(), lateProxyEvents: z.number(), requestErrors: z.number(), requestCloses: z.number(), requestSockets: z.number(), connectionTimeoutMs: z.number() }), expectedErrorCode: z.string().optional(), downloadedHash: z.string().optional(), cleanup: z.object({ serversClosed: z.literal(true), socketsClosed: z.literal(true), scratchRemoved: z.literal(true), timersCleared: z.literal(true), globalsRestored: z.literal(true) }), error: z.string().optional() });
async function runChild(scenario: Scenario): Promise<z.infer<typeof resultSchema>> {
  const config: ChildConfig = { scenario, getPackage, scratch, caPath, certPath, wrongHostCertPath, keyPath };
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT,
    ELECTRON_GET_NO_PROGRESS: "1", TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  if (scenario === "https-proxy-node-ca") env.NODE_EXTRA_CA_CERTS = caPath;
  // Supply native modules in the CommonJS child, so Vitest's transformed
  // dynamic-import helper never becomes a dependency of the serialized body.
  const modules = `{assert: require('node:assert/strict'), http: require('node:http'), https: require('node:https'), net: require('node:net'), fs: require('node:fs'), path: require('node:path'), createRequire: require('node:module').createRequire, createHash: require('node:crypto').createHash, z: require('zod').z}`;
  const source = `(${consumerChild.toString()})(${JSON.stringify(config)}, ${modules}).catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ["--max-old-space-size=96", "--eval", source], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 32_768) { child.kill("SIGKILL"); reject(new Error("Child stdout exceeded fixture bound")); } });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 32_768) { child.kill("SIGKILL"); reject(new Error("Child stderr exceeded fixture bound")); } });
      child.once("close", resolve);
    });
    assert.equal(exit, 0, `${scenario} child failed:\n${stdout}\n${stderr}`);
    const result = resultSchema.parse(JSON.parse(stdout.trim()));
    assert.equal(result.scenario, scenario);
    assert.equal(result.error, undefined);
    return result;
  } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}

describe("resolved @electron/get proxy dependency removal", () => {
  it("binds the declared consumer to real 4.1.3 bytes and preserves the cache backport", () => {
    expect(JSON.parse(readFileSync(getPackage, "utf8"))).toMatchObject({ name: "@electron/get", version: "3.1.0", optionalDependencies: { "global-agent": "^3.0.0" } });
    expect(JSON.parse(readFileSync(proxyPackage, "utf8"))).toMatchObject({ name: "global-agent", version: "4.1.3", engines: { node: ">=10.0" } });
    expect(realpathSync(proxyPackage).startsWith(`${realpathSync(join(root, "node_modules"))}${sep}`)).toBe(true);
    expect(hash(readFileSync(proxyRequire.resolve("./dist/Logger.js")))).toBe("de37105fd1e3aafe1a6217af7c1d351c643700852aa2fdfa03a04ed3a9f5365c");
    expect(hash(readFileSync(proxyRequire.resolve("./dist/classes/Agent.js")))).toBe("09b27c7ee3ddfb381525ba506f87785705e1b0dab203a4fbe922e7c24cea4b5a");
    expect(hash(readFileSync(proxyRequire.resolve("./dist/classes/HttpsProxyAgent.js")))).toBe("9c255e561f2678cdd44dfe428e7c78ce303f096578a6337526d8ab7db848057b");
    expect(hash(readFileSync(proxyRequire.resolve("./dist/factories/createGlobalProxyAgent.js")))).toBe("29da8d647b16d2ddc64a50e957e78ca9d65f85441fae4348a94abe20b9a59f38");
    expect(hash(readFileSync(join(root, "patches/global-agent@4.1.3.patch")))).toBe("ecde30a17247ca36d6d1d5ec32006ac2b7c8bc4e2035ef2737d31e63cd88f465");
    expect(() => proxyRequire.resolve("roarr")).toThrow();
    expect(() => proxyRequire.resolve("sprintf-js")).toThrow();
    expect(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).not.toMatch(/^  (?:roarr|sprintf-js)@/m);
    expect(hash(readFileSync(cacheRequire.resolve("http-cache-semantics")))).toBe("aa800b3e30074032e630f3a9a8edbf7e4d3941fcf95c59ab2ad6dad9dd97d1e6");
    expect(hash(readFileSync(join(root, "patches/http-cache-semantics@4.3.0.patch")))).toBe("316855145f8fb13988b383a9b710f7c38930fa48ea1a14210564e6fcde27d814");
  });
  const scenarios: Scenario[] = ["http-proxy", "https-proxy", "https-direct", "https-proxy-node-ca", "direct", "no-proxy", "no-proxy-list", "no-proxy-wildcard",
    "runtime-proxy", "runtime-bypass", "separate-https-proxy", "explicit-agent-forced", "explicit-agent-direct",
    "untrusted-ca", "hostname-mismatch", "explicit-tls-opt-out", "proxy-refused", "connect-refused", "proxy-outage", "connect-timeout", "origin-error", "abort", "checksum-mismatch",
    "connect-delayed", "connect-repeated-response", "connect-timeout-late-data", "connect-timeout-close", "connect-request-timeout", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-pre-aborted-signal", "connect-abort-native-successor",
    "connect-default-timeout", "connect-explicit-timeout", "connect-zero-timeout"];
  it.each(scenarios)("preserves actual checked artifact behavior for %s and removes owned resources", async (scenario) => {
    const result = await runChild(scenario);
    console.info("MUSTER_PROXY_FIXTURE", JSON.stringify(result));
    if (["untrusted-ca", "hostname-mismatch", "proxy-refused", "connect-refused", "proxy-outage", "connect-timeout", "origin-error", "abort", "checksum-mismatch",
      "connect-repeated-response", "connect-timeout-late-data", "connect-timeout-close", "connect-request-timeout", "connect-abort-signal", "connect-abort-successor", "connect-abort-own-descriptor", "connect-pre-aborted-signal", "connect-abort-native-successor"].includes(scenario)) expect(result.expectedErrorCode).toBeDefined();
    else expect(result.downloadedHash).toBe(hash("Owned synthetic Electron download fixture.\n"));
  }, 15_000);
});
