// App Settings → Remote access. The same companion sidecar the Companion
// section controls, presented the way OpenMausBot presents it: a phone or
// another computer connects to THIS machine, over Secure HTTPS, Tailscale, or
// direct Wi-Fi, and the panel says which of those is actually available.
//
// The Companion section stays the terse toggle; this is the fuller surface for
// when someone is actually pairing a device and needs the connection details,
// the access scope, and a way out of a companion that will not start.
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Globe, Loader2, Monitor, Smartphone, TriangleAlert } from "lucide-react";
import { companionPairingLink } from "../lib/companion-pairing";
import {
  forgetRemoteConnection,
  loadRemoteConnections,
  normalizeRemoteServerInput,
  rememberRemoteConnection,
  type RemoteServerTarget,
} from "../lib/remote-client";
import { Card } from "./SettingsPrimitives";

/** What a paired device may originate. Mirrors the sidecar's DeviceAccess. */
type DeviceAccess = "full" | "approvals";

interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  access: DeviceAccess;
  cloudDesktopAccess: boolean;
}

interface CompanionState {
  enabled: boolean;
  keepAwake?: boolean;
  port: number;
  devices: Device[];
  pairing: { code: string; token: string; expiresAt: number; access: DeviceAccess } | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  lan?: string | null;
  discovery?: { advertising: boolean; name: string };
  error?: string;
  foreign?: { pid: number; dir: string };
}

type Bridge = {
  state: () => Promise<CompanionState>;
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  stopForeign: () => Promise<CompanionState>;
  setKeepAwake: (enabled: boolean) => Promise<CompanionState>;
  pairing: (open: boolean, access?: DeviceAccess) => Promise<CompanionState>;
  setAccess: (deviceId: string, access: DeviceAccess) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
};

/** Opening a window on another computer's Muster is desktop-only: the main
 * process owns windows, and in a browser tab the app IS the window. */
const openRemoteClientWindow = (): ((url: string) => Promise<boolean>) | null =>
  // SAFETY: the preload owns `ogb.openRemoteClient`; every call is still guarded for browser builds where it is absent.
  (globalThis as { ogb?: { openRemoteClient?: (url: string) => Promise<boolean> } }).ogb?.openRemoteClient ?? null;

const bridge = (): Bridge | null =>
  // SAFETY: the preload owns `ogb.companion`; every call is still guarded for browser builds where it is absent.
  (globalThis as { ogb?: { companion?: Bridge } }).ogb?.companion ?? null;

/** The access scope a code grants. Full is the default — a phone the user
 * explicitly pairs is normally meant to drive the machine; approvals-only is
 * the cautious choice for a device that should not start new work. */
type AccessScope = DeviceAccess;

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-accent" : "bg-raised"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

function ChoiceRow({
  active,
  title,
  detail,
  onSelect,
}: {
  active: boolean;
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active ? "border-accent/50 bg-accent/10" : "border-hairline/40 hover:bg-raised/50"
      }`}
    >
      <span
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
          active ? "border-accent" : "border-hairline"
        }`}
      >
        {active && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] text-ink">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-secondary">{detail}</span>
      </span>
    </button>
  );
}

export function RemoteAccessSection() {
  const [state, setState] = useState<CompanionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<AccessScope>("full");
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [remoteInput, setRemoteInput] = useState("");
  const [remoteTarget, setRemoteTarget] = useState<RemoteServerTarget | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteConnections, setRemoteConnections] = useState<string[]>([]);

  const connectRemote = async (target: RemoteServerTarget) => {
    const open = openRemoteClientWindow();
    if (!open) return;
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      await open(target.url);
      setRemoteConnections(rememberRemoteConnection(window.localStorage, target.url));
      setRemoteInput("");
      setRemoteTarget(null);
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusy(false);
    }
  };

  const load = useCallback(async () => {
    const companion = bridge();
    if (!companion) return;
    try {
      setState(await companion.state());
    } catch {
      /* the main process is gone; the rest of the app already says so */
    }
  }, []);

  const act = async (call: (companion: Bridge) => Promise<CompanionState>) => {
    const companion = bridge();
    if (!companion) return;
    setBusy(true);
    setError(null);
    try {
      setState(await call(companion));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // Recent remote connections live in the desktop profile's localStorage;
    // read after mount so the component renders safely outside a browser too.
    setRemoteConnections(loadRemoteConnections(window.localStorage));
  }, [load]);

  const pairing = Boolean(state?.pairing);
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        setNow(Date.now());
        void load();
      },
      pairing ? 1_000 : 10_000,
    );
    return () => window.clearInterval(timer);
  }, [pairing, load]);

  if (!bridge()) {
    return (
      <Card
        title="Remote access"
        subtitle="Remote access runs through the companion process, which only the desktop app can start. Open Muster on this computer to turn it on."
      >
        <div />
      </Card>
    );
  }

  if (!state) {
    return (
      <Card title="Remote access" subtitle="Loading…">
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const tailnet = state.tailnetName;
  const address = tailnet ?? state.lan ?? state.addresses?.find((c) => c !== state.tailscale);
  const secondsLeft = state.pairing ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000)) : 0;
  const pairingLink =
    state.enabled && !state.error && !error && state.pairing && state.pairing.expiresAt > now && address
      ? companionPairingLink({
          address,
          port: state.port,
          code: state.pairing.code,
          token: state.pairing.token,
          name: state.discovery?.name,
        })
      : null;

  const beginPairing = () =>
    void act(async (companion) => {
      const started = state.enabled ? state : await companion.start();
      if (!started.enabled || started.error) return started;
      // The scope is fixed when the code is minted, not chosen by the phone
      // at redeem — see companion/src/devices.ts openPairing.
      return companion.pairing(true, scope);
    });

  const copyLink = async () => {
    if (!pairingLink) return;
    try {
      await navigator.clipboard.writeText(pairingLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Remote access"
        subtitle="Use Muster from another device. Check chats, answer approvals, and send new work from a phone or another computer."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[14px] text-ink">{state.enabled ? "On" : "Off"}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!state.enabled
                ? "Nothing on this computer is reachable from the network."
                : !address
                  ? `Listening on port ${state.port} — no network address yet.`
                  : tailnet
                    ? `Enter ${tailnet}:${state.port} on your phone — that works from anywhere on your tailnet.`
                    : `Listening on ${address}:${state.port}.`}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={state.enabled}
            aria-label="Remote access"
            disabled={busy}
            onClick={() => void act((c) => (state.enabled ? c.stop() : c.start()))}
            className={cnSwitch(state.enabled)}
          >
            <span className={cnKnob(state.enabled)} />
          </button>
        </div>

        {(error || state.error) && (
          <div className="mt-3 text-[13px] text-danger">
            <span className="flex items-start gap-1.5">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span>{error ?? state.error}</span>
            </span>
            {/* The dead-end rule: an error card must offer one action that
                works from inside the client. */}
            {state.foreign && (
              <button
                onClick={() => void act((c) => c.stopForeign())}
                disabled={busy}
                className="mt-2 block rounded-full border border-danger/40 px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
              >
                Stop the other companion and retry
              </button>
            )}
            {!state.foreign && !state.enabled && (
              <button
                onClick={() => void act((c) => c.start())}
                disabled={busy}
                className="mt-2 block rounded-full border border-danger/40 px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
              >
                Turn on remote access and check again
              </button>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Pair a phone or another computer"
        subtitle="Create a one-time code, then scan it with the Muster app or open the link in a browser. Codes work once and expire after five minutes."
      >
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Access scope">
          <ChoiceRow
            active={scope === "full"}
            onSelect={() => setScope("full")}
            title="Full access"
            detail="Read and reply to chats, answer approvals, and start new work."
          />
          <ChoiceRow
            active={scope === "approvals"}
            onSelect={() => setScope("approvals")}
            title="Chat and approvals only"
            detail="Read conversations and answer approvals, but cannot start new work."
          />
        </div>

        <div className="mt-4">
          {state.pairing ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Pairing code</div>
                <div className="mt-1 font-mono text-[28px] tracking-[0.3em] text-ink">{state.pairing.code}</div>
                <div className="mt-1 text-[13px] text-ink-secondary">
                  Expires in {secondsLeft}s{address ? ` · ${address}:${state.port}` : ""}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-secondary">
                  {state.pairing.access === "approvals"
                    ? "This code grants chats and approvals only."
                    : "This code grants full access."}
                </div>
                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <button
                    type="button"
                    disabled={busy || !pairingLink}
                    onClick={() => void copyLink()}
                    className="inline-flex items-center gap-2 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy pairing link"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void act((c) => c.pairing(false))}
                    className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              disabled={busy}
              onClick={beginPairing}
              className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Preparing…" : "Create pairing code"}
            </button>
          )}
        </div>

        <div className="mt-4 border-t border-hairline/30 pt-3">
          <div className="text-[13px] text-ink">Paired devices</div>
          <div className="mt-0.5 text-[12px] text-ink-secondary">
            {state.devices.length
              ? "Removing a device signs it out immediately. The desktop switch grants it full interactive control of a bot's cloud computer."
              : "No devices paired yet."}
          </div>
          {state.devices.length > 0 && (
            <ul className="mt-2 flex flex-col gap-2">
              {state.devices.map((device) => (
                <li key={device.id} className="flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
                  {/mac|computer|desktop/i.test(device.name) ? (
                    <Monitor size={15} className="shrink-0 text-ink-secondary" />
                  ) : (
                    <Smartphone size={15} className="shrink-0 text-ink-secondary" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-ink">{device.name}</div>
                    <div className="text-[11.5px] text-ink-secondary">
                      {device.access === "approvals" ? "Chats and approvals only" : "Full access"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[12px] text-ink-secondary">Desktop</span>
                    <button
                      role="switch"
                      aria-checked={device.cloudDesktopAccess}
                      aria-label={`Cloud desktop access for ${device.name}`}
                      disabled={busy}
                      onClick={() => void act((c) => c.cloudDesktop(device.id, !device.cloudDesktopAccess))}
                      className={cnSwitch(device.cloudDesktopAccess)}
                    >
                      <span className={cnKnob(device.cloudDesktopAccess)} />
                    </button>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act((c) =>
                        c.setAccess(device.id, device.access === "approvals" ? "full" : "approvals"),
                      )
                    }
                    className="shrink-0 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
                  >
                    {device.access === "approvals" ? "Give full access" : "Limit access"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void act((c) => c.revoke(device.id))}
                    className="shrink-0 text-[12px] text-ink-secondary hover:text-danger disabled:opacity-40"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card
        title="Secure HTTPS pairing"
        subtitle="Recommended — the simplest setup, and it keeps working when the paired device leaves this Wi-Fi."
      >
        <div className="text-[13px] text-ink-secondary">
          {state.enabled
            ? "Open a pairing code above; the link it produces already points at this computer's secure address."
            : "Turn on remote access to enable secure pairing."}
        </div>
      </Card>

      <Card
        title="Tailscale pairing"
        subtitle="Optional — for people who already use Tailscale. Secure HTTPS above remains the recommended setup."
      >
        <div className="text-[13px] text-ink-secondary">
          {state.tailscale
            ? tailnet
              ? `This computer is on a tailnet as ${tailnet}.`
              : "This computer is on a tailnet, but its MagicDNS name could not be read — iPhones can't dial a bare tailnet address."
            : "Not on a tailnet. Install Tailscale on both devices to reach this computer from anywhere."}
        </div>
      </Card>

      <Card
        title="Direct Wi-Fi pairing"
        subtitle="Use this only when both devices are nearby and the network allows devices to see each other."
      >
        <button
          disabled={busy || !state.enabled}
          onClick={beginPairing}
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
        >
          Pair on this Wi-Fi
        </button>
      </Card>

      <Card
        title="Connect to another computer"
        subtitle="Use THIS desktop as a client for a Muster running elsewhere — another Mac, a VPS, or a tunnel. Your local workspace keeps running underneath."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const target = normalizeRemoteServerInput(remoteInput);
            if (!target) {
              setRemoteError("That doesn't look like a Muster server address or pairing link.");
              setRemoteTarget(null);
              return;
            }
            setRemoteError(null);
            setRemoteTarget(target);
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={remoteInput}
              onChange={(e) => setRemoteInput(e.target.value)}
              placeholder="https://muster.example.com  ·  192.168.1.20:8799  ·  /claim#CODE link"
              aria-label="Remote Muster server address or pairing link"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-secondary/60 focus:border-accent/50 focus:outline-none"
            />
            <button
              type="submit"
              disabled={remoteBusy || !remoteInput.trim()}
              className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {remoteBusy ? "Opening…" : "Open window"}
            </button>
          </div>
        </form>
        {remoteError && (
          <div role="alert" className="mt-2 text-[13px] text-danger">{remoteError}</div>
        )}
        {remoteTarget && (
          <div className="mt-3 rounded-lg border border-hairline/40 bg-raised/40 px-3 py-2.5">
            <div className="text-[13px] text-ink">
              Open <span className="font-mono text-[12.5px]">{remoteTarget.displayHost}</span> in a client window?
            </div>
            {remoteTarget.carriedCode && (
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                The pairing link carries code <span className="font-mono">{remoteTarget.carriedCode}</span> — it
                redeems on that server and signs this window in as the owner.
              </div>
            )}
            <div className="mt-2 text-[12px] text-ink-secondary">
              The window gets its own session — separate cookies, no access to this computer's workspace,
              companion, or credentials. The other computer keeps its own files; nothing is copied here.
            </div>
            <div className="mt-2 flex gap-2">
              <button
                disabled={remoteBusy}
                onClick={() => void connectRemote(remoteTarget)}
                className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                Connect
              </button>
              <button
                onClick={() => setRemoteTarget(null)}
                className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {remoteConnections.length > 0 && (
          <div className="mt-4 border-t border-hairline/30 pt-3">
            <div className="text-[13px] text-ink">Recent connections</div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {remoteConnections.map((url) => {
                const target = normalizeRemoteServerInput(url);
                if (!target) return null;
                return (
                  <li key={url} className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
                    <Globe size={14} className="shrink-0 text-ink-secondary" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{target.displayHost}</span>
                    <button
                      disabled={remoteBusy}
                      onClick={() => void connectRemote(target)}
                      className="shrink-0 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
                    >
                      Open
                    </button>
                    <button
                      disabled={remoteBusy}
                      onClick={() => setRemoteConnections(forgetRemoteConnection(window.localStorage, url))}
                      className="shrink-0 text-[12px] text-ink-secondary hover:text-danger disabled:opacity-40"
                    >
                      Forget
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>

      <Card
        title="Connect your domain"
        subtitle="Optional — put a name you own in front of remote access, the way OpenMausBot's custom-domain setup does."
      >
        <ol className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-ink-secondary">
          <li className="flex gap-2.5">
            <span className="font-medium text-ink">1.</span>
            <span>
              In your DNS provider, create a <span className="text-ink">CNAME</span> record — for example
              <span className="font-mono text-[12.5px] text-ink"> muster.yourdomain.com</span> — pointing at the
              hostname of the machine running Muster (its Tailscale name, or the host you already reach it at).
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="font-medium text-ink">2.</span>
            <span>
              For a machine behind NAT, run a Cloudflare Tunnel from that machine:
              <span className="mt-1 block font-mono text-[12px] text-ink">cloudflared tunnel --url http://localhost:8799</span>
              then point the CNAME at the tunnel's
              <span className="font-mono text-[12.5px] text-ink"> &lt;id&gt;.cfargotunnel.com</span> hostname instead.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="font-medium text-ink">3.</span>
            <span>
              Pair through the domain: open this page's pairing link, or paste
              <span className="font-mono text-[12.5px] text-ink"> https://muster.yourdomain.com/claim#CODE</span> into
              the Connect card above. Certificates are managed by Cloudflare for tunnels, or by your reverse proxy
              for a direct CNAME.
            </span>
          </li>
        </ol>
        <div className="mt-3 text-[12px] text-ink-secondary">
          Only the pairing address changes — the paired device still talks to the same server, and this computer's
          companion port stays loopback-plus-LAN as before.
        </div>
      </Card>

      <Card title="Advanced & troubleshooting">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">Keep this computer awake</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              Keeps remote access and scheduled work available while the screen is off.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={Boolean(state.keepAwake)}
            aria-label="Keep this computer awake"
            disabled={busy}
            onClick={() => void act((c) => c.setKeepAwake(!state.keepAwake))}
            className={cnSwitch(Boolean(state.keepAwake))}
          >
            <span className={cnKnob(Boolean(state.keepAwake))} />
          </button>
        </div>

        <div className="mt-4 border-t border-hairline/30 pt-3">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="text-[13px] text-ink-secondary hover:text-ink"
          >
            {showDetails ? "Hide" : "Reveal"} connection details
          </button>
          {showDetails && (
            <div className="mt-2 font-mono text-[12px] leading-relaxed text-ink-secondary">
              {address ? (
                <>
                  <div>address {address}</div>
                  <div>port {state.port}</div>
                </>
              ) : (
                <div>No reachable address is available yet.</div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}