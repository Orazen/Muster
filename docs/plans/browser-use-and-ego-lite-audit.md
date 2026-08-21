# Audit — browser-use and ego-lite, and the real "Runs on" root cause

## The actual bug behind "Runs on... not working"

Confirmed by code inspection, not guessed: only two driver families in Muster declare
`capabilities: { computerMcp: true }` — `server/drivers/claude.ts` and
`server/drivers/acp/core.ts` (Codex, Gemini CLI, and any other ACP-protocol engine). The 12
direct-API provider drivers shipped this session (OpenAI, Anthropic, Google, DeepSeek, Mistral,
Cohere, Groq, Together, Fireworks, OpenRouter, **OpenCode Zen**, xAI — all built on the shared
`server/drivers/openai-compatible.ts` factory) never wire tool-calling/MCP-mounting at all.

The account's own bot (`tarunai`, `opencodeZenApi` / `deepseek-v4-flash-free`) is on exactly
this driver family. Every "Runs on" option — Cloud box, OpenSandbox, Local VM, even "This
computer" — is *correctly* disabled for it; there's no live bug in the picker itself, just an
under-communicated model-choice limitation. Fixed the disabled-button tooltips this session
(`src/components/ComputerPanel.tsx`) to say "This model engine's driver doesn't mount computer
tools yet — switch to Claude or an ACP engine (Codex, Gemini CLI) to use it" instead of a vague
"cannot use cloud computer tools", so it reads as a model choice, not a bug.

**Not fixed this session (scoped, real, substantial):** wiring actual tool-calling into
`openai-compatible.ts` so the direct-API drivers can mount computer tools (and, per the
integration below, browser-use's MCP tools) too. Every OpenAI-compatible chat-completions API
supports the `tools`/`tool_calls` parameter, so it's *technically* buildable — it needs: MCP
tool schema → provider tool-calling schema translation, streaming `tool_calls` delta handling,
executing the call against the already-running MCP client, feeding the result back into the
loop. This is a real feature, not a quick fix — closest existing reference is however
`server/drivers/claude.ts` and `server/drivers/acp/core.ts` already do it for their protocols.

## browser-use (github.com/browser-use/browser-use) — MIT, genuinely integrable

Ships its own MCP server (`<!-- mcp-name: com.browser-use/browser-use -->` in its own README) —
an LLM-driven browser automation tool exposed over the same protocol Muster's own tools already
speak. Real integration path: mount it as an additional external MCP tool source, the same
pattern Muster already uses for Composio's connected-apps tools — not a rewrite, an addition.
Directly useful once (if) tool-calling lands in `openai-compatible.ts`, since it would let even
the direct-API-driven bots do browser automation without needing a Box/OpenSandbox/Local VM
desktop at all. Already usable *today* for Claude/ACP-engine bots, in principle, the same way
any other MCP server could be mounted — worth prototyping as a smaller first step than the full
direct-API tool-calling feature.

## ego-lite (github.com/citrolabs/ego-lite) — MIT, NOT a good integration candidate

Not a library or protocol — it's a separate, proprietary, macOS-only desktop browser app users
download themselves (`.dmg`, Apple Silicon/Intel), with its own bundled "skill" wrapper
(`skills/ego-browser/`) that other agent harnesses (Claude Code, Codex — visible in its own
`.claude/skills`, `.codex/skills` dirs) can install to drive it via a CLI. There's no open
protocol or embeddable code here to wire into Muster's own computer-backend architecture the
way Box/OpenSandbox/Local VM are — it's a competing product in the same "agent shares your
browser" space, not a dependency. Best treated as complementary, user-installed tooling
(mention it, don't adopt it), consistent with this session's standing decision not to adopt
third-party orchestration tooling (gstack/ruflo) as Muster's own.

## Recommendation, in priority order

1. Ship the tooltip fix (done this session) — cheap, immediately reduces the exact confusion
   the account's own bot just hit.
2. If computer-use parity across all 12 direct-API providers matters, that's the real project:
   tool-calling in `openai-compatible.ts`. Scope it as its own pass, not bundled into anything
   else — it touches the shared factory every direct-API driver depends on and needs the same
   live-testing discipline the rest of this session has held to.
3. Once that lands, mounting browser-use's MCP server is a small, high-value addition on top —
   plan it as a follow-on, not a prerequisite.
4. Do not adopt ego-lite as a dependency; it's not shaped for that.
