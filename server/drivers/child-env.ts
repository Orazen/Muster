// Engine child-process environment hygiene.
//
// Engine CLIs (claude, codex, ACP engines, antigravity) run model-driven shell
// commands, so anything in their environment is one prompt injection away
// from being printed and exfiltrated. Drivers build their child env from
// `{ ...process.env, ...input.environment }` so engines keep PATH, HOME,
// locale, proxies, the user's shell setup and the provider credentials the
// engine itself needs. That spread also carried the harness's own server
// secrets (BETTER_AUTH_SECRET signs sessions and derives the per-user vault
// key; VAULTGRAM_PASSPHRASE; Stripe; OAuth client secrets; broker tokens).
//
// No engine needs any of those, and no driver passes them on purpose, so they
// are stripped at the one spawn choke point (procs.ts spawnCli/execCli). This
// is a denylist rather than mcp-bridge.ts's allowlist on purpose: engines are
// first-party CLIs that legitimately depend on an open-ended set of user env
// (proxies, SSH agents, toolchain vars, provider keys), and an allowlist would
// break real setups. Third-party MCP children keep their strict allowlist.
//
// Deliberately NOT stripped (engines or their MCP proxies need them, or they
// are re-injected per instance): provider API keys (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, XAI_API_KEY, OPENCODE_API_KEY, …, which drivers already
// prune per engine), BOX_TOKEN (injected per instance), and the per-turn
// loopback tokens (OMB_COMMS_TOKEN, OMB_CONNECTOR_UPSTREAM_HEADERS) the Codex
// connector bridge forwards through env_vars.

/** Exact names of harness/server secrets that must never reach an engine. */
export const SERVER_SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  "BETTER_AUTH_SECRET",
  "VAULTGRAM_PASSPHRASE",
  "MUSTER_SYNC_PASSPHRASE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  // Composio is reached through the loopback connector proxy with a per-turn
  // comms token; the project key and broker token stay in the harness.
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  "OMB_OPENCONNECTOR_TOKEN",
  "OMB_TTS_KEY",
  "HI_NEW_TOKEN",
  "OPEN_SANDBOX_API_KEY",
]);

/** Name patterns that are server secrets by construction. */
const SERVER_SECRET_ENV_PATTERNS: readonly RegExp[] = [
  /^BETTER_AUTH_/,
  /^VAULTGRAM_/,
  /^STRIPE_/,
  /_SECRET$/,
  /_PASSPHRASE$/,
];

export function isServerSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SERVER_SECRET_ENV_NAMES.has(upper)) return true;
  return SERVER_SECRET_ENV_PATTERNS.some((pattern) => pattern.test(upper));
}

/** A copy of `source` with every harness/server secret removed. Never mutates
 * `source`. Everything else (PATH, HOME, locale, provider keys, per-turn
 * tokens) passes through unchanged. */
export function stripServerSecrets(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (isServerSecretEnvName(key)) continue;
    env[key] = value;
  }
  return env;
}
