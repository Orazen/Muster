# Tier 1 — web/desktop/tray UX & companion product

Method: README/bundle study via web fetch, 22 Sep 2026. Preserve the approved layout — teardowns inform behavior, never redesign (`docs/guides/web-app-stability.md`).

---

## milind-soni/tiptour-macos (Swift, 645★)
- **What**: open-source fast local computer use (macOS pointer).
- **Adopt**: pointer-automation teardown for a future bot-computer slice. **Leave**: integrating now — bots are CLI/ACP; computer use is a ranked-later differentiator.
- **Attach**: future slice design doc; `docs/plans/competitive-landscape.md` exposure.
- **Next**: read how it does fast local pointer moves; compare with OS-accessibility paths (see agent-desktop below).

---

## qunqin24/Pulse (Swift/AppKit, 414★)
- **What**: floating macOS monitor for how much Claude Code/Codex/Antigravity/OpenCode/Kimi you have left.
- **Adopt**: usage-monitoring UI teardown for inclusion-allowance reservations/accounting (numerical cost approval open item). **Leave**: Sparkle updater glue.
- **Attach**: allowance accounting panels (Providers panel honesty per Loop136), tray window.
- **Next**: screenshot their limit UI; note honest "loading/unknown" states; map to reservation panels.

---

## LeoNatan/LNPopupController (Objective-C++, 3.1k★)
- **What**: present view controllers as popups of other view controllers (Apple Music mini-player).
- **Adopt**: mini-player pattern for a bot-call mini popup in the companion (walkie mini popup). **Leave**: Swift rewrite — this is a pattern reference for our SwiftUI companions.
- **Attach**: `ios/` call view.
- **Next**: simulate the mini popup feel; accept one synthetic walkie turn with mini popup open.

---

## mattt/iMCP (Swift, 1.6k★)
- **What**: macOS app providing an MCP server over your Messages, Contacts, Reminders and more.
- **Adopt**: native connected-apps tier — installable MCP servers as connected apps (our connector runtime + MCP client loop exist; a native-MCP tier is the gap). **Leave**: bundling.
- **Attach**: `server/openconnector.ts` runtime contract (MCP session forwarding already exists).
- **Next**: probe its MCP surface in catalog mode; verify {success,data}-shaped envelopes map to branded cards.

---

## anywhere-labs/Agents-Anywhere (TypeScript, 1.1k★)
- **What**: open-source cross-device agent workbench — control coding agents from your phone (ACP).
- **Adopt**: phone-control contract teardown — pairs with remote-access client mode (the genuinely missing OMB surface in remaining-work-plan §3). **Leave**: implementation.
- **Attach**: `src/components/RemoteAccessSection.tsx` teardown.
- **Next**: bundle study; note pairing code modes vs. our 6-digit companion code and self-hosted 12-char links.

---

## Marcus-Mok-GH/nova-cloud-computer (TypeScript, 7★)
- **What**: AI-agent-powered personal cloud computer — persistent workspaces, chat, file & task management, scheduled automations, sandboxed agent execution.
- **Adopt**: Goal-mode computer shape — bounded computer for automation turns (Goal mode bounded autonomy). **Leave**: cloud persistence (Drive/Telegram-only storage direction).
- **Attach**: `server/routines.ts` + automation turns.
- **Next**: read sandbox-execution seams; note scheduled-automation guards; compare with our automationSource webhook turns.

---

## covertggtv-a11y/omb-budget-extension-look (HTML, 7★)
- **What**: LOOK-only OpenMausBot budget-extension spend-decision card.
- **Adopt**: the spend-decision-card pattern — direct reference for numerical cost approval (open item: "included allowance reservations and numerical cost approval remain open"). **Leave**: OMB budget extension logic.
- **Append to**: OptionCard pattern (`docs/plans/astra-gpt6-mvp-brief.md` capability table).
- **Next**: screenshot the card; note quorum/amount fields; design a Muster-own spend OptionCard; assert no auto-approval grant.

---

## milind-soni/openmausbot-teams (13★)
- **What**: community team templates and skill playbooks for OpenMausBot.
- **Adopt**: content source for the team-library loop already in flight (uncommitted inherited work: team-library/manifest/markdown). **Leave**: OMB file format drift — our markdown import handles it.
- **Attach**: team library import (`src/lib/team-import.ts` seam).
- **Next**: fetch a few templates; check our markdown importer round-trips them; preserve the inherited loop's ownership.

---

## BetterWright/betterwright (315★)
- **What**: persistent, policy-guarded Playwright browser for AI agents — network policy, encrypted credential vault, proof screenshots, CAPTCHA solving.
- **Adopt**: credential-vault + proof-screenshot patterns for bots' web actions (Vaultgram exists in lockfile changes; agent-web-actions is a later slice). **Leave**: CAPTCHA solving (policy risk).
- **Append to**: browser tooling design notes; competitive-landscape exposure.
- **Next**: read the vault encryption + proof-screenshot contracts; note what a browser-action audit entry needs.

---

## legeling/awesome-codex-pet (990★)
- **What**: curated gallery of community desktop pets with generated action previews and one-command installation.
- **Adopt**: installable-pet-actions marketplace pattern — pairs with our marketplace surface and mascot actions (actions with generated previews + one-command install). **Leave**: pixel-art style (Flower mascot contract outranks).
- **Attach**: mascot actions + marketplace listing format (`src/lib/mascot/`, marketplace panels).
- **Next**: inspect listing format + preview generation; design-study note for installable mascot action packs; keep calm-mode off-switch contract.

---

## nilbuild/page-mascot (Python, 772★)
- **What**: a mascot that watches the cursor and blinks when you poke it.
- **Adopt**: cursor-awareness behavior — our poke/annoyed exists; cursor-follow presence is the presence gap (presence vs. presence). **Leave**: implementation.
- **Append to**: `src/lib/mascot/` behavior contract.
- **Next**: check gaze rules (rules: gaze targets precedence, blink cadence); prototype behind a flag; keep web/reducer sync with the tray-state module.

---

## HazAT/glimpse (JavaScript, 966★)
- **What**: native micro web UI for scripts and agents — fast OS-native webview with bidirectional JSON.
- **Adopt**: micro-webview pattern for the desktop tray companion (tray.html is a second Vite entry — a lighter JSON-driven surface is the hardening idea). **Leave**: new framework.
- **Append to**: `src/tray-main.ts` notes.
- **Next**: probe the JSON contract; compare poll cost vs. our visible-while polling pause behavior.

---

## thomasbek3/hermes-bot-kit (158★)
- **What**: fleet chat with iMessage-style bubbles + a live window into the fleet's computers.
- **Adopt**: two teardowns — (1) bubble style for 1:1 conversation, (2) live computer window for InspectorPanel. **Append to**: InspectorPanel teardown notes.
- **Next**: screenshot live window; note which observation entries map to computer-observation counters.

---

## jonathanroomer/NightBloodRemote (Swift/WebGL/WebRTC/Blender, 76★)
- **What**: iPhone companion giving voice models a face and personality.
- **Append to**: walkie visual-identity design notes (walkie currently dictation/TTS foreground journey; face + personality is the presence gap).
- **Next**: read avatar-face seams; check WebGL cost on a disposable simulator; design-study only — no provider credentials.

---

## OpenBMB/VoxCPM (37882★) and OHF-V/piper1-gpl (5653★)
- **What**: tokenizer-free TTS with voice cloning (VoxCPM); fast local neural TTS (piper).
- **Append to**: voice-identity design notes — cloned voices for named workers (user's own voice, human-consent) vs. offline piper for walkie/Walkie on-device.
- **Next**: check licenses; simulator accept one turn with local TTS; never ship provider voice cloning without human consent + OptionCard.

---

## ghostiee-11/nyang (Swift + SpriteKit, 5★)
- **What**: pixel cat on your Mac — moods, eye-follow, typing reactions, AI chat, Pomodoro.
- **Append to**: mascot typing-reaction behavior (work-state reactions exist; typing/keyboard reactions are presence). Prototype behind a flag; keep calm-mode contract.
