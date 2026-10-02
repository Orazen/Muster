import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Check, Cloud, ExternalLink, Mail, RefreshCw } from "lucide-react";
import { useStore } from "@/state/store";
import { onboardingDriveReturn, prepareOnboardingConsent, readOnboardingDrive, readOnboardingGmail, type DriveSetupStatus, type GmailSetupStatus } from "@/lib/onboarding-connections";

type Load<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "error"; message: string };
const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Connection cards only; the wizard owns progress, drafts and navigation. */
export function OnboardingConnections() {
  const { state, dispatch } = useStore();
  const config = useRef(state.config);
  config.current = state.config;
  const [drive, setDrive] = useState<Load<DriveSetupStatus>>({ kind: "loading" });
  const [gmail, setGmail] = useState<Load<GmailSetupStatus>>({ kind: "loading" });
  const [driveBusy, setDriveBusy] = useState(false);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailUrl, setGmailUrl] = useState<string | null>(null);
  const requests = useRef<{ drive?: AbortController; gmail?: AbortController; driveConsent?: AbortController; gmailConsent?: AbortController }>({});
  const mounted = useRef(false);

  const refreshDrive = useCallback(async () => {
    requests.current.drive?.abort();
    const request = new AbortController();
    requests.current.drive = request;
    setDrive({ kind: "loading" });
    setDriveError(null);
    try {
      const value = await readOnboardingDrive(request.signal);
      if (!mounted.current || request.signal.aborted) return;
      setDrive({ kind: "ready", value });
      // Update only the verified gate in the latest config: this refresh must
      // not overwrite preferences that changed while the requests were pending.
      if (config.current) dispatch({ type: "configStatus", config: { ...config.current, storageGate: value.gate } });
      const returned = onboardingDriveReturn(window.location);
      if (returned) {
        // Consume only after the server check succeeded. A failed refresh
        // leaves the marker available for the person's explicit retry.
        window.history.replaceState(window.history.state, "", returned.cleaned);
        if (returned.outcome === "connect-failed") setDriveError("Drive permission was not completed. Check the status above and try again when you are ready.");
      }
    } catch (error) {
      if (mounted.current && !request.signal.aborted) setDrive({ kind: "error", message: error instanceof Error ? error.message : "Could not check Drive. Try again." });
    }
  }, [dispatch]);

  const refreshGmail = useCallback(async () => {
    requests.current.gmail?.abort();
    const request = new AbortController();
    requests.current.gmail = request;
    setGmail({ kind: "loading" });
    setGmailError(null);
    try {
      const value = await readOnboardingGmail(request.signal);
      if (!mounted.current || request.signal.aborted) return;
      setGmail({ kind: "ready", value });
      if (value.kind !== "pending") setGmailUrl(null);
      if (value.kind === "connected" || value.kind === "unavailable") {
        requests.current.gmailConsent?.abort();
        delete requests.current.gmailConsent;
        setGmailBusy(false);
      }
    } catch (error) {
      if (mounted.current && !request.signal.aborted) setGmail({ kind: "error", message: error instanceof Error ? error.message : "Could not check Gmail. Try again." });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshDrive();
    void refreshGmail();
    const returnedToWindow = () => { void refreshDrive(); void refreshGmail(); };
    window.addEventListener("focus", returnedToWindow);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", returnedToWindow);
      for (const request of Object.values(requests.current)) request?.abort();
    };
  }, [refreshDrive, refreshGmail]);

  const connect = async (service: "drive" | "gmail") => {
    const slot = service === "drive" ? "driveConsent" : "gmailConsent";
    if (requests.current[slot]) return;
    const request = new AbortController();
    requests.current[slot] = request;
    const setBusy = service === "drive" ? setDriveBusy : setGmailBusy;
    const setError = service === "drive" ? setDriveError : setGmailError;
    setBusy(true);
    setError(null);
    try {
      const url = await prepareOnboardingConsent(service, request.signal);
      if (!mounted.current || request.signal.aborted) return;
      if (service === "drive") window.location.assign(url);
      else setGmailUrl(url); // A link is an invitation, not a connected account.
    } catch (error) {
      if (mounted.current && !request.signal.aborted) setError(error instanceof Error ? error.message : "Could not open the connection. Try again.");
    } finally {
      if (requests.current[slot] === request) delete requests.current[slot];
      if (mounted.current && !request.signal.aborted) setBusy(false);
    }
  };

  const openGmail = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!window.ogb?.openExternal || !gmailUrl) return;
    event.preventDefault();
    try {
      if (!await window.ogb.openExternal(gmailUrl)) throw new Error("Could not open the Gmail connection page. Try again.");
    } catch (error) {
      if (mounted.current) setGmailError(error instanceof Error ? error.message : "Could not open Gmail. Try again.");
    }
  };

  const driveRequired = state.config?.storageGate?.required === true;
  const driveConnected = drive.kind === "ready" && drive.value.connected;
  const desktopDrive = drive.kind === "ready" && !drive.value.available && drive.value.localBackupReady;
  const gmailState = gmail.kind === "ready" ? gmail.value : null;

  return <div className="space-y-3" aria-label="Connect your apps">
    <p className="text-[13px] leading-relaxed text-ink-secondary">Google sign-in, Drive storage and Gmail are separate permissions. Choose what you need; Gmail is optional.</p>
    <section className="min-w-0 rounded-2xl border border-hairline bg-card p-4" aria-label="Google Drive setup">
      <div className="flex items-center gap-2 text-[14px] font-semibold"><Cloud size={17} aria-hidden="true" />Google Drive<span className="ml-auto text-[11px] font-normal text-ink-secondary">{driveRequired ? "Required for saving work" : "Optional"}</span></div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{desktopDrive ? "Drive is already connected on this desktop for workspace backups. Connecting it does not turn on automatic backups." : "Connect Muster’s private folder in your Drive. This does not grant access to your other files or turn on automatic backup and sync."}</p>
      <p role="status" className="mt-3 flex items-center gap-1.5 text-[13px]">{(driveConnected || desktopDrive) && <Check size={15} aria-hidden="true" />}{drive.kind === "loading" ? "Checking Drive…" : drive.kind === "error" ? "Drive status unavailable" : driveConnected ? "Connected" : desktopDrive ? "Desktop backup connected" : drive.value.available ? "Not connected" : "Drive setup is unavailable here"}</p>
      {drive.kind === "ready" && !drive.value.available && !desktopDrive && <p className="mt-2 text-[12.5px] text-ink-secondary">Drive connection is not configured for this account here. You can finish reviewing setup; {driveRequired ? "saving work may stay unavailable until Drive can connect." : "you can review desktop backup options in Settings → Connections."}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {drive.kind === "ready" && drive.value.available && !driveConnected && <button type="button" className={control} disabled={driveBusy} onClick={() => void connect("drive")}>{driveBusy ? "Opening Google…" : "Connect Google Drive"}</button>}
        {desktopDrive && <button type="button" className={control} onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}>Manage desktop backup</button>}
        <button type="button" className={control} disabled={drive.kind === "loading" || driveBusy} onClick={() => void refreshDrive()}><RefreshCw size={13} aria-hidden="true" />Check Drive again</button>
      </div>
      {(driveError || drive.kind === "error") && <p role="alert" className="mt-2 text-[12.5px] text-danger">{driveError ?? (drive.kind === "error" ? drive.message : null)}</p>}
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-secondary">{desktopDrive ? "Manage encrypted backup and restore in Settings → Connections. Keep your backup passphrase somewhere safe." : driveRequired ? "Drive permission is separate from Muster sign-in. Your web workspace is still stored on Muster’s server; encrypted backup and restore currently require the desktop app." : "Account Drive permission is separate from this computer’s backup connection. Manage encrypted backup and restore in Settings → Connections."}</p>
    </section>
    <section className="min-w-0 rounded-2xl border border-hairline bg-card p-4" aria-label="Gmail setup">
      <div className="flex items-center gap-2 text-[14px] font-semibold"><Mail size={17} aria-hidden="true" />Gmail<span className="ml-auto text-[11px] font-normal text-ink-secondary">Optional</span></div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">Connect email for your assistant’s work. Review the permissions on the connection page before allowing access; this step does not send email.</p>
      <p role="status" className="mt-3 flex items-center gap-1.5 text-[13px]">{gmailState?.kind === "connected" && <Check size={15} aria-hidden="true" />}{gmail.kind === "loading" ? "Checking Gmail…" : gmail.kind === "error" ? "Gmail status unavailable" : gmailState?.kind === "connected" ? "Connected" : gmailState?.kind === "pending" ? "Waiting for permission — check again after finishing" : gmailState?.kind === "unavailable" ? "Gmail setup is unavailable here" : "Not connected"}</p>
      {gmailState?.kind === "unavailable" && <p className="mt-2 text-[12.5px] text-ink-secondary">{gmailState.reason}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {gmailState && gmailState.kind !== "connected" && gmailState.kind !== "unavailable" && !gmailUrl && <button type="button" className={control} disabled={gmailBusy} onClick={() => void connect("gmail")}>{gmailBusy ? "Preparing connection…" : "Connect Gmail"}</button>}
        {gmailUrl && <a className={control} href={gmailUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => void openGmail(event)}>Continue to Gmail permission<ExternalLink size={13} aria-hidden="true" /></a>}
        <button type="button" className={control} disabled={gmail.kind === "loading" || gmailBusy} onClick={() => void refreshGmail()}><RefreshCw size={13} aria-hidden="true" />Check Gmail again</button>
      </div>
      {gmailUrl && <p className="mt-2 break-words text-[11.5px] text-ink-secondary">Opens {new URL(gmailUrl).hostname} in your browser. Return here and check again when you finish.</p>}
      {(gmailError || gmail.kind === "error") && <p role="alert" className="mt-2 text-[12.5px] text-danger">{gmailError ?? (gmail.kind === "error" ? gmail.message : null)}</p>}
    </section>
  </div>;
}
