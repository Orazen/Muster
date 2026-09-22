// Settings → Vault: "Manage devices" — the Restore Center's device list
// (DESIGN §29), a read-only view over the signed-in account's own session
// rows: name, platform, last seen, key-envelope status. No revoke control
// here yet — `muster sessions --revoke` remains the existing session-control
// surface, and S0 ships the view, not new powers over sessions.

import { useCallback, useEffect, useState } from "react";
import { Card } from "./SettingsPrimitives";

interface DeviceView {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: number;
  keyEnvelopeStatus: string;
}

function lastSeenLabel(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

export function ManageDevicesCard() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) throw new Error(`devices HTTP ${res.status}`);
      // SAFETY: /api/devices is our own server handler with a fixed JSON shape.
      const body = (await res.json()) as { devices: DeviceView[] };
      setDevices(body.devices);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Card
      title="Manage devices"
      subtitle="Every signed-in device on this account, newest first. Pairing a phone or running `muster pair` adds one; they clear as sessions expire."
    >
      {failed ? (
        <div className="text-[13px] text-ink-secondary">Devices are unavailable right now.</div>
      ) : !devices ? (
        <div className="text-[13px] text-ink-secondary">Loading devices…</div>
      ) : devices.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">No signed-in devices yet.</div>
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
            <span>Device</span>
            <span>Platform</span>
            <span className="text-right">Last seen</span>
            <span className="text-right">Device key</span>
          </div>
          {devices.map((device) => (
            <div
              key={device.id}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]"
            >
              <span className="truncate text-ink">{device.name}</span>
              <span className="text-ink-secondary">{device.platform}</span>
              <span className="text-right tabular-nums text-ink-secondary">{lastSeenLabel(device.lastSeenAt)}</span>
              <span
                className="text-right text-ink-secondary"
                title="A per-device key envelope arrives with per-device sync — none is issued yet."
              >
                {device.keyEnvelopeStatus === "none" ? "—" : device.keyEnvelopeStatus}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
