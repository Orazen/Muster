import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { readTheme } from "@/lib/skins";
import { loadDensity } from "@/lib/sidebar-preferences";
import { createVisibleBrowserClient, visibleAuthorizationUrl, visibleBrowserErrorText, visibleCaptureSchema, visibleConsentSchema,
  visibleCopySchema, visibleInspectionSchema, visiblePopupResult, visibleReceiptSchema, visibleStatusSchema, type VisibleStatus } from "@/lib/visible-drive-browser";

export function visibleDriveStatusText(status: VisibleStatus | null): string {
  if (!status) return "Checking optional Drive copies…";
  if (!status.available) return "Optional Drive copies are unavailable on this workspace.";
  return status.connected ? "Optional Drive connection ready." : "Connect Drive separately to save optional copies. Google sign-in alone does not connect it.";
}
class VisibleCardFailure extends Error {}
function closeOwnedPopup(popup: Window | null, origin: string): boolean {
  try {
    if (!popup || popup.closed) return true;
    // Keep opener severed. Cross-origin closure is a browser limitation;
    // never try to regain control by navigating an unowned Google document.
    const href = popup.location.href;
    if (href !== "about:blank" && new URL(href).origin !== origin) return false;
    popup.close();
    return popup.closed;
  } catch { return false; }
}

const button = "min-h-10 rounded-lg border border-hairline px-3 py-2 text-[13px] disabled:opacity-50";
const input = "min-h-10 w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px]";
const cancelSchema = visibleReceiptSchema.extend({ cancelled: z.boolean() });
const disconnectSchema = visibleReceiptSchema.extend({ disconnected: z.literal(true), remoteRevocation: z.literal("not-requested"), backups: z.literal("preserved") });

export function VisibleDriveCard() {
  const { user, session } = useAuth();
  const binding = useMemo(() => ({ userId: user?.id ?? "", sessionId: session?.id ?? "",
    sessionToken: session?.token ?? "", origin: window.location.origin }), [user?.id, session?.id, session?.token]);
  const currentBinding = useRef(binding); currentBinding.current = binding;
  const client = useMemo(() => createVisibleBrowserClient(binding, () => currentBinding.current === binding), [binding]);
  const [status, setStatus] = useState<VisibleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [fileId, setFileId] = useState("");
  const [consenting, setConsenting] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const consent = useRef<{ state: string; expiresAt: number; viewRevision: string; popup: Window } | null>(null);
  const completing = useRef(false);
  const ownedPopup = useRef<Window | null>(null);
  const retiredPopup = useRef<{ popup: Window; until: number } | null>(null);
  const closePopup = () => {
    const held = consent.current;
    const popup = held?.popup ?? ownedPopup.current;
    const closed = closeOwnedPopup(popup, binding.origin);
    consent.current = null; setConsenting(false);
    if (!closed && popup) {
      retiredPopup.current = { popup, until: Math.min(held?.expiresAt ?? Date.now() + 600_000, Date.now() + 600_000) };
      ownedPopup.current = popup; setRetiring(true);
    } else { retiredPopup.current = null; ownedPopup.current = null; setRetiring(false); }
    return closed;
  };
  useLayoutEffect(() => {
    setStatus(null); setNotice(""); setError(""); setPassphrase(""); setFileId(""); setBusy(false); setRetiring(false); busyRef.current = false;
    setConsenting(false); completing.current = false;
    return () => { client.dispose(consent.current?.state); closeOwnedPopup(ownedPopup.current, binding.origin); ownedPopup.current = null; retiredPopup.current = null; consent.current = null; };
  }, [client]);
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current || !client.current()) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (failure) { if (client.current()) { setStatus(null); setError(failure instanceof VisibleCardFailure ? failure.message : visibleBrowserErrorText(failure instanceof Error ? failure : null)); } }
    finally { if (client.current()) { busyRef.current = false; setBusy(false); setPassphrase(""); } }
  };
  const refresh = async () => { const next = await client.request("status", visibleStatusSchema); if (client.current()) setStatus(next); return next; };
  useEffect(() => { void run(async () => { await refresh(); }); }, [client]);

  const cancel = async () => {
    const held = consent.current;
    if (!held) return;
    setPassphrase("");
    let cancelled = false;
    try { await client.request("cancel", cancelSchema, { state: held.state }); cancelled = true; }
    finally {
      if (client.current() && consent.current === held) {
        const closed = closePopup();
        if (cancelled) setNotice(closed ? "Consent cancelled. Existing backups were preserved."
          : "Consent cancelled. Close the Google sign-in window. Existing backups were preserved.");
      }
    }
  };
  useEffect(() => {
    const timer = setInterval(() => {
      const retired = retiredPopup.current;
      if (retired && (closeOwnedPopup(retired.popup, binding.origin) || Date.now() >= retired.until)) {
        if (ownedPopup.current === retired.popup) ownedPopup.current = null;
        retiredPopup.current = null; setRetiring(false);
      }
      const held = consent.current;
      if (!held || completing.current || busyRef.current || !client.current()) return;
      if (held.popup.closed || Date.now() >= held.expiresAt) { void run(cancel); return; }
      let result: ReturnType<typeof visiblePopupResult> = null;
      try { result = visiblePopupResult(held.popup.location.href, held.popup.document.body?.textContent ?? "", held.state, window.location.origin); }
      catch { return; } // Google is cross-origin until the actual callback.
      if (!result) return;
      completing.current = true;
      void run(async () => {
        if (result.status === "declined") { await cancel(); throw new VisibleCardFailure("Drive consent was not completed. Existing backups were preserved."); }
        let next: VisibleStatus;
        try { next = await refresh(); } catch (failure) { closePopup(); throw failure; }
        if (!next.connected || result.viewRevision !== held.viewRevision || next.viewRevision !== result.viewRevision
          || next.grantRevision !== result.grantRevision) {
          closePopup();
          throw new VisibleCardFailure("This consent could not be confirmed. Reopen Backups before retrying.");
        }
        if (!client.current() || consent.current !== held) return;
        closePopup(); setNotice("Optional Drive connection confirmed.");
      }).finally(() => { if (client.current()) completing.current = false; });
    }, 750);
    return () => clearInterval(timer);
  }, [client]);

  const connect = () => {
    if (!status?.available || busyRef.current || consent.current || retiredPopup.current || !client.current()) return;
    // Open synchronously in the user's click; a blocked popup creates no consent.
    const popup = window.open("about:blank", "_blank", "popup,width=520,height=720");
    if (!popup) { setError("Allow this sign-in popup, then retry connecting Drive."); return; }
    ownedPopup.current = popup; popup.opener = null;
    void run(async () => {
      let attempt: z.infer<typeof visibleConsentSchema> | null = null;
      try {
        attempt = await client.request("consent", visibleConsentSchema, {});
        const url = visibleAuthorizationUrl(attempt, window.location.origin);
        if (!client.current() || popup.closed) throw new VisibleCardFailure("The consent window was closed. Please retry.");
        consent.current = { ...attempt, popup }; setConsenting(true); popup.location.replace(url);
      } catch (failure) {
        closeOwnedPopup(popup, binding.origin); if (ownedPopup.current === popup) ownedPopup.current = null;
        if (attempt && client.current()) await client.request("cancel", cancelSchema, { state: attempt.state }).catch(() => undefined);
        throw failure;
      }
    });
  };
  const copy = () => void run(async () => {
    if (!status?.available || !status.connected || !status.settingsCaptured || passphrase.length < 8) throw new VisibleCardFailure("Capture your preferences and enter a passphrase of at least 8 characters.");
    const result = await client.request("backup", visibleCopySchema, { format: "account-recovery-v1", passphrase });
    if (!client.current()) return;
    setFileId(result.fileId); setNotice(`Encrypted copy verified (${result.bytes} bytes). Copy ID: ${result.fileId}. No restore was applied.`);
  });
  const inspect = () => void run(async () => {
    if (!status?.available || !status.connected || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId) || passphrase.length < 8) throw new VisibleCardFailure("Enter the copy ID and its passphrase to inspect it.");
    const result = await client.request("restore/inspect", visibleInspectionSchema, { format: "account-recovery-v1", fileId, passphrase });
    if (client.current()) setNotice(`Inspection ready: ${result.counts.bots} teammates, ${result.counts.threads} conversations, ${result.counts.messages} messages. No restore was applied.`);
  });

  return <section aria-label="Optional Drive copies" className="rounded-xl bg-card p-4">
    <h3 className="text-[15px] font-medium text-ink">Optional Drive copies</h3>
    <p className="mt-1 text-[13px] text-ink-secondary">Save an encrypted copy for your account in a visible Muster folder. Existing backups stay in place. This does not enable automatic sync.</p>
    <p className="mt-2 text-[13px] text-ink-secondary" role="status">{visibleDriveStatusText(status)}</p>
    <p className="mt-1 text-[12px] text-ink-secondary">Inspection only. Restoring a copy into a live workspace is unavailable.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className={button} disabled={busy || consenting} onClick={() => void run(async () => { await refresh(); })}>Refresh Drive status</button>
      <button className={button} disabled={busy || consenting || retiring || !status?.available} onClick={connect}>{status?.connected ? "Reconnect optional Drive" : "Connect optional Drive"}</button>
      {consenting && <button className={button} disabled={busy} onClick={() => void run(cancel)}>Cancel Drive consent</button>}
      {status?.connected && <button className={button} disabled={busy || consenting} onClick={() => void run(async () => {
        await client.request("disconnect", disconnectSchema, {}); await refresh(); setNotice("Optional connection disconnected. Existing copies were preserved; Google access was not revoked.");
      })}>Disconnect optional Drive</button>}
    </div>
    <button className={`${button} mt-3`} disabled={busy || consenting || !status} onClick={() => void run(async () => {
      await client.request("settings", visibleCaptureSchema, { values: { theme: readTheme(), density: loadDensity() } });
      await refresh(); setNotice("This browser’s current theme and sidebar density were captured for your account.");
    })}>Capture current preferences</button>
    <p className="mt-1 text-[12px] text-ink-secondary">{status?.settingsCaptured ? "Preferences captured. Capture again after changing them." : "Capture preferences explicitly before creating a copy."}</p>
    <label className="mt-3 block text-[13px] text-ink-secondary">Copy passphrase<input aria-label="Drive copy passphrase" type="password" autoComplete="off" maxLength={4096}
      value={passphrase} onChange={event => setPassphrase(event.target.value)} disabled={busy || consenting} className={`${input} mt-1`} /></label>
    <button className={`${button} mt-2`} disabled={busy || consenting || !status?.available || !status.connected || !status.settingsCaptured || passphrase.length < 8} onClick={copy}>Create encrypted Drive copy</button>
    <label className="mt-3 block text-[13px] text-ink-secondary">Copy ID<input aria-label="Drive copy ID" value={fileId} maxLength={200}
      onChange={event => setFileId(event.target.value)} disabled={busy || consenting} className={`${input} mt-1`} /></label>
    <button className={`${button} mt-2`} disabled={busy || consenting || !status?.available || !status.connected || !fileId || passphrase.length < 8} onClick={inspect}>Inspect Drive copy</button>
    {notice && <p role="status" className="mt-2 text-[13px] text-ink-secondary">{notice}</p>}
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
  </section>;
}
