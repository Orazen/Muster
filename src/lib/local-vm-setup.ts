/** Checked Local VM requests and the shared, bounded setup sequence. */
import { z } from "zod";

export type LocalVmAction = "pull" | "run" | "start" | "stop" | "remove" | "recreate" | "runtimeStart" | "runtimeInstall";
export type LocalVmSetupStage = "checking" | "installing" | "startingRuntime" | "preparingImage" | "creatingVm" | "startingVm";
export const LOCAL_VM_STAGE_LABELS = {
  checking: "Checking Local VM…",
  installing: "Installing Podman…",
  startingRuntime: "Starting runtime…",
  preparingImage: "Preparing Cua desktop…",
  creatingVm: "Creating Local VM…",
  startingVm: "Starting Local VM…",
} satisfies Record<LocalVmSetupStage, string>;

export interface LocalVmStatus {
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_starting: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  mode?: "shared" | "perBot";
  max_instances?: number;
  /** One-click install offer, computed per status read. Absent on older
   * servers — the optional chain in the UI keeps that rendering. */
  runtime_install?: { installable: boolean; reason?: string; manager?: string | null };
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}


const statusSchema = z.object({
  platform: z.string(), runtime: z.string().nullable(), available: z.array(z.string()),
  daemonUp: z.boolean(), image: z.boolean(), imageMatches: z.boolean(), managed: z.boolean(),
  container: z.enum(["running", "stopped", "missing"]),
  network: z.enum(["loopback", "unsafe", "unknown"]),
  security: z.enum(["hardened", "unsafe", "unknown"]),
  persistence: z.enum(["durable", "unsafe", "unknown"]),
  desktopReady: z.boolean(), desktop_starting: z.boolean(), ready: z.boolean(), problem: z.string().nullable(),
  image_ref: z.string(), base_image_ref: z.string(), driver_version: z.string(), container_name: z.string(),
  workspace_path: z.string(), workspace_guest_path: z.string(), viewer_url: z.string(), idle_timeout_ms: z.number(),
  mode: z.enum(["shared", "perBot"]).optional(), max_instances: z.number().optional(),
  runtime_install: z.object({ installable: z.boolean(), reason: z.string().optional(), manager: z.string().nullable().optional() }).optional(),
  commands: z.object({
    install: z.string().nullable(), runtimeStart: z.string().nullable(), pull: z.string().nullable(),
    run: z.string().nullable(), start: z.string().nullable(), stop: z.string().nullable(),
    remove: z.string().nullable(), view: z.string(),
  }),
});

export async function requestLocalVmStatus(action?: Exclude<LocalVmAction, "recreate">, signal?: AbortSignal): Promise<LocalVmStatus> {
  const response = await fetch(action ? `/api/local-computer/${action}` : "/api/local-computer", action ? {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal,
  } : { signal });
  const body: unknown = await response.json().catch(() => null);
  // Aborting a poll during body parsing must not turn it into a visible
  // malformed-status failure or let that old poll overwrite an action.
  signal?.throwIfAborted();
  if (!response.ok) {
    const failure = z.object({ error: z.string() }).safeParse(body);
    throw new Error(failure.success ? failure.data.error : `Local VM request failed (${response.status})`);
  }
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) throw new Error("The Local VM status response was incomplete. Re-check and try again.");
  return parsed.data;
}

export function localVmNeedsRecreate(status: LocalVmStatus): boolean {
  return status.container !== "missing" && (!status.imageMatches || !status.managed ||
    status.network === "unsafe" || status.security === "unsafe" || status.persistence === "unsafe");
}

export function localVmSetupReady(status: LocalVmStatus): boolean {
  return status.mode === "perBot" ? Boolean(status.runtime && status.daemonUp && status.image) : status.ready;
}

export function localVmInstallManager(status: LocalVmStatus): string {
  return status.runtime_install?.manager?.toLowerCase() === "winget" || (!status.runtime_install?.manager && status.platform === "win32")
    ? "WinGet" : "Homebrew";
}

interface SetupOperations {
  read: () => Promise<LocalVmStatus>;
  post: (action: Exclude<LocalVmAction, "recreate">) => Promise<void>;
  onStage: (stage: LocalVmSetupStage) => void;
}

/** Re-read before every next decision. A retry only performs missing steps;
 * replacement always stays a separate, explicitly confirmed user action. */
export async function runLocalVmSetup({ read, post, onStage }: SetupOperations): Promise<LocalVmStatus> {
  onStage("checking");
  let current = await read();
  const step = async (stage: LocalVmSetupStage, action: Exclude<LocalVmAction, "recreate">) => {
    onStage(stage);
    await post(action);
    current = await read();
  };
  if (!current.runtime) {
    if (!current.runtime_install?.installable) {
      throw new Error(current.runtime_install?.reason ?? "Install a container runtime first, then re-check.");
    }
    await step("installing", "runtimeInstall");
    if (!current.runtime) throw new Error("Podman was not detected after installation. Re-check before continuing.");
  }
  if (!current.daemonUp) {
    if (current.runtime === "docker" && current.platform === "linux") {
      throw new Error("Starting Docker on Linux needs sudo — run the command shown in Local VM settings, then continue.");
    }
    await step("startingRuntime", "runtimeStart");
    if (!current.daemonUp) throw new Error(current.problem ?? "The container runtime is still starting. Re-check and try again.");
  }
  if (!current.image) {
    await step("preparingImage", "pull");
    if (!current.image) throw new Error(current.problem ?? "The Cua desktop image is not ready. Try setup again.");
  }
  if (current.mode === "perBot") return current;
  if (localVmNeedsRecreate(current)) {
    throw new Error(current.problem ?? "The existing VM needs replacement. Review it in Local VM settings before replacing it.");
  }
  if (current.container === "missing") await step("creatingVm", "run");
  else if (current.container === "stopped") await step("startingVm", "start");
  return current;
}
