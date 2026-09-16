// "Connected workspaces" — the web-app twin of the desktop section: one
// place to see where your bots live and hop between deployments. The list is
// this browser's, per account; connecting never moves or replaces bots,
// conversations, or provider accounts — it only bookmarks the other
// deployment's address so you can sign in there.
import { useEffect, useState } from "react";
import { Check, Cloud, Laptop, Loader2, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Card } from "./SettingsPrimitives";
import { DESKTOP_LINK_GUIDANCE, planWorkspaceConnect } from "@/lib/pairing-link";
import { addWorkspace, forgetWorkspace, loadWorkspaces, probeWorkspace, switchTarget, type SavedWorkspace } from "@/lib/workspaces";

export function ConnectedWorkspacesSection() {
  const { user } = useAuth();
  const accountId = user?.id ?? "anon";
  const [saved, setSaved] = useState<SavedWorkspace[]>(() => loadWorkspaces(accountId));
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => setSaved(loadWorkspaces(accountId)), [accountId]);

  const connect = async () => {
    const plan = planWorkspaceConnect(address);
    if (plan.kind === "error") {
      setNotice("");
      setError(plan.error);
      return;
    }
    if (plan.kind === "desktop-code") {
      setError("");
      setNotice(DESKTOP_LINK_GUIDANCE);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const reachable = await probeWorkspace(plan.origin);
    const added = addWorkspace(accountId, plan.origin, name);
    setSaved(added.list);
    setBusy(false);
    if (added.error) setError(added.error);
    else if (!reachable)
      setError("Saved — but that address did not answer. Check it is running and reachable from this browser.");
    else {
      setAddress("");
      setName("");
      // a pairing link carries its code straight through to the other host
      if (plan.code) window.location.href = switchTarget(plan.origin, plan.code);
    }
  };

  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        One Muster, wherever your bots live. Switching workspaces does not move or replace your
        bots, conversations, or provider accounts.
      </p>
      <Card title="Your workspaces" subtitle="Saved in this browser. Your hosted bots keep running when you switch away.">
        <ul className="divide-y divide-hairline/40">
          <li className="flex items-center gap-3 py-3">
            <Laptop size={18} className="shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">This workspace</div>
              <div className="break-all text-[12px] text-ink-secondary">{window.location.origin}</div>
            </div>
            <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-secondary">
              <Check size={13} />
              Current
            </span>
          </li>
          {saved.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 py-3">
              <Cloud size={18} className="shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-ink">{entry.name}</div>
                <div className="break-all text-[12px] text-ink-secondary">{entry.origin}</div>
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={`Switch to ${entry.name}`}
                onClick={() => {
                  window.location.href = switchTarget(entry.origin);
                }}
                className="rounded-md px-2 py-1.5 text-[12px] text-ink hover:bg-raised disabled:opacity-50"
              >
                Switch
              </button>
              <button
                type="button"
                disabled={busy}
                aria-label={`Forget ${entry.name}`}
                title={`Forget ${entry.name}`}
                onClick={() => setSaved(forgetWorkspace(accountId, entry.id))}
                className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Connect hosted workspace" subtitle="Already running Muster on a VPS, server, or another computer? Connect it here.">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) void connect();
          }}
        >
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
            Workspace address or pairing link
            <input
              required
              value={address}
              disabled={busy}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://bots.yourcompany.com"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
            Name (optional)
            <input
              value={name}
              disabled={busy}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder="My cloud workspace"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent/50"
            />
          </label>
          <p className="text-[12px] leading-relaxed text-ink-secondary">
            Enter the address of the deployment you want to reach, or paste a link it gave you. A
            pairing code belongs in the link&rsquo;s <code>#fragment</code>, never its query string.
            This browser stays connected afterward.
          </p>
          <details className="text-[12px] text-ink-secondary">
            <summary className="cursor-pointer">Address, link, or code?</summary>
            <p className="mt-2">
              An address connects this browser to another deployment. A link carries a code in its
              fragment. A 6-digit code is the desktop app&rsquo;s handoff and is entered there, not
              here. For a workspace on your own network, open its address directly in a browser tab.
            </p>
          </details>
          {error && (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-[12px] text-ink-secondary">
              {notice}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !address.trim()}
            className="flex w-fit items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Connect workspace
          </button>
        </form>
      </Card>
    </>
  );
}
