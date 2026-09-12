import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Plugin, ProxyOptions } from "vite";

export interface DevBackendEnvironment {
  OMB_PORT?: string;
  OGB_PORT?: string;
  MUSTER_DEV_SERVER_PID?: string;
}

export interface DevBackendOptions {
  timeoutMs?: number;
}

interface DevBackendPreview {
  plugin: Plugin;
  proxy: Record<string, ProxyOptions>;
}

type Backend = { port: number; expectedPid?: number };
type BackendChoice = { backend: Backend; error?: never } | { backend?: never; error: string };
type Next = () => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

const healthSchema = z.object({ app: z.literal("muster"), pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const numberText = z.string().regex(/^[0-9]+$/).transform(Number);
const portSchema = numberText.pipe(z.number().int().min(1).max(65535));
const pidSchema = numberText.pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const restartHint = "Set OMB_PORT (or OGB_PORT) to the intended Muster server port, then restart this preview.";

function chooseBackend(environment: DevBackendEnvironment): BackendChoice {
  const rawPort = environment.OMB_PORT?.trim() || environment.OGB_PORT?.trim();
  const port = portSchema.safeParse(rawPort);
  if (!port.success) return { error: "No valid explicit Muster backend port." };
  const rawPid = environment.MUSTER_DEV_SERVER_PID;
  if (rawPid !== undefined) {
    const pid = pidSchema.safeParse(rawPid.trim());
    if (!pid.success) return { error: "MUSTER_DEV_SERVER_PID must be a positive integer. Restart this preview with the intended server PID." };
    return { backend: { port: port.data, expectedPid: pid.data } };
  }
  return { backend: { port: port.data } };
}

/** A fresh, bounded identity read. Incoming cookies, authorization and request
 * bodies never enter this request; Node's HTTP client does not follow redirects. */
function readBackendPid(port: number, timeoutMs: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, pid?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (pid !== undefined) resolve(pid);
    };
    const probe = request({
      hostname: "127.0.0.1", port, path: "/api/health", method: "GET", agent: false,
      headers: { accept: "application/json", "cache-control": "no-store", pragma: "no-cache" },
    }, (response) => {
      if (response.statusCode !== 200) {
        finish(new Error("Muster backend identity check did not return HTTP 200."));
        response.destroy();
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16_384) {
          finish(new Error("Muster backend identity response was too large."));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on("error", () => finish(new Error("Muster backend identity response was interrupted.")));
      response.on("end", () => {
        if (settled) return;
        try {
          const health = healthSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!health.success) finish(new Error("The selected port is not a recognized Muster backend."));
          else finish(undefined, health.data.pid);
        } catch { finish(new Error("The selected port did not return a valid Muster identity.")); }
      });
    });
    const abort = () => {
      finish(new Error("Muster backend identity check was canceled."));
      probe.destroy();
    };
    const timer = setTimeout(() => {
      finish(new Error("Muster backend identity check timed out."));
      probe.destroy();
    }, timeoutMs);
    probe.on("error", () => finish(new Error("Muster backend is unavailable.")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else probe.end();
  });
}

/** The accepted process is pinned for this middleware instance. This prevents
 * accidental backend replacement; a health probe is not an atomic server lease. */
export function createDevBackendGuard(environment: DevBackendEnvironment, options: DevBackendOptions = {}): Middleware {
  const choice = chooseBackend(environment);
  let pinnedPid = choice.backend?.expectedPid;
  const timeoutMs = options.timeoutMs ?? 1_500;
  return (req, res, next) => {
    const path = req.url?.split("?", 1)[0] ?? "";
    if (path !== "/api" && !path.startsWith("/api/")) return next();
    const unavailable = (reason: string) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      res.end(JSON.stringify({ error: `${reason} No API request was forwarded. ${restartHint}` }));
    };
    if (!choice.backend) return unavailable(choice.error);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    void readBackendPid(choice.backend.port, timeoutMs, controller.signal).then((pid) => {
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      if (pinnedPid !== undefined && pid !== pinnedPid) {
        unavailable("The Muster backend process changed or does not match MUSTER_DEV_SERVER_PID.");
        return;
      }
      pinnedPid = pid;
      next();
    }).catch((error) => unavailable(error instanceof Error ? error.message : "Muster backend identity check failed.")).finally(() => {
      req.removeListener("aborted", cancel);
      res.removeListener("close", cancel);
    });
  };
}

export function devBackendPreview(environment: DevBackendEnvironment): DevBackendPreview {
  const choice = chooseBackend(environment);
  const proxy: Record<string, ProxyOptions> = {};
  if (choice.backend) proxy["^/api(?:/|\\?|$)"] = { target: `http://127.0.0.1:${choice.backend.port}` };
  return {
    proxy,
    plugin: {
      name: "muster-dev-backend-guard",
      configureServer(server) { server.middlewares.use(createDevBackendGuard(environment)); },
      configurePreviewServer(server) { server.middlewares.use(createDevBackendGuard(environment)); },
    },
  };
}
