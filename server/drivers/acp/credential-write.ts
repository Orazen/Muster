// Provider BYOK upserts write real API keys into each driver's own config
// file. Those files are credential artifacts: first creation must never land
// at umask-default permissions, and a pre-existing file created by an older
// build must be tightened, never loosened. This mirrors the write discipline
// qwen.ts applies to its own settings file.
import { chmodSync, writeFileSync } from "node:fs";

export function writeCredentialFile(path: string, bytes: string): void {
  writeFileSync(path, bytes, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; keep the inject even if chmod is unsupported.
  }
}
