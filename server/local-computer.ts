import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./schema.ts";

export type LocalComputerConnection = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

// Descriptor fields arrive from JSON.parse of cua-connection.json, so every
// one is validated here before use instead of trusted.
type ConnectionDescriptor = {
  mode?: JsonValue;
  mcpCommand?: JsonValue;
  mcpArgs?: JsonValue;
  mcpEnv?: JsonValue;
};

// Strings are the only values String() round-trips exactly, so this rejects
// numbers/booleans/null/nested objects the descriptor file could carry.
const isText = (v: JsonValue | undefined): v is string => Object.is(String(v), v);

/** A JSON object member of the JsonValue union (arrays excluded). */
const isRecord = (v: JsonValue | undefined): v is JsonObject =>
  v instanceof Object && !Array.isArray(v);

function decodeDescriptor(value: ConnectionDescriptor): LocalComputerConnection | null {
  if (!value || value.mode === "unavailable" || !isText(value.mcpCommand)) return null;
  if (value.mcpArgs !== undefined && !Array.isArray(value.mcpArgs)) return null;

  const args: string[] = [];
  for (const arg of value.mcpArgs ?? ["mcp"]) {
    if (!isText(arg)) return null;
    args.push(arg);
  }

  // A missing mcpEnv is fine; a present-but-non-record one rejects the config.
  const rawEnv = isRecord(value.mcpEnv) ? value.mcpEnv : undefined;
  if (rawEnv === undefined && value.mcpEnv !== undefined) return null;
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(rawEnv ?? {})) {
    if (!isText(entry)) return null;
    env[key] = entry;
  }

  return { command: value.mcpCommand, args, env };
}

export function readCuaConnection({
  platform = process.platform,
  userData = process.env.OMB_USER_DATA,
  home = homedir(),
}: {
  platform?: NodeJS.Platform;
  userData?: string;
  home?: string;
} = {}): LocalComputerConnection | null {
  // Linux local automation is deliberately outside the Ubuntu baseline.
  // Ignore even a forged or stale descriptor until the CUA follow-up adds
  // session-aware readiness and end-to-end evidence.
  if (platform === "linux") return null;

  const candidates = userData ? [join(userData, "cua-connection.json")] : [];
  if (platform === "darwin") {
    // Legacy/dev fallback. Packaged Electron passes its exact userData path.
    for (const dir of ["Muster", "muster", "OpenGrokBot", "opengrokbot"]) {
      candidates.push(join(home, "Library", "Application Support", dir, "cua-connection.json"));
    }
  }

  for (const file of new Set(candidates)) {
    try {
      const decoded = decodeDescriptor(JSON.parse(readFileSync(file, "utf8")));
      if (decoded) return decoded;
    } catch {
      // Missing, invalid, or stale descriptors are simply unavailable.
    }
  }
  return null;
}
