# Mistral Vibe engine slice

Muster registers `vibeAgent` through the shared ACP driver and includes a `vibe`
instance in the default product fleet. This brings the registered CLI/ACP engine
count to eleven: Claude, Codex, Antigravity, Grok, Gemini, Kimi, Droid, OpenCode Go,
Qwen, Hermes, and Mistral Vibe. Gemini remains opt-in; BoxAgent reuses Claude or
Codex and is not counted as another engine. API providers are counted separately.

## Setup and behavior

Install the `vibe-acp` executable following the
[official setup guide](https://docs.mistral.ai/vibe/code/cli/install-setup).
Provide `MISTRAL_API_KEY` through the environment, an instance environment entry,
or Muster's saved Mistral provider settings. Explicit instance values take
precedence, including an empty value. Native login detection is not implemented.
`VIBE_HOME` can select an existing Vibe configuration directory.

The default model choice uses Vibe's configured model. A supplied explicit model
must be a model identifier understood by that Vibe configuration; the integration
does not invent a remote catalog. Each new or resumed session sets `mode=default`
first, then selects an explicit model when needed, and checks the returned
`configOptions`. A missing or mismatched mode/model fails the turn before sending
the prompt. `session.started` records the model Vibe actually confirmed.

Vibe can send permission requests containing only a tool-call ID. The ACP adapter
retains bounded metadata from prior tool updates for the current turn so the
approval request still identifies the tool and command. Human allow/deny decisions
use the existing request lifecycle. Default mode enables Vibe's permission checks;
tool allowlists in the owner's Vibe configuration still apply. This is not a claim
that every tool invocation always asks the human.

The client does not advertise form elicitation; Vibe's form-based question tools
are therefore unavailable. Live provider authentication, a paid model turn, and
cross-engine task-quality parity are not verified by this slice.

## Evidence

Protocol fixtures exercise configured and explicit models, mode/model
confirmation failures, mode changes resetting models, model changes altering
approval mode, sparse permission metadata with human allow and deny, engine exit,
session resume, missing credentials/CLI, and bounded metadata retention. All
subprocesses use a fake ACP executable; no demo-server sessions are changed.

Implementation: `server/drivers/acp/vibe.ts`, `tool-context.ts`, the shared ACP
core, built-in registration, and config injection. Contract reference:
[Vibe ACP source](https://github.com/mistralai/mistral-vibe/blob/main/vibe/acp/agent.py)
and [configuration docs](https://docs.mistral.ai/vibe/code/cli/configuration).

The implementation was included in concurrent commit `6de16e8`; the follow-up
commit contains its verification, remaining fixes, and this evidence record.
