// Profile setup supplies these paths before child processes start. Copy only
// explicit values; do not derive missing paths or import unrelated credentials
// and Node hooks. This is app-data routing, not an OS or filesystem sandbox:
// a caller's deliberately configured target environment still overrides it.
const PROFILE_PATH_KEYS = [
  "MUSTER_PROFILE_ROOT",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "TMPDIR", "TMP", "TEMP", "MAC_CHROMIUM_TMPDIR", "ZDOTDIR",
  "OMB_DATA_DIR", "OMB_USER_DATA", "OMB_COMPANION_DIR",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "FACTORY_HOME_OVERRIDE",
  "HERMES_HOME", "KIMI_CODE_HOME", "GROK_HOME",
] as const;

export type ProfilePathEnvironment = Partial<Record<(typeof PROFILE_PATH_KEYS)[number], string>>;

/** Preserve the existing minimal child environment when no profile is set.
 * Profile-path validation belongs to the desktop startup configuration. */
export function profilePathEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.MUSTER_PROFILE_ROOT === undefined) return {};
  const paths: ProfilePathEnvironment = {};
  for (const key of PROFILE_PATH_KEYS) {
    const value = env[key];
    if (value !== undefined) paths[key] = value;
  }
  return paths;
}
