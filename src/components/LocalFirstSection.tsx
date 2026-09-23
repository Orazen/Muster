// App settings → Local-first: a small, read-only view of the desktop's
// local data default and the two server contracts that describe optional
// Drive transport and the storage gate. It deliberately shows no path or
// credential value; the status endpoints are the only source of truth here.
import { useEffect, useState } from "react";

import { Card, SettingRow } from "./SettingsPrimitives";
import {
  readLocalFirstStatus,
  type LocalFirstStatus,
} from "@/lib/local-first-status";

export type LocalFirstViewState =
  | { kind: "loading" }
  | { kind: "ready"; value: LocalFirstStatus }
  | { kind: "error" };

type WorkspaceCapability = LocalFirstStatus["capability"];

function driveDescription(capability: WorkspaceCapability): string {
  if (!capability.workspaceBackupAvailable) {
    return "This deployment does not offer Drive backup or sync from here.";
  }
  if (capability.installationDrive.operationsAvailable) {
    return "Google Drive is configured for this installation. It is optional; local use does not require it.";
  }
  if (capability.accountDrive.connected) {
    return "This account has a Drive connection. It is optional; local use does not require it.";
  }
  if (capability.accountDrive.available) {
    return "Drive is available for this account but is not connected yet. It is optional; local use does not require it.";
  }
  return "Google Drive credentials are not configured on this computer. Local use continues without Drive.";
}

function driveLabel(capability: WorkspaceCapability): string {
  if (!capability.workspaceBackupAvailable) return "Unavailable";
  if (capability.installationDrive.operationsAvailable) return "Configured";
  if (capability.accountDrive.connected) return "Connected";
  if (capability.accountDrive.available) return "Available";
  return "Not configured";
}

function driveTone(capability: WorkspaceCapability): string {
  if (!capability.workspaceBackupAvailable) return "text-danger";
  if (capability.installationDrive.operationsAvailable || capability.accountDrive.connected) return "text-success";
  return "text-ink-secondary";
}

function gateDescription(gate: LocalFirstStatus["storageGate"]): string {
  if (!gate.required) return "This installation is not gated by a server storage connection.";
  if (gate.satisfied) return "The server reports this workspace's storage requirement as satisfied.";
  return "This workspace needs a Drive or Telegram storage connection before hosted work can proceed.";
}

function gateLabel(gate: LocalFirstStatus["storageGate"]): string {
  if (!gate.required) return "Not required";
  return gate.satisfied ? "Satisfied" : "Needs connection";
}

function gateTone(gate: LocalFirstStatus["storageGate"]): string {
  return gate.satisfied || !gate.required ? "text-success" : "text-danger";
}

/** Pure view kept separate so the read-only contract is easy to inspect. */
export function LocalFirstView({ state }: { state: LocalFirstViewState }) {
  const loading = state.kind === "loading";
  const error = state.kind === "error";
  const capability = state.kind === "ready" ? state.value.capability : null;
  const gate = state.kind === "ready" ? state.value.storageGate : null;

  const driveText = loading
    ? "Checking Drive connection and sync readiness…"
    : error
      ? "Drive status could not be confirmed. Muster is not treating Drive as connected."
      : capability
        ? driveDescription(capability)
        : "Drive status is unavailable.";
  const driveState = loading ? "Checking…" : error ? "Unavailable" : capability ? driveLabel(capability) : "Unavailable";
  const driveColor = loading || error || !capability ? "text-ink-secondary" : driveTone(capability);
  const gateText = loading
    ? "Checking the server storage gate…"
    : error
      ? "The storage gate could not be confirmed."
      : gate
        ? gateDescription(gate)
        : "The storage gate is unavailable.";
  const gateState = loading ? "Checking…" : error || !gate ? "Unavailable" : gateLabel(gate);
  const gateColor = loading || error || !gate ? "text-ink-secondary" : gateTone(gate);

  return (
    <Card
      title="Local-first"
      subtitle="The desktop app reads and writes its workspace locally first. Google Drive sync is optional."
    >
      <div className="space-y-2">
        <SettingRow
          label="Workspace data"
          description="The local copy of workspace conversations, memory, and bot data is kept in this desktop installation's local data directory. This panel does not show the directory or any credentials."
        >
          <span className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-success">
            Local default
          </span>
        </SettingRow>
        <SettingRow label="Google Drive sync" description={driveText}>
          <span className={`rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-right text-[12px] ${driveColor}`}>
            {driveState}
          </span>
        </SettingRow>
        <SettingRow label="Storage gate" description={gateText}>
          <span className={`rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-right text-[12px] ${gateColor}`}>
            {gateState}
          </span>
        </SettingRow>
        {error && (
          <p role="alert" className="px-1 pt-1 text-[12px] leading-relaxed text-danger">
            Status could not be confirmed from the local server. No connection or sync activity is being assumed.
          </p>
        )}
        <p className="px-1 pt-1 text-[11.5px] leading-relaxed text-ink-secondary">
          This panel reports connection/readiness and the storage gate only. It does not report a last-sync time or per-conversation progress, and does not claim that a transfer is currently running.
        </p>
      </div>
    </Card>
  );
}

export function LocalFirstSection() {
  const [state, setState] = useState<LocalFirstViewState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void readLocalFirstStatus(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState({ kind: "ready", value });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "error" });
      });
    return () => controller.abort();
  }, []);

  return <LocalFirstView state={state} />;
}
