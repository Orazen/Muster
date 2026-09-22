# Tier 1 — infrastructure, privacy & release plumbing

Method: README/bundle study via web fetch, 22 Sep 2026. Credentials from env/secrets only; never commit literals.

---

## aayushch/laya (Python, 44★)
- **What**: local-first AI notification command center — aggregates Slack, Gmail, GitHub, Jira, Notion, Outlook, Calendar notifications via Ollama/LM Studio, BYOK.
- **Adopt**: notification-aggregation contract for the assistant-beta "Plan my day" flow — a command-center shape over connected-app notifications (read-only). **Leave**: implementation; we have the connector runtime.
- **Attach**: notification seams per connected app (read-only surfaces).
- **Next**: probe its aggregation shape; note honest states (quota-exhausted, not answering yet — podman retry-window style).

---

## ghuntley/underclass (Rust, 152★)
- **What**: OpenAI-compatible pooling proxy — pins sessions to one account (prompt cache warm), cools quota-exhausted subscriptions until their window resets, fails fast with the earliest Retry-After.
- **Adopt**: quota-cooling + earliest-Retry-After semantics for inclusion-allowance reservations and automatic-retry opt-in (Loop136 retry requires a failed quota turn with no progress — cooling state is the missing accounting). **Leave**: pooling-proxy deployment.
- **Attach**: `server/index.ts` retry seam (persisted opt-in), allowance accounting.
- **Next**: read cooling-state format; prototype per-provider cool state; assert Stop/new-work/revoke still invalidate pending retries.

---

## arikchakma/opencloak (TypeScript, 35★)
- **What**: swap personal details out of AI prompts before sending — on-device detection, no server, no account (WebGPU).
- **Adopt**: PII-removal pass before relayed BYO-key turns (cloud-relay flagship: prompts leave the device — a device-side scrub pass is a hardening idea, pairs with the pending-assistant beta). **Leave**: chrome-extension shell.
- **Attach**: turn-assembly seam before provider dispatch.
- **Next**: inspect detection rules; benchmark scrub latency; keep out of provider credentials; note residual-risk honesty (residual risk: no scrub is complete).

---

## rorkai/App-Store-Connect-CLI (Go, 7.3k★)
- **What**: fast, scriptable CLI for the App Store Connect API — TestFlight, builds, submissions, signing, analytics, screenshots, subscriptions.
- **Adopt**: release-automation plumbing for currently owner-gated legs (TestFlight review status; advance-beta.cjs periodic re-run). **Leave**: anything that bypasses Apple review.
- **Attach**: `scripts/owned-ios-acceptance.mjs` + release workflows.
- **Now**: run periodic status read-only; never submit on the owner's behalf without instruction.

---

## BetterWright/betterwright (TypeScript, 315★)
- **What**: persistent, policy-guarded Playwright browser for AI agents — network policy, encrypted credential vault, proof screenshots.
- **Adopt**: vault + proof-screenshot contracts for bot web actions (also in tier1-ux — infrastructure because the vault is credentials plumbing). **Append to**: browser-actions design notes.
- **Next**: read vault encryption contract; note what an audit entry needs (URL allowlist, screenshot hash).

---

## wechaty/wechaty (TypeScript, 23.3k★)
- **What**: conversational RPA SDK for chatbot makers — one SDK, many networks (WeChat, WhatsApp, Telegram, Slack...).
- **Adopt**: channel-expansion candidates beyond WhatsApp/Telegram (Loop160 shipped Telegram; other networks not started). **Append to**: remaining-work-plan OMB-parity exposure.
- **Next**: check network support + maint status; pick one network for a bounded webhook leg with `TELEGRAM_CHAT_ENABLED`-style kill switch.

---

## buzzkit-dev/buzzkit (TypeScript, 378★)
- **What**: open-source notification orchestration layer.
- **Append to**: companion push orchestration notes — precedence, throttling, per-device routing (throttle FleetSnapshot publish contract exists; push-side routing is the gap).
- **Next**: probe orchestration API; note throttled push rules; simulator accept a throttled push.

---

## langgenius/mosoo (TypeScript, 150★)
- **What**: open-source Agent Gallery and Gateway for Codex, Claude Agent SDK, OpenCode — publish an agent once behind one HTTP API; users discover and run.
- **Append to**: marketplace/bot-marketplace parity — listing + one-API gateway format (bot marketplace exists; gateway format is the parity gap).
- **Next**: read listing schema; compare with marketplace panels; note per-account scoping invariants (hosted-installation wall advertisement ahead of the installation wall).
