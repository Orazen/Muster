# Tier 1 — mobile companion & Watch

Method: README/bundle study via web fetch, 22 Sep 2026. Native Swift/SwiftUI focus — our companions are `ios/` (Swift) and `companion/`.

---

## cactus-compute/needle (2-bit models, 12.1k★)
- **What**: automation foundation model for tiny devices — 2-bit, 8–29MB, tool calls, structured extraction and embeddings on phones, wearables, smart homes.
- **Adopt**: on-device tool-call model for Watch/mobile autonomy without host round-trips (pairing-status checks, commitment extraction, unsent-draft classification). **Leave**: full pipeline; optional model file.
- **Attach**: `ios/CompanionCore` (new on-device module beside FleetSnapshot publishing), Watch extension targets.
- **Next**: check quantized sizes vs. Watch memory budget; measure extraction quality on commitment/duration text; keep provider credentials out — split-string fixture rule.

---

## rit3zh/expo-dynamic-notifications (138★)
- **What**: Dynamic Island–style in-app notifications for React Native.
- **Adopt**: interaction pattern only — the notification shape (needs-you precedence) maps to our Live-Activity/widget precedence; React Native code is not attachable. **Leave**: React Native implementation.
- **Attach**: `ios/` Live Activity + widget (`MusterFleetWidget`).
- **Next**: screenshot their notification shapes; note precedence rules; compare with our needsYou notification haptic contract.

---

## rgferreira/CodexWatch (Swift, 76★)
- **What**: Apple Watch + iPhone companion connecting to Codex through a private macOS bridge.
- **Adopt**: the private-bridge pattern — our Watch already reviews approvals through call-bound enrollment; a bridge with session pinning is the hardening idea. **Leave**: Codex-specific protocol.
- **Attach**: watch-call protocol (`docs/plans/watch-call-protocol-2026-09-19.md`), macOS bridge seam.
- **Next**: read bridge session pinning; test against our single-delivery call-bound enrollment for stale-delivery guards.

---

## b-nnett/codex-apple-watch (Swift, 102★)
- **What**: Watch client for Codex coding sessions.
- **Adopt**: approve/reject card shape on the wrist — compare with OptionCard-on-Apple-Watch flow. **Leave**: coding-session specifics.
- **Attach**: Watch approval review UI.
- **Next**: inspect card layout at 320px-equivalent wrist sizes; accept one synthetic approval end to end.

---

## john-rocky/coreai-kit (Swift, 110★)
- **What**: Swift SDK for running chat, vision and speech models on iPhone and Mac with Apple's Core AI — model download/caching, FoundationModels.
- **Adopt**: on-device chat/vision/speech for walkie + walkie tour — model download and caching seams are the gap. **Leave**: chat-UI glue.
- **Attach**: `ios/` CompanionCore (speech/vision), WalkieView.
- **Next**: check device support (WatchOS?) and download sizes; browser/simulator accept a turn with on-device TTS.

---

## ZSeven-W/rish-app (Objective-C++, 143★)
- **What**: pocket agent — local-first AI agents on iOS and Android with real workspaces, tool execution **with approvals**, and model choice.
- **Adopt**: competitor teardown — mobile workspace + approval-on-device flow pairs with the companion roadmap (Verify against `docs/plans/mustermobile-ios-plan-2026-09-17.md`). **Leave**: model-choice plumbing.
- **Attach**: `companion/` roadmap notes.
- **Next**: bundle study (tool-execution approvals on mobile); note exposures for competitive-landscape.

---

## uzairansaruzi/hermex (Swift, 1.4k★)
- **What**: native iPhone app for a Hermes agent.
- **Adopt**: mobile competitor teardown — how a native iPhone app presents bot state, notifications and approvals. **Leave**: Hermes protocol.
- **Attach**: `companion/` roadmap notes, competitive-landscape.
- **Next**: bundle study; note notification/approval flows.

---

## CodeUpdaterBot/Hermes-Mobile-App (TypeScript, 45★)
- **What**: mobile app for a fleet of bots — open source, runs against your own computer.
- **Adopt**: the self-hosted-against-own-computer pairing contract — compare with our pairing/claim contract (`/claim#CODE` vs `/pair#CODE` separation). **Leave**: React Native surface.
- **Attach**: `src/lib/pairing-link.ts` (planWorkspaceConnect teardown).
- **Next**: bundle study of its pairing flow; verify query-string codes are refused like ours.

---

## dylan-buck/Hermes-iOS (Swift, 82★)
- **What**: gives agents camera, mic, health data, location and notifications on iPhone.
- **Adopt**: sensor-permission shape — which sensors a fleet worker may request, and how consent is recorded. Pairs with the assistant-beta "Watch calling and Plan my day" decisions. **Leave**: health data (privacy + review risk).
- **Attach**: `ios/` CompanionCore (consent recording per sensor).
- **Next**: read permission/consent seams; design-study note on fleet-requested sensors with human consent per use.
