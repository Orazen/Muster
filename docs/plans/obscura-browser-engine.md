# Obscura browser engine — integration plan

[Obscura](https://github.com/h4ckf0r0day/obscura) (Apache-2.0) is a Rust
headless browser engine for AI agents: embedded V8, CDP-compatible,
native stealth, **first-class MCP** (`obscura mcp` exposes 14 `browser_*`
tools), ~30MB RAM, no Chromium dependency. License is Apache-2.0 —
compatible with Muster's BSL 1.1 (embedding and redistribution under our
terms is fine; Apache notices are retained in the binary).

## Why it matters for Muster

Sentries that *browse* need a browser that runs unattended inside a
cloud VM at negligible cost. Playwright/Chromium stacks are heavy per
VM; Obscura's single static binary (~57MB Docker, ~30MB RAM) makes
one-per-VM density trivial, and its MCP surface means zero bespoke
driver code — bots already speak MCP.

## Deployment modes

| Mode | Surface | Use |
|---|---|---|
| stdio MCP | `obscura mcp` | Per-bot local MCP mount (same pattern as every custom MCP server). |
| HTTP MCP | `obscura mcp --http --port 8080` | Shared per-VM mount; several bots on one computer use one browser service. |
| CDP server | `obscura serve --port 9222` | Streaming screencast (`Page.startScreencast`) into the computer-use viewer — the upgrade path for "watch the sentry browse". |

## Phases

### Phase 1 (done) — spec module
`server/obscura.ts` builds the mount (command/args/env) with flag
gating: `--stealth`, `--proxy` (validated http(s) only),
`--allow-private-network` (SSRF guard — NEVER default), plus the cloud
VM install script (https-only release download, shell-injection-safe
version sanitization, no embedded credentials). Tests pin all of it.

### Phase 2 — MCP mount inside cloud VMs
Append `cloudVmInstallScript(...)` output to the cloud VM bootstrap
(where Cua is prepared), then register the mount in the bot's MCP
config (same shape as a custom MCP server: command `obscura`, args from
`buildObscuraMcpMount`). Acceptance: a sentry turn can
navigate → snapshot → click → evaluate against a public page.

### Phase 3 — CDP screencast upgrade
Add a browser driver speaking CDP to `obscura serve` so the computer-use
viewer streams the sentry's browsing live; fall back to the MCP
`browser_screenshot` tool for simple reads.

## Caveats

- `--allow-private-network` must never ship enabled: it exists for
  trusted-VPC setups and disables Obscura's own SSRF guard.
- The rendering engine is younger than Chromium; screenshots/PDF need
  the `render` build; MCP mode gives still images only.
- Tracker blocklist (`stealth` build) may break pages that depend on
  blocked endpoints — make stealth a per-mount choice.
