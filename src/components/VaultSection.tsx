// Settings → Vault: pair-free status view over Vaultgram — what's backed
// up into your private Telegram channel, plus manual backup/restore for
// anything on this machine. The passphrase never appears here; it comes
// from the daemon environment (VAULTGRAM_PASSPHRASE).

import { useCallback, useEffect, useState } from "react";
import { Card } from "./SettingsPrimitives";

interface VaultStatus {
  paired: boolean;
  unlocked: boolean;
  fileCount: number;
  lastSnapshot: string | null;
}
interface VaultFile {
  path: string;
  size: number;
  snapshot: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function VaultSection() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [localPath, setLocalPath] = useState("");
  const [vaultPath, setVaultPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [statusRes, filesRes] = await Promise.all([fetch("/api/vault/status"), fetch("/api/vault/files")]);
      // SAFETY: both endpoints are our own server handlers with fixed JSON shapes.
      // SAFETY: /api/vault/status returns the VaultStatus shape verbatim.
      setStatus((await statusRes.json()) as VaultStatus);
      // SAFETY: /api/vault/files returns {files: [...]} from our own index.
      setFiles(((await filesRes.json()) as { files: VaultFile[] }).files);
    } catch {
      setStatus({ paired: false, unlocked: false, fileCount: 0, lastSnapshot: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const backup = async () => {
    if (!localPath || !vaultPath) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/vault/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localPath, vaultPath }),
      });
      // SAFETY: /api/vault/backup returns {size, chunks} on success, {error} otherwise.
      const data = (await res.json()) as { size?: number; chunks?: number; error?: string };
      setMessage(
        res.ok ? `Backed up ${formatBytes(data.size ?? 0)} in ${data.chunks} sealed chunk(s).` : data.error ?? "backup failed",
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const restore = async (path: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/vault/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vaultPath: path }),
      });
      // SAFETY: /api/vault/restore returns {path} on success, {error} otherwise.
      const data = (await res.json()) as { path?: string; error?: string };
      setMessage(res.ok ? `Restored (hash-verified) to ${data.path}` : data.error ?? "restore failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Vault"
      subtitle="Encrypted backups into your own Telegram channel via Vaultgram. Every chunk is sealed on this machine and hash-verified on restore."
    >
      {!status?.paired ? (
        <div className="text-[13px] text-ink-secondary">
          Not paired yet. Run <code className="text-ink">vaultgram pair &lt;bot-token&gt; &lt;channel-id&gt;</code> once — the bot
          token comes from @BotFather and stays on this machine.
        </div>
      ) : !status.unlocked ? (
        <div className="text-[13px] text-ink-secondary">
          Paired, but locked: start Muster with <code className="text-ink">VAULTGRAM_PASSPHRASE</code> set to unlock backups and
          restores. The passphrase never travels through chat or the API.
        </div>
      ) : (
        <>
          <div className="mb-3 text-[13px] text-ink-secondary">
            {status.fileCount} file(s) in the vault · last snapshot {status.lastSnapshot ?? "—"}
          </div>
          <div className="mb-3 flex gap-2">
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="/path/to/file-or-folder"
              className="min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <input
              value={vaultPath}
              onChange={(e) => setVaultPath(e.target.value)}
              placeholder="vault-name"
              className="w-40 rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void backup()}
              disabled={busy || !localPath || !vaultPath}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            >
              Back up
            </button>
          </div>
          {files.length > 0 && (
            <div className="flex flex-col">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
                <span>Path</span>
                <span className="text-right">Size</span>
                <span className="text-right">Snapshot</span>
                <span />
              </div>
              {files.map((f) => (
                <div key={`${f.path}-${f.snapshot}`} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
                  <span className="truncate text-ink">{f.path}</span>
                  <span className="text-right tabular-nums text-ink-secondary">{formatBytes(f.size)}</span>
                  <span className="text-right tabular-nums text-ink-secondary">{f.snapshot}</span>
                  <button
                    type="button"
                    onClick={() => void restore(f.path)}
                    disabled={busy}
                    className="rounded-md border border-hairline px-2 py-0.5 text-[12px] text-ink hover:bg-hairline/20 disabled:opacity-40"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {message && <div className="mt-3 rounded-md border border-hairline/40 px-3 py-2 text-[13px] text-ink">{message}</div>}
    </Card>
  );
}
