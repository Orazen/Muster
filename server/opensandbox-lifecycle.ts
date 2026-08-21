// OpenSandbox computer lifecycle — find-or-create a persistent, per-bot
// sandbox and install/start the same cua-driver desktop-automation daemon
// server/box.ts's provisionBox() installs on a Box VM, using the identical
// backend-agnostic bootstrap scripts from server/remote-computer.ts.
//
// Mirrors box.ts's shape deliberately (findBox/provisionBox -> findSandbox/
// provisionSandbox) so this reads as "the same idea, a different backend,"
// not a new pattern to learn. Two things box.ts has that this does not,
// on purpose, not by oversight:
//   - No desktop-URL minting (Box's VNC/WebRTC viewer is Box-specific
//     infrastructure; OpenSandbox's viewer story hasn't been built or
//     proven — see docs/plans/opensandbox-integration-and-pricing-decision.md).
//   - No archive/resume: OpenSandbox's SDK exposes .pause()/.resume(), but
//     wiring that into the "sleep" UX box.ts has needs its own testing
//     pass, not bundled into this one.
import { Sandbox, SandboxManager } from "@alibaba-group/opensandbox";
import type { AppConfig } from "./config.ts";
import { configured, connectionConfig, createSandbox, runCommand as runOnSandbox } from "./opensandbox.ts";
import { ensureRemoteCuaCommand, remoteComputerBootstrapCommand } from "./remote-computer.ts";

export { configured as opensandboxConfigured };

// Same image Local VM already pins and trusts (server/container-computer.ts).
// Referenced by digest, not "docker.io/"-prefixed: OpenSandbox's own image
// inspection does an exact string match against how the image is actually
// cached, which does not include that prefix — found via live testing.
const DESKTOP_IMAGE = "trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";

const BOT_ID_KEY = "muster_bot_id";
const RUNNING_STATES = ["Running", "Paused"];

/** Find this bot's existing sandbox, if any, tagged at creation time via
 * metadata (OpenSandbox's equivalent of box.ts's deterministic-name
 * lookup — there is no name-based find here, sandboxes are metadata-
 * tagged instead). */
export async function findSandbox(cfg: AppConfig, botId: string): Promise<Sandbox | null> {
  if (!configured(cfg)) return null;
  const cc = connectionConfig(cfg);
  const manager = SandboxManager.create({ connectionConfig: cc });
  const list = await manager.listSandboxInfos({
    states: RUNNING_STATES,
    metadata: { [BOT_ID_KEY]: botId },
  });
  const info = list.items?.[0];
  if (!info) return null;
  return Sandbox.connect({ connectionConfig: cc, sandboxId: info.id });
}

/**
 * Find-or-create the bot's persistent OpenSandbox sandbox, run the same
 * idempotent bootstrap box.ts runs on a Box VM, and confirm cua-driver is
 * actually up before returning. Live-verified this session: creation,
 * bootstrap, and daemon start all succeed end-to-end on a correctly
 * configured OpenSandbox deployment (network_mode matching the server's
 * own Docker network, drop_capabilities without SYS_PTRACE/SYS_ADMIN).
 */
/** trycua/xfce-cua ships its whole desktop (dbus, a VNC X server, noVNC)
 * behind /etc/supervisor/supervisord.conf — but OpenSandbox's own
 * container entrypoint is "tail -f /dev/null", which never runs it. Live-
 * tested finding this session: without this, there is no X11 socket at
 * all, so both cua-driver (its X11 overlay fails to connect) and the
 * plain-X11 screenshot fallback silently produce zero bytes. This is an
 * OpenSandbox-specific step, deliberately NOT folded into
 * server/remote-computer.ts's shared bootstrap scripts — Box's VMs boot
 * their desktop through Box's own infrastructure and must not be touched
 * by this. Idempotent: a no-op once supervisord is already running. */
const SUPERVISORD_PGREP = "supervisord -c /etc/supervisor/supervisord.conf";

// Two things live testing found the hard way:
//   1. the nohup'd process needs to actually finish detaching before
//      this command's own exec session closes — closing that session
//      immediately after backgrounding it tears the child down too, so
//      the trailing sleep has to run in the SAME statement as the "&".
//   2. folding a leading "pgrep || "/"pgrep && exit 0" idempotency guard
//      into the same one-liner (with or without a "{ ... }" group)
//      silently no-ops the whole thing or hangs it — confirmed by A/B
//      testing the exact same start command with and without a guard
//      prefix against the live deployment; only the bare start command on
//      its own ever actually launched the process. So idempotency is a
//      separate exec call first, not a shell-level guard clause.
function startDesktopServicesCommand(): string {
  return "sudo nohup /usr/bin/supervisord -c /etc/supervisor/supervisord.conf > /tmp/ogb-supervisord.log 2>&1 & disown; sleep 5";
}

export async function provisionSandbox(cfg: AppConfig, botId: string, botName: string) {
  if (!configured(cfg)) {
    throw new Error('OpenSandbox not enabled — add {"opensandbox":{"url":"…","apiKey":"…"}} to ~/.muster/config.json');
  }
  let sandbox = await findSandbox(cfg, botId);
  let created = false;
  try {
    if (!sandbox) {
      const handle = await createSandbox(cfg, { image: DESKTOP_IMAGE });
      sandbox = handle.sandbox;
      created = true;
      // createSandbox() doesn't take metadata (kept minimal for the
      // generic case); tag it now so findSandbox() can locate it later.
      await sandbox.patchMetadata({ [BOT_ID_KEY]: botId }).catch(() => null);
    }

    // Live-tested finding: this deployment's default sandbox TTL is short
    // (single-digit minutes of inactivity) — long enough for the create+
    // bootstrap round trip, not for an actual agent task after that. Renew
    // on every provision call (both fresh and reused), not just at create
    // time, so an idle-then-resumed bot's sandbox is still there.
    await sandbox.renew(3600).catch(() => null);

    // Desktop services first — cua-driver's install (kicked off by the
    // bootstrap below) tries to connect to X11 immediately, so this has
    // to be up before that, not after. The command's own trailing sleep
    // already covers supervisord's startsecs, so no extra wait here.
    const desktopUp = await runOnSandbox(sandbox, `pgrep -f '${SUPERVISORD_PGREP}'`, { timeoutMs: 10_000 }).catch(() => null);
    if (!desktopUp?.ok) {
      await runOnSandbox(sandbox, startDesktopServicesCommand(), { timeoutMs: 20_000 }).catch(() => null);
    }

    const bootstrap = remoteComputerBootstrapCommand(botName);
    let boot;
    // Retry on ANY failure, not just "no response" — a freshly created
    // sandbox's sudo/filesystem/capability setup can genuinely race with
    // the very first command run against it (live-observed this session:
    // "sudo: unable to send audit message" preceded a real nonzero exit on
    // a cold sandbox, then succeeded immediately on a warm one).
    for (let attempt = 0; attempt < 5; attempt++) {
      boot = await runOnSandbox(sandbox, bootstrap, { timeoutMs: 120_000 });
      if (boot.ok) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!boot?.ok) {
      const detail = boot?.stderr?.slice(0, 200) || (boot?.exitCode != null ? `exit ${boot.exitCode}` : "no response");
      throw new Error(`OpenSandbox setup failed: ${detail}`);
    }

    // The install runs async in the background even after "bootstrapped"
    // is printed — poll briefly for the daemon rather than assuming it's
    // instantly ready (same race this session's live testing found).
    let ready = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await runOnSandbox(sandbox, ensureRemoteCuaCommand(), { timeoutMs: 15_000 }).catch(() => null);
      const status = await runOnSandbox(sandbox, "test -S /opt/ogb/run/cua.sock", { timeoutMs: 5_000 });
      if (status.ok) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (!ready) throw new Error("cua-driver did not come up within 60s — retry in a minute");

    return { sandboxId: sandbox.id, reused: !created };
  } catch (error) {
    if (!created || !sandbox) throw error;
    await sandbox.kill().catch(() => null);
    throw error;
  }
}

/** Reattach the driver daemon on an existing sandbox (mirrors joinBox's
 * "processes don't survive archive/resume" reattachment, minus the
 * desktop-URL minting box.ts also does — see the file header). */
export async function reattachSandbox(cfg: AppConfig, botId: string) {
  const sandbox = await findSandbox(cfg, botId);
  if (!sandbox) throw new Error("no computer yet — provision it first");
  await runOnSandbox(sandbox, ensureRemoteCuaCommand(), { timeoutMs: 15_000 }).catch(() => null);
  return { sandboxId: sandbox.id };
}
