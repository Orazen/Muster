// Vault section: Muster's native window onto Vaultgram — encrypted backups
// into the owner's private Telegram channel. The engine is imported, not
// shelled out; the passphrase still only comes from the daemon environment
// (VAULTGRAM_PASSPHRASE) and is never accepted over any API.

import { openIndex, backupFile, restoreFile, loadConfig, loadKey, syncDrive, importTakeout, vaultgramHome, type DriveCredentials } from "vaultgram";
import { join } from "node:path";

export interface VaultStatus {
  paired: boolean;
  /** True when VAULTGRAM_PASSPHRASE is set — without it nothing can be sealed or opened. */
  unlocked: boolean;
  fileCount: number;
  lastSnapshot: string | null;
}

export class VaultManager {
  private db: Awaited<ReturnType<typeof import("vaultgram").openIndex>> | null = null;

  private index(): ReturnType<typeof import("vaultgram").openIndex> | null {
    if (!loadConfig()) return null;
    this.db ??= openIndex(join(vaultgramHome(), "index.db"));
    return this.db;
  }

  status(): VaultStatus {
    const paired = Boolean(loadConfig());
    const passphrase = process.env.VAULTGRAM_PASSPHRASE ?? "";
    const unlocked = passphrase.length > 0;
    let fileCount = 0;
    let lastSnapshot: string | null = null;
    const db = this.index();
    if (db) {
      // SAFETY: COUNT(*) AS n — shape fixed by our own SQL.
      const countRow = db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
      fileCount = countRow.n;
      // SAFETY: single projected column from our own index.
      const lastRow = db.prepare("SELECT snapshot FROM files ORDER BY created_at DESC LIMIT 1").get() as {
        snapshot?: string;
      };
      lastSnapshot = lastRow?.snapshot ?? null;
    }
    return { paired, unlocked, fileCount, lastSnapshot };
  }

  async backup(localPath: string, vaultPath: string): Promise<{ size: number; chunks: number; snapshot: string }> {
    const db = this.index();
    if (!db) throw new Error("Vaultgram is not paired");
    const key = await import("vaultgram").then((m) => m.loadKey());
    const sink = await this.sink();
    const result = await backupFile(
      db,
      key,
      sink,
      localPath,
      // SAFETY: vault paths are display keys inside our own SQLite index and
      // Telegram filenames; they never reach a shell or a filesystem path.
      vaultPath.replace(/[^A-Za-z0-9._/-]/g, "_"),
      new Date().toISOString().slice(0, 10),
    );
    return { size: result.size, chunks: result.chunks, snapshot: new Date().toISOString().slice(0, 10) };
  }

  async restore(vaultPath: string, outDir: string): Promise<{ path: string; size: number }> {
    const db = this.index();
    if (!db) throw new Error("Vaultgram is not paired");
    const key = await import("vaultgram").then((m) => m.loadKey());
    const sink = await this.sink();
    // SAFETY: the SELECT projects exactly one column, snapshot, of our own index.
    const snapshots = (
      db.prepare("SELECT DISTINCT snapshot FROM files WHERE path=?").all(vaultPath) as Array<{ snapshot: string }>
    ).map((r) => r.snapshot);
    if (snapshots.length === 0) throw new Error("not backed up");
    snapshots.sort();
    const latest = snapshots[snapshots.length - 1];
    if (!latest) throw new Error("not backed up");
    const restored = await restoreFile(db, key, sink, vaultPath, latest, join(outDir, vaultPath.split("/").pop()!));
    return { path: restored.path, size: restored.size };
  }

  list(limit = 50): Array<{ path: string; size: number; snapshot: string }> {
    const db = this.index();
    if (!db) return [];
    // SAFETY: the SELECT names exactly these three columns of our own index,
    // so every row carries path/size/snapshot in that order.
    const rows = db
      .prepare("SELECT path, size, snapshot FROM files ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ path: string; size: number; snapshot: string }>;
    return rows;
  }

  /** Incremental Google Drive sync. Credentials come from the environment
   * (VAULTGRAM_GOOGLE_CLIENT_ID/SECRET/REFRESH) or the local request body. */
  async driveSync(creds: Partial<DriveCredentials>, seedFull = false): Promise<{ backedUp: number; failed: number; skippedTrashed: number }> {
    const db = this.index();
    if (!db) throw new Error("Vaultgram is not paired");
    const resolved: DriveCredentials = {
      clientId: creds.clientId ?? process.env.VAULTGRAM_GOOGLE_CLIENT_ID ?? "",
      clientSecret: creds.clientSecret ?? process.env.VAULTGRAM_GOOGLE_CLIENT_SECRET ?? "",
      refreshToken: creds.refreshToken ?? process.env.VAULTGRAM_GOOGLE_REFRESH_TOKEN ?? "",
    };
    if (!resolved.clientId || !resolved.clientSecret || !resolved.refreshToken) {
      throw new Error("Google credentials missing — set VAULTGRAM_GOOGLE_* or pass clientId/clientSecret/refreshToken");
    }
    const result = await syncDrive(db, await loadKey(), await this.sink(), resolved, { seedFull });
    return { backedUp: result.backedUp, failed: result.failed.length, skippedTrashed: result.skippedTrashed };
  }

  async takeoutImport(dirPath: string): Promise<{ imported: number; skippedUnchanged: number; failed: number }> {
    const db = this.index();
    if (!db) throw new Error("Vaultgram is not paired");
    const result = await importTakeout(db, await loadKey(), await this.sink(), dirPath);
    return { imported: result.imported, skippedUnchanged: result.skippedUnchanged, failed: result.failed.length };
  }

  private async sink() {
    const config = loadConfig();
    if (!config) throw new Error("Vaultgram is not paired");
    const { TelegramSink } = await import("vaultgram");
    return new TelegramSink(config.token, config.channelId);
  }
}
