# Muster — Competitive Landscape, Integration & Monetization Plan
_Compiled from a live audit of `Orazen/Muster` plus `elie222/rakazo`, `milind-soni/OpenMausBot`,
`sub8bot/Sub8`, and `elie222/botdirectory.ai` on 2026-08-19._

## 1. Landscape

All four external repos operate in the exact same niche as Muster: **"open-source Grok Bot
alternative — bring-your-own-model roster of persistent AI teammates."**

| Repo | Stars | License | Core idea | Platforms |
|---|---|---|---|---|
| **Muster** (ours) | new | **BSL 1.1** (converts to Apache-2.0 in 2030; SaaS-resale by others prohibited until then) | BYO-CLI roster (Claude/Codex/Grok/Gemini/Kimi/Qwen/Hermes/Droid/Antigravity/OpenCode), local harness on `127.0.0.1`, cloud/local computer per bot, Composio apps | macOS + Windows (Electron), **native Swift iOS app + AppStore assets already in repo**, Expo Android companion |
| rakazo | 875⭐ | Apache-2.0 | Persistent bots, shared/private "Team Computers", Docker/E2B/Daytona sandboxes, Composio, Pi for BYO model | Web, Electron, Expo mobile |
| OpenMausBot | 1264⭐ | MIT | BYO-agent chat app, VM per bot | Electron (mac/win/ubuntu) |
| Sub8 | 23⭐ | MIT | One isolated Linux Docker desktop per bot, octopus mascot/branding, screenshot+mouse+keyboard automation | Electron (mac/win/linux), signed+notarized builds |
| botdirectory.ai | 47⭐ | MIT | **Not a competitor — a content/SEO directory** of ready-made bot prompts (markdown files, PR-based contribution, public API) for Grok Bot/Rakazo/any agent | Astro static site |

**Key takeaway:** Muster is already the most feature-complete of the four bot-runner projects —
it already ships native iOS (Swift) + Android (Expo) companions with App Store submission
material (`ios/AppStore/*`) that rakazo/OpenMausBot/Sub8 don't have this polished. The real gap
isn't code, it's **distribution and packaging steps that require human-owned accounts**
(Apple Developer Program, Google Play Console) which I cannot create on your behalf.

## 2. Feature gaps worth borrowing (all permissive licenses — MIT/Apache-2.0, attribution-friendly)

1. **From Sub8**: per-bot *isolated Linux desktop* via Docker with screenshot+mouse+keyboard driving —
   Muster already has "a real computer" concept; worth checking parity on isolation guarantees and
   mascot/personality polish (Sub8's octopus rail is a strong branding idea we can adapt, not copy).
2. **From rakazo**: multi-sandbox backend support (Docker **and** E2B **and** Daytona, not just one),
   and "Pi" as a BYO-model credential broker — gives users more hosting choice, which lowers friction
   for non-technical users who don't want to run local sandboxes.
3. **From OpenMausBot**: nothing structurally new vs Muster's engine list, but its 1264⭐ vs our 0⭐
   is proof this niche has real demand — worth mirroring their README hero/positioning pattern and
   cross-linking.
4. **From botdirectory.ai**: **directly reusable as a growth channel, not a code dependency.**
   It's a public directory + API of ready-to-paste bot prompts. We should (a) submit Muster-compatible
   prompts to `botdirectory.ai/bots/*` via PR (2-minute contribution flow, per its CONTRIBUTING.md),
   and (b) optionally build our own `muster.orazen.online/bots` directory using the same open-source
   Astro pattern, seeded from Muster's own bot templates (the "Give each bot a job" roster section we
   just shipped to the landing page).

## 3. Mobile: iOS & Android status (already built, blocked on YOUR accounts, not code)

- **iOS**: native SwiftUI app in `ios/App`, full App Store Connect asset kit already in
  `ios/AppStore/` (description, keywords, screenshots, privacy answers, review notes,
  `RELEASE.md` runbook). **Blocked only on:**
  1. Apple Developer Program enrollment ($99/yr) under your account.
  2. Registering bundle ID `com.muster.companion` + creating the App Store Connect record.
  3. A Distribution certificate + provisioning profile (needs your Mac + Xcode, or CI secrets).
  Once you give me an Apple Developer Team ID and a way to sign (either your Xcode locally, or
  App Store Connect API key + cert secrets in GitHub Actions), I can drive `xcodegen generate` →
  archive → upload → TestFlight in one pass — the runbook is already written.
- **Android**: Expo/React Native companion in `android-companion/`, `eas.json`/`app.json` already
  configured (bundle `com.muster.companion`, permissions, icons). **Blocked only on:**
  1. An Expo account + `eas build -p android` (needs `EXPO_TOKEN`).
  2. A Google Play Console account ($25 one-time) to actually publish (or we ship the `.apk`/`.aab`
     directly from GitHub Releases for sideloading immediately, no Play account needed).
  I can produce a signed `.apk` today via EAS **once you give me an Expo access token**, and publish
  it to GitHub Releases even before a Play Store listing exists.

## 4. Monetization strategy (this is the actual "make money" plan)

Muster is BSL 1.1-licensed and local-first. Correction from an earlier draft of this doc: Muster
is **not** MIT — BSL 1.1 already prohibits anyone else from offering Muster (or a substantially
similar product) as a managed SaaS on infrastructure they control, until the Change Date
(2030-08-19, when it converts to Apache-2.0). That's a real, already-in-place moat against a
competitor cloning the repo and reselling it as their own hosted service — you don't need to build
anything for that protection, it's already in the LICENSE file. It does **not** mean the core can be
paywalled for the Licensor's own use (BSL restricts licensees, not the copyright holder — Muster's
own team can run/sell `muster.orazen.online` however they like). Revenue still has to come from
**layers around the free-to-self-host core**, mirroring how rakazo/Cursor/other open-core AI tools
monetize, but the SaaS-competition risk that MIT would have left wide open is already closed:

1. **Hosted "Muster Cloud" tier** (highest-leverage, matches rakazo's Docker/E2B/Daytona idea):
   sell managed cloud computers per bot (pre-warmed sandboxes) as a subscription, so non-technical
   users don't need Docker locally. This is the single biggest revenue lever — recurring SaaS,
   not a one-time app sale.
2. **Bot template marketplace** (like botdirectory.ai but Muster-branded): free tier of prompts,
   paid "pro bot packs" (e.g. SEO improver, sales outbound, expense manager — we already wrote 8 of
   these into the landing page roster section) sold as one-time unlocks or subscription add-ons.
3. **Composio/integration revenue share**: Muster already wires into Composio's 500+ app connectors;
   worth checking if Composio has an affiliate/referral program for usage driven through Muster.
4. **App Store / Play Store presence** drives organic discovery for the free desktop app, which
   upsells into (1) and (2) — mobile apps themselves stay free (companion/pairing tools), not a
   direct revenue source.
5. **Orazen agency services**: since Orazen already does client AI/automation work, Muster becomes
   a proof-of-capability + acquisition funnel — "we build you a custom bot roster" as a service SKU,
   using Muster as the underlying product.
6. **Sponsorship/GitHub Sponsors** once the repo has traction (currently 0⭐ vs competitors' 23–1264⭐
   — cross-promotion via botdirectory.ai PR + README badges/backlinks is the fastest way to close
   that visibility gap before sponsorship is viable).

## 5. Recommended sequencing

1. ✅ Done: branch protection, landing page fix merged, v0.1.26 released, dashboard/domain healthy.
2. **This week (no blockers on my end):** submit 2–3 Muster bot prompts to `botdirectory.ai` via PR
   for free distribution; add a `docs/plans/` roadmap link from the README so contributors see the
   monetization direction.
3. **Needs you:** Apple Developer Team ID + signing method → I drive iOS TestFlight upload.
4. **Needs you:** Expo access token → I produce a signed Android `.apk`/`.aab` and attach it to a
   GitHub Release immediately (works even without a Play Console account).
5. **Needs a decision:** whether "Muster Cloud" (hosted sandboxes) is something you want to build/sell,
   since that's the highest-revenue item but also the biggest scope (billing, multi-tenant sandbox
   orchestration, ToS/privacy for hosted data).

## Open questions for you
- Apple Developer Team ID + how you want to sign builds (local Xcode vs CI secrets)?
- Expo/EAS account + token for Android builds?
- Do you want me to open the botdirectory.ai PR(s) now (I can do this immediately, no blockers)?
- Go/no-go and rough budget appetite for a hosted "Muster Cloud" tier?


## Addendum: stablyai/orca competitive intel (audited 2026-08-19)

`stablyai/orca` — **48,884⭐, MIT, YC-backed** (by far the largest project in this space we've
looked at). Different core positioning than Muster/rakazo/OpenMausBot/Sub8: Orca is an
**"AI Orchestrator for 100x builders"** — a developer IDE for running multiple coding-agent CLIs
(Claude Code, Codex, Grok, Cursor, Copilot, OpenCode) **in parallel git worktrees**, not a
"personal team of bots for any task" like Muster.

Key validated patterns worth noting (not code to copy — different product shape, but proof of
what scales in this market):
- **Mobile companion is a first-class feature**, not an afterthought — Orca has both a published
  iOS App Store app and a public Android APK download straight from GitHub Releases (exactly what
  we can do for Muster's Android companion right now without a Play Console account).
- **SSH/remote worktrees** — run agents on a remote box, not just local Docker — same idea as
  Muster's "cloud computer" but framed for coding workflows.
- **CLI-first**: `orca worktree create`, `snapshot`, `click`, `fill` — agents can drive Orca itself.
  Useful pattern for Muster: exposing a companion CLI for scripting bot lifecycle.
- 48k stars proves the "bring your own agent CLI, orchestrate many at once" category has enormous
  demand — reinforces the sequencing plan above (mobile ship + botdirectory.ai distribution) rather
  than changing Muster's core positioning, since Orca and Muster don't fully overlap (dev-worktree
  orchestration vs. general-purpose bot roster with computer-use).
