# TipTour → Muster integration study (2026-09-23)

Owner instruction: *"checkout https://github.com/milind-soni/tiptour-macos —
integrate this even in Muster accordingly."*

Read-only source audit of the already-cloned TipTour tree at
`/private/var/folders/j2/99fjlfmx07l3vvgrky5lp96m0000gn/T/opencode/tiptour-src`
(v0.3, `appcast.xml`), grounded in **their** `docs/source-layout.md` +
`docs/tiptour-agent-contract.md` + `AGENTS.md` and the actual Swift files, and
mapped onto the current Muster working tree (including its uncommitted
streams). This doc is analysis only — no Muster code was touched by this
study. No security claims are made anywhere below; the last full scanner run
is still owed per AGENTS.md.

**Honesty notes up front:**
- The repo contains **no video/GIF demo media** — only two marketing PNGs
  (`gemnew.png`, `dmg-background.png`). The "frames" under
  `docs/screenshots/tiptour/` are ffmpeg **crops** of those two PNGs (ffmpeg
  exists at `/opt/homebrew/bin/ffmpeg`; there was nothing to deframe). Notes
  per frame in §5.
- Their `AGENTS.md` prohibits terminal `xcodebuild` **to preserve TCC
  permissions in their repo's workflow**. That rule binds TipTour's repo; it
  does not bind Muster. Nothing in Muster builds Swift for TipTour anyway.
- Muster's "This Mac" desktop control **already exists** (embedded CUA driver
  in Electron). This study is therefore not "add desktop control"; it is
  "adopt TipTour's grounding/target-picker + guardrail patterns on top of the
  control Muster has, always behind Muster's approval cards."

---

## 1. TipTour teardown (feature/architecture)

### 1.1 What it is

macOS 14.2+ **menu-bar-only** SwiftUI/AppKit companion (`LSUIElement=true`),
two provider modes sharing one action engine (`Core/TipTourMode.swift`,
`AGENTS.md`):

| Mode | Shortcut | Behavior |
|---|---|---|
| **Gemini realtime** | Ctrl+Option | Voice about the screen; screenshots/mic to Gemini with the user's own Keychain key; **one desktop action per user turn**; point-only vs auto-click guidance. |
| **JEV text** (default) | Ctrl+K | Type a click task. TypeSafe `jev-latest` classifies **locally detected screen labels/locations**, picks click/double/right-click targets; bounded loop: `__none__` stop, done≥0.70 stop, cancellation, execution failure/pause, or **12 actions**, with a final observation after the last action. |

Other hotkeys: Ctrl+Shift paints focus context for Gemini;
Ctrl+Option+Command is a Speak/Type/Highlight radial chooser
(`UI/RadialInputSwitcherView.swift`, `Utilities/GlobalRadialInputShortcutMonitor.swift`).

### 1.2 Grounding pipeline (how controls are detected/ranked)

Layered, exact-first, documented in `AGENTS.md` and visible in
`Workflow/ElementResolver.swift`:

```
exact local target ID/mark (LocalPerceptionTargetCache)
  → AX tree            Perception/AccessibilityTreeResolver.swift   (~958 ln: batched AX reads, Jaro-Winkler label scoring, set-of-marks, empty-tree escape hatch)
  → browser DOM/CDP    Perception/BrowserCoordinateResolver.swift   (Chrome rect → AppKit coords)
  → local CoreML/OCR   Perception/NativeElementDetector.swift       (YOLO UIElementDetector.mlpackage + Apple Vision OCR; 1.5s live feed; label enrichment of YOLO boxes by OCR text)
  → Gemini screenshot coordinates (box_2d), no refinement            (ElementResolver.ResolutionSource.llmRawCoordinates)
```

- `Perception/LocalPerceptionTargetCache.swift` — the single snapshot the
  action resolver and JEV read: each target carries `id`, `mark`, `label`,
  `source` (`ax|browser|yolo|ocr`), confidence, screenshot box, **global
  screen point/box**, display frame, cache age; plus pixel↔global coordinate
  conversion and a source priority.
- `Perception/LocalTargetContinuity.swift` (~20 ln) — the same control is
  matched across small detector jitter by **IoU ≥ 0.6** with equal
  label/source/display, so a stale box can't become a different click.
- `Perception/ScreenshotPerceptualHash.swift` — screen-change detection for
  post-action validation.
- **JEV decision layer** (`Jev/JevGrounding.swift`, deliberately pure and
  TipTour-free so it can be tested standalone):
  - candidates are built **from detections, never invented**;
  - dedup identical descriptions + IDs, cap at **200** under the API's 255;
  - one bundled call: `state` + three questions — `done` (noul), `absent`
    (noul), `pick` (choice over candidates **+ `__none__` escape hatch**),
    `kind` (choice: click/double_click/right_click);
  - `decision(from:)` rejects anything malformed: unknown/invented target,
    out-of-range or non-finite probabilities, chosen probability not the max,
    invalid action kind. `__none__` → stop (`target_absent`), not
    runner-up-click. Tie handling honors the reported choice.
  - Measured rationale in-source: without `__none__`, an absent target still
    got clicked at ~0.71; with it, true negatives score ~0.96.
- `Jev/JevClient.swift` — TypeSafe API client (`api.typesafe.ai`,
  `jev-latest`), key from Keychain via provider closure, 255-choice cap,
  honest per-call metrics (ms, input tokens, model). `confidence` is
  documented as chance-corrected and shifting with candidate count — the code
  thresholds on **top probability/margin**, not confidence.
- `Jev/JevPointerLoop.swift` — the bounded loop: fresh detections per step,
  frontmost-app check (stops if the app changed), requires **both** the CUA
  action-driver toggle **and** auto-click, executes through
  `engine.runPointerAction(...)` with `validateStateChange: true` and one
  `trace_id`, appends completed history, stops on any failure reason.

### 1.3 Action engine (primitives + validation loop)

- `Workflow/WorkflowPlan.swift` — step schema: `click | rightClick |
  doubleClick | openApp | openURL | keyboardShortcut | pressKey | type |
  setValue | scroll | waitForState | observe`, tolerant LLM JSON parsing,
  `targetID`/`targetMark` preferred over fuzzy labels, `trace_id`
  (`TipTourActionTrace.makeID`).
- `Actions/ActionExecutor.swift` (~1164 ln) — the input facade:
  click/right/double, shortcut parsing (`cmd/shift/option/ctrl` + symbol
  forms), single keys, type-text (clipboard paste w/ pasteboard restore, or
  physical keys), set-value, scroll (line/page), open-app/open-URL (incl.
  Chromium remote-debugging args), target-app activation + window raise,
  pending text-replacement range for highlighted edits, **every action
  fails closed** when the action driver is disabled
  (`ensureActionDriverEnabled`). Delivered through
  `Actions/TipTourActionDriver.swift` (CUA driver).
- `Workflow/WorkflowRunner.swift` (~1702 ln) — pauses/resume/skip/retry,
  per-operation tokens, target resolution with a retry budget, app-activation
  watching (plan invalidated when the target app changes), **blocking-modal
  dialog detection**, AX fingerprinting, canvas-app heuristics, post-action
  checks (settlement wait + screenshot/perceptual-hash), event logs with
  metadata for the trace.
- Toggles (`Utilities/TipTourDefaults.swift`): `isAutopilotEnabled`
  (auto-click; default on), `isCuaActionDriverEnabled` (desktop actions
  master switch; default on), `isScreenshotStreamingEnabled` (remote images
  only — local perception unaffected), `isAccurateGroundingEnabled`
  (debug overlay), `hasScreenContentPermission`.

### 1.4 Overlay / panel UI

- `UI/MenuBarPanelManager.swift` — **NSStatusItem** menu-bar icon + panel.
- `UI/TextCommandPanelManager/View` — cursor-following, resizable Ctrl+K
  panel; never dismissed on submit (only Escape), Stop button cancels;
  `Jev/JevStepPanelView.swift` shows the live decision: top-5 probability
  bars, chosen mark, done/absent, step n, tokens/ms, one-line note.
- `UI/DetectionOverlayView.swift` — debug boxes over the screen: neon green =
  CoreML, cyan = OCR, hot pink = highlighted; pulsing 30fps canvas; cursor
  "bubble" that snaps to the target under the pointer.
- `UI/CompanionPanelView.swift` / `FloatingCompanionPanel.swift` /
  `CompanionResponseOverlay.swift` — compact mode hints, permission rows,
  auto-click/point-only controls; `UI/NekoCursorView.swift` + `NekoSprites/`
  — a cat cursor mascot (Clicky lineage).
- `UI/TipTourSettingsView.swift` — sidebar sections: **Models** (only the
  selected mode's key field), **Desktop actions** (CUA + autopilot),
  **Privacy** (screenshot streaming), **Permissions** (AX / Screen Content /
  mic rows with deep links), **Advanced** (debug overlay, panel pin, Neko).

### 1.5 Permissions + Keychain

- `Utilities/WindowPositionManager.swift` — the presentation-destination
  pattern: **one permission path per tap** — `alreadyGranted` → no-op;
  `systemPrompt` → `AXIsProcessTrustedWithOptions(prompt:true)` /
  `CGRequestScreenCaptureAccess()` **once per launch**; after that
  `systemSettings` → deep-link `x-apple.systempreferences:…Privacy_Accessibility`
  / `…Privacy_ScreenCapture`, plus "reveal app in Finder" for the AX list.
  Screen Recording also has a **last-known-granted session fallback**
  (`CGPreflightScreenCaptureAccess()` can false-negative).
- `UI/CompanionPanelView.swift` / `TipTourSettingsView.swift` —
  `AVCaptureDevice.requestAccess(for: .audio)` only for Gemini; JEV needs no
  mic (`TipTourMode.permissionsReady`).
- **What each permission drives** (their README): Accessibility = inspect +
  control apps; Screen Content/Screen Recording = screenshots **and local
  detection** (not video recording — they state there is no recording
  pipeline); Microphone = Gemini voice only.
- `Utilities/KeychainStore.swift` — `kSecClassGenericPassword`, service =
  bundle ID, account = key name, `kSecAttrAccessibleAfterFirstUnlock`, **no
  iCloud sync**, empty write = delete; two keys: `geminiAPIKey`,
  `jevAPIKey`. UI must surface Keychain errors accurately (`AGENTS.md`).

### 1.6 Update channel

`appcast.xml` = Sparkle RSS (EdDSA-signed DMGs, `SUPublicEDKey` in build
settings) fed by `scripts/release.sh` (bump → xcodebuild archive → sign →
dmg → notarize → appcast → GitHub release to `tiptour-releases`). Versions
0.1–0.3, macOS ≥ 14.2.

### 1.7 Agent contract + test harness

- `docs/tiptour-agent-contract.md` + `Core/TipTourAgentContract.swift` +
  `Harnesses/TipTourHarnessServer.swift`: **localhost `127.0.0.1:19474`**
  only. Canonical loop: `GET /v1/observe` → `POST /v1/visual-context` →
  `POST /v1/ground-target` → `POST /v1/act` (exact targetID/mark) → read
  result / `GET /v1/action-history`; `POST /v1/workflow-plan` accepts
  **exactly one action**; `/v1/tasks` only for deterministic sequences;
  `/v1/targets` + `/v1/screenshots` are debug. Rules worth quoting:
  *one action per request; wait for validation; failed exact ID must not
  fall back to a nearby label; **"Do not click password, 2FA, payment,
  consent, or credential-finalization controls automatically."***
- `scripts/test-jev.sh` — the isolated harness: mktemp SwiftPM package,
  copy **only the pure files** (`JevClient`, `JevGrounding`,
  `LocalTargetContinuity`, `TipTourMode`, `KeychainStore`) + the test file,
  `swift test` — no build/sign/launch, so TCC stays intact. Backing tests in
  `TipTourTests/JevTests.swift` cover: continuity jitter vs different
  controls, default mode, mic-only-for-Gemini, 200-cap + `__none__` presence,
  duplicate/reserved ID crash-safety, `__none__` stops instead of clicking
  the runner-up, **no confidence/probability cutoff**, invented target /
  invalid action kind / incomplete responses rejected, tie honoring,
  missing key fails **before** any network call.

### 1.8 License

`LICENSE` = **MIT, Copyright (c) 2026 Milind Soni, Portions Copyright (c)
2025 Farza (Clicky, the upstream project TipTour forked from)**. Plus
`TipTour/NekoSprites/LICENSE-NEKO.txt` for the cat sprites.

---

## 2. Integration mapping onto Muster

Status vocabulary: **ALREADY-EQUIVALENT** (Muster has its own equivalent —
cite), **ADAPTABLE** (their shape → Muster shape), **REAL-GAP** (Muster lacks
it). Landing zones considered: (a) Electron desktop control behind approval
cards, (b) menu-bar companion, (c) JEV grounding as target-picker,
(d) Keychain/permission/settings UX.

### 2.1 Mapping table

| # | TipTour piece | Status | Muster equivalent / destination |
|---|---|---|---|
| 1 | Desktop input primitives (click/right/double/type/shortcut/key/scroll/open app/URL) | **ALREADY-EQUIVALENT** | `electron/cua.mjs` + `electron/cua-runtime.mjs` (embedded CUA driver, TCC inherited by `com.muster.app`) → descriptor `cua-connection.json` → `server/local-computer.ts`; cloud/box twin `server/computer-proxy.ts` (`click`, `type_text`, `press_key`, `scroll`, `open_url`, `computer_batch`, `computer_exec`, `screenshot`, `browser_*`). |
| 2 | Action gating: autopilot + CUA master toggle | **ALREADY-EQUIVALENT (Muster stronger)** | Session gate `enableComputerAccess` behind `electron/computer-access-sender.mjs` sender check + per-bot Off (`ComputerPanel.tsx`), surfaced by `src/components/DesktopCapabilities.tsx` / `src/lib/desktop.ts`. |
| 3 | **Human approval of every consequential action** | **ALREADY-EQUIVALENT (TipTour has nothing like this)** | `server/index.ts` `request.opened` → OptionCard message with `rehearsal` (plan rehearsal), `why` (`server/approval-why.ts`), `history` (`server/approval-history.ts`), `allowKey` (`server/auto-approve.ts`) → `src/components/OptionCard.tsx` / `ApprovalCard.tsx` / `PendingApproval.tsx`; Watch one-tap Allow/Deny in `ios/Watch/WatchViews.swift`. **This is the contract TipTour integration must not weaken.** |
| 4 | Menu-bar/desktop companion surface | **ALREADY-EQUIVALENT (different shape)** | Floating tray companion: `electron/main.mjs` (`trayWindow`, `registerTrayIpc`, View-menu toggle) + `tray.html` (framework-less mascot surface). No `NSStatusItem`-style tray **icon** yet (no `new Tray` anywhere in `electron/`) — see (b) below. |
| 5 | Secret storage (device-local, no sync) | **ALREADY-EQUIVALENT** | Electron `safeStorage` → `credentials.bin` (`electron/main.mjs` L111–125, Keychain-backed on macOS); server-side per-user provider vault `server/agent-vault.ts` (encrypted at rest); backup/sync **passphrase gate** being built right now (routes at `server/index.ts` ~L8374+, `server/workspace-backup-routes.ts`). |
| 6 | Update channel | **ALREADY-EQUIVALENT** | `electron/updater.mjs` (electron-updater, button-driven, honest ad-hoc-signing caveat) + `electron/updater-coordinator.mjs` + `electron/release-feed.*`. **Do not port Sparkle/appcast.** |
| 7 | Voice mode ("talk to your screen") | **ALREADY-EQUIVALENT (partial)** | Muster voice: `src/components/VoiceSettings.tsx`, `VoiceFirstRunCard`, `CallView`/`GroupCallView`, `server/tts/*`, Apple-speech dictation (`src/lib/desktop.ts` `dictation`). TipTour's *screen-aware, one-desktop-action-per-turn* framing does not exist in Muster — gap row 20 below, low priority. |
| 8 | Bounded external-agent contract | **ALREADY-EQUIVALENT** | `server/fleet-mcp.ts` (11 bounded tools, `send_task` the only writer, receipts/why/scorecard reads) + `PLAN TOOLS` turn discipline in `server/index.ts` L2370. Their localhost `:19474` harness is the same idea with weaker boundary — do not add a second one. |
| 9 | Portable per-app markdown skills | **ALREADY-EQUIVALENT** | `skills/` (Muster) vs `TipTour/Skills/**/SKILL.md`. |
| 10 | Permission messaging on enable | **ALREADY-EQUIVALENT** | `src/components/DesktopCapabilities.tsx`: "macOS may ask for Accessibility and Screen Recording permissions" + enable/refresh flow; driver-side `sdk.requestMacOSPermissions()` in `electron/cua-runtime.mjs` fails closed when missing. |
| 11 | Jev-style pure decision module pattern (software enumerates candidates with unique IDs → deterministic/explainable rank → model or human only chooses) | **ALREADY-EQUIVALENT** | `server/jev-dispatch.ts` (+ `jev-dispatch.test.ts`, committed, imported by `server/index.ts` L50) — Muster's Chief-of-Staff team dispatch is exactly this pattern ("candidates enumerated by software, ranking deterministic, nothing here calls a model"), pure and unit-tested. **Different domain (bot lineup, not screen targets)**, but it is the house precedent slice 1 extends — and it already exports a type named `JevCandidate`, a naming collision to avoid. |
| 12 | JEV grounding core for screen targets (candidates, dedup, `__none__`, done/absent/kind, strict decision validation, no confidence cutoff, 200 cap) | **ADAPTABLE (c)** | New **pure TS** module `server/desktop-grounding.ts` (see slice 1) — port `JevGrounding` + the decode half of `JevClient` + `LocalTargetContinuity`, in `jev-dispatch.ts` house style but with distinct type names. Candidate lists already exist in Muster wire shapes: `server/computer-proxy.ts` L400 `elements: [{ref, role, name, disabled}]` (browser tree) and CUA desktop state for This Mac (verify its exact element shape when wiring slice 2). |
| 13 | Suggested-action list on approval cards | **ADAPTABLE → the core of (a)** | Ground the bot's proposed desktop step against real detected targets; present the ranked, grounded options **as the OptionCard's tappable options** (`src/components/OptionCard.tsx` + card shape in `server/contracts.ts`), each answered through the existing respond path (`/api/bots/:id/respond`, `server/index.ts` ~L7652+) and Watch options. **Never executed without a human tap** — Muster's `autoDecision` may still short-circuit routine *tool-permission* cards exactly as it does today; a **desktop click suggestion is a choice list, not an auto-allow**. |
| 14 | Live decision bars (JevStepPanelView: top-5 bars, step n, tokens/ms, note) | **ADAPTABLE** | Render grounded candidate bars inside the pending card next to the existing `rehearsal`/`why` blocks (`src/components/ApprovalWhyDetails.tsx`, `src/components/PendingApproval.tsx`) — evidence, not a verdict, same rule as `approvalHistory`. |
| 15 | Permission presentation: prompt-once → System Settings deep link, "reveal app in Finder", last-known-granted session fallback | **ADAPTABLE (d)** | `src/lib/desktop.ts` + `DesktopCapabilities.tsx` enable flow gains the destination pattern (system prompt first tap, `x-apple.systempreferences` deep link after). Electron precedent for TCC-sensitive requests: `electron/cua-runtime.mjs`. |
| 16 | Guardrails: stop on app switch, 12-action step budget, settlement wait + post-action check, modal-dialog detection, IoU continuity | **ADAPTABLE** | Turn-scoped budget/stop hints around This-Mac computer tools (`server/index.ts` tool loop + prompt copy) and continuity helper in `server/desktop-grounding.ts`. Muster's cloud tools already return the resulting screen (`server/computer-proxy.ts` header comment) — the local-Mac loop's settlement behavior must be verified, not assumed (see row 21). |
| 17 | Harness test pattern (pure files → isolated package → tests, no app launch) | **ADAPTABLE (as methodology)** | Keep the ported grounding module free of Electron/server imports so `npx vitest run server/desktop-grounding.test.ts` mirrors `scripts/test-jev.sh`'s isolation. Muster already owns this pattern (`server/*.test.ts`). |
| 18 | **Local target grounding Muster can own**: AX tree resolver + YOLO/OCR detection + browser CDP resolver + perception cache + detection overlay | **REAL-GAP (a)/(c)** | Muster's This-Mac flow depends on the CUA driver's own desktop state; Muster has **no** owned label→target grounding layer, no `ground-target` equivalent, no detection overlay. Do not rebuild TipTour's AX/YOLO stack first — consume CUA/desktop-state elements; only consider an owned detector if that shape can't ground labels (verify in slice 2). |
| 19 | Menu-bar **status item** with quick command + attention badge | **REAL-GAP (b)** | Only the floating tray window exists. Honest call: an Electron `Tray` icon **is** the right home if we build it (precedent: `electron/main.mjs` `registerTrayIpc` + `tray.html`; the View menu already toggles the companion), and surfacing *pending approval count* there serves the approval moat. But it's cosmetic-plus-alerting, not capability — **rank last and only after the parity agent's `electron/main.mjs` work lands** (§3 conflict flags). |
| 20 | Screen-aware voice turn (one desktop action per turn) | **REAL-GAP (low value)** | Would bolt screen context + a one-action turn onto Muster voice calls. Not in the brief's ranked slices; note it and defer. |
| 21 | Post-action visual validation **owned by Muster** for This-Mac actions (perceptual hash / re-detect / continuity check before the next click) | **REAL-GAP (verify first)** | Cloud tools self-validate by returning the frame; the embedded CUA path's settlement guarantee needs an evidence check before claiming parity. Until then, treat slice 3's continuity + budget guards as the safety net. |

**Counts: ALREADY-EQUIVALENT = 11 · ADAPTABLE = 6 · REAL-GAP = 4 (21 rows).**

### 2.2 The four landing zones, decided

**(a) Electron desktop control behind approval cards — the mission.**
Muster already has the control plane (`electron/cua.mjs`,
`server/local-computer.ts`). What TipTour adds is the *grounding vocabulary*
(JEV's pure decision layer) so a bot's desktop proposal can be resolved
against **real, detected screen controls** and offered to the human as a
**suggested action list** on the existing card — `OptionCard` options tapped
by the user (web) or Watch (`ios/Watch/WatchViews.swift`), answered through
the existing respond route. Auto-execution is never introduced; the card,
not the model, is the actuator. Files touched: `server/desktop-grounding.ts`
(new), `server/index.ts` (card build), `server/contracts.ts` (card shape),
`src/components/OptionCard.tsx`, `ApprovalCard.tsx`, `PendingApproval.tsx`.

**(b) Menu-bar companion — out of scope for now, defensible later.**
Electron's `Tray` would live in `electron/main.mjs` next to the existing
tray-window precedent (`trayWindow`, `registerTrayIpc`, `tray.html`) and the
View-menu toggle. Decision: **defer** — it duplicates the tray companion +
notifications (`NotificationStack.tsx`, `notify(...)` in `server/index.ts`)
and collides head-on with the in-flight parity stream's `electron/main.mjs`.
Re-rank only as a *pending-approvals badge*, and only post-parity.

**(c) JEV grounding as target-picker — yes, this is the integration.**
Port `JevGrounding`/`LocalTargetContinuity` semantics to a pure TS module,
feed it CUA/browser element lists, use its output as (a)'s suggestion list
and as an exact-target validator ("failed exact ID must not fall back to a
nearby label" — keep that rule verbatim in code comments). `test-jev.sh` is
the pattern for keeping it testable in isolation.

**(d) Keychain/permission/settings UX → Muster settings.**
Key storage and permission *messaging* are already equivalent (rows 5, 10);
the adaptable part is the prompt-once-then-Settings presentation pattern
(row 15) and possibly new rows under Settings → Desktop. **CONFLICT FLAG:**
`src/components/SettingsModal.tsx` + `SettingsPrimitives.tsx` are being
restructured by the desktop-parity stream **right now (uncommitted)** — do
not open that file until their work is committed; land permission rows via
`DesktopCapabilities.tsx`/`src/lib/desktop.ts` where possible instead.

---

## 3. Ranked implementation slices (highest value first)

Ordered so each slice ships independently, value lands early, and conflicts
are faced deliberately. Verification gate for **every** slice (Muster rules):
`npx tsc --noEmit -p tsconfig.server.json` + the slice's own tests during
dev + one full `npx vitest run` before any commit, compared against the
latest verified baseline at the end of the handoff ledger. Report real
numbers; a slice isn't done until they pass.

### Slice 1 — Pure JEV-shaped grounding core  ← **best first slice**
- **House precedent first:** Muster already ships a pure Jev-style module —
  `server/jev-dispatch.ts` (+ its test, imported by `server/index.ts` L50).
  Read it before writing: match its structure (header comment stating the
  borrowed pattern, pure/no-I/O, caps as named constants, unit tests
  alongside) and **use distinct type names** (`ScreenTargetCandidate`, not
  `JevCandidate` — that one is taken and means "a bot" there). Also read the
  sibling `docs/plans/jev-decision-model-study.md` (parallel stream) so the
  two studies don't design rival candidate vocabularies.
- **Files (all NEW, zero overlap with any live stream):**
  - `server/desktop-grounding.ts` — port of `JevGrounding` (candidate
    describe/dedup/200-cap, `state`+`done/absent/pick/kind` question builder,
    strict `decision()` validation: invented target rejected, chosen prob must
    be max, finite 0–1 only, `__none__` → `target_absent` stop, tie honors
    choice) + `LocalTargetContinuity` IoU≥0.6 match + an answer-decoder for
    whichever ranker is used (TypeSafe **or** Muster's own model — no new
    hosted-key dependency is added by this slice; owner gate if TypeSafe is
    ever wired to a user key).
  - `server/desktop-grounding.test.ts` — port `TipTourTests/JevTests.swift`
    case-for-case (continuity jitter/different-control, cap+`__none__`
    present, duplicate/reserved IDs crash-safe, `__none__` stops not
    runner-up-clicks, no cutoff, invented/invalid/incomplete rejected, tie
    honored, missing key/ranker fails before network).
- **Verification:** `npx vitest run server/desktop-grounding.test.ts`, then
  server typecheck + full suite pre-commit. Mirrors their `test-jev.sh`
  isolation: the module imports nothing from Electron/Express.
- **Safety:** pure computation. No execution path, no permissions, no
  network unless a caller supplies a ranker. No security claims.
- **Conflict flags:** none (new files only). Does not touch `server/index.ts`.

### Slice 2 — Grounded suggested-action list on the approval card (the mission payoff)
- **Files:**
  - `server/index.ts` — in `request.opened` (card build, ~L1511–1610): for a
    This-Mac desktop tool request, fetch candidate elements (CUA desktop
    state / `computer-proxy.ts` `elements` shape), ground the bot's proposed
    label/step via `server/desktop-grounding.ts`, attach
    `suggestions: [{id,label,source,actionKind}]` to the card payload.
  - `server/contracts.ts` — card shape extension.
  - `src/components/OptionCard.tsx`, `src/components/ApprovalCard.tsx`,
    `src/components/PendingApproval.tsx` (+ their `.test.ts`) — render
    grounded suggestions as tappable options alongside Allow/Deny; each tap
    answers via the **existing** respond path (no new execution route).
  - Watch: reuse existing option rendering in `ios/Watch/WatchViews.swift`
    only if the suggestion list fits its one-tap contract — otherwise web
    only for v1.
- **Verification:** new `server/desktop-suggestions.test.ts` (grounding →
  card payload, never auto-answered), extend `src/components/ApprovalCard.test.ts`
  / `PendingApproval.test.ts` (suggestions render, tap = respond, deny path
  intact); full suite before commit.
- **Safety:** **the card stays the only actuator** — no code path may execute
  a suggested desktop action without a human response; keep `autoDecision`
  scoped to routine tool-permission cards exactly as today; adopt their
  operator rule as *copy/comment* ("never suggest password/2FA/payment/
  consent/credential-finalization controls") consistent with the existing
  `server/auto-approve.ts` denylist — this is a product rule, **not** a
  security claim. macOS permissions unchanged (Accessibility + Screen
  Recording already required by the embedded driver; surfaced by
  `DesktopCapabilities.tsx`).
- **Conflict flags:** 🔴 `server/index.ts` is **already modified** (OTP
  stream: `server/auth.ts`, `server/email.ts`, `src/lib/auth.tsx`,
  `src/pages/LoginPage.tsx`, `server/email-otp-*.ts` untracked). Coordinate
  or rebase before editing; keep this slice's hunks scoped to the
  `request.opened` card build. 🟡 `src/state/store.tsx` only if the card
  type moves (prefer `server/contracts.ts`).

### Slice 3 — This-Mac action guardrails (step budget, app-switch stop, continuity, settlement evidence)
- **Files:** `server/index.ts` (turn-scoped computer-action budget +
  prompt copy near the existing `PLAN TOOLS` block L2370 and computer-tool
  guidance L2771–2776), `server/local-computer.ts` or the local tool mount
  point (verify first), `server/desktop-grounding.ts` (continuity used by
  the guard), tests alongside.
- **Verification:** unit tests for budget/stop reasons (port TipTour's loop
  stop-reason vocabulary: `step_budget`, `app_changed`, `cancelled`,
  `target_absent`); `server/local-computer.test.ts` still green; full suite.
- **Safety:** bounds autonomy without granting any — budget exhaustion ends
  the turn back at the human. **First, verify** (don't assume) whether the
  embedded CUA path returns a settling frame per action; record the evidence
  in the slice's PR text rather than claiming validation that wasn't run.
  macOS: no new permissions.
- **Conflict flags:** 🔴 same shared `server/index.ts` as slice 2 (land
  after it to avoid self-conflict); 🟡 `electron/cua-runtime.mjs` if the
  budget needs driver-side state — that file is clean today but sits next to
  parity's `electron/main.mjs`.

### Slice 4 — Permission presentation + settings rows (prompt-once → System Settings)
- **Files:** `src/lib/desktop.ts`, `src/components/DesktopCapabilities.tsx`
  (+ `.test.ts`) — adopt the destination pattern (first tap = system prompt,
  later taps = `x-apple.systempreferences` deep link, "reveal app in
  Finder"-style helper if reachable via `shell`), honest last-known-granted
  fallback only where Electron's own APIs false-negative (mirror TipTour's
  documented Screen-Recording fallback rationale).
- **Verification:** capability-session tests (destination sequence, fallback
  flag), full suite.
- **Safety:** no permissions are *claimed* granted — only reported from the
  platform APIs; wording stays "macOS may ask…".
- **Conflict flags:** 🔴 **`src/components/SettingsModal.tsx` +
  `SettingsPrimitives.tsx` — desktop-parity agent, DONE but UNCOMMITTED.**
  Do not edit them in this stream. If new Settings rows are unavoidable,
  wait for parity to commit, then add rows in their new structure.
  🟡 `src/lib/keyboard-shortcuts.ts` / `ShortcutsSheet.tsx` — same stream,
  stay off.

### Slice 5 — Menu-bar status item (pending-approvals badge + tray toggle) — DEFER
- **Files:** `electron/main.mjs` (`new Tray(...)`, tooltip + badge for
  pending approvals, context menu delegating to existing `tray:toggle` /
  `tray:focus-app` IPC), `tray.html` (badge line only).
- **Verification:** `electron/*.test.mjs` conventions (`bump-version.test.mjs`
  style node tests), full suite.
- **Safety:** presentation only — the badge never answers a card; clicking it
  focuses the window where the human decides.
- **Conflict flags:** 🔴🔴 **`electron/main.mjs` is modified (uncommitted)
  by the desktop-parity stream — do not start until that lands.** Also
  touches updater-adjacent menu code (`electron/updater*.mjs` are dirty too).

### Slice 6 — Detection overlay / debug visuals — OUT OF SCOPE (v1)
Opt-in screen overlay of detected boxes is a debug nicety
(`TipTour/DetectionOverlayView` ≈ 460 ln + always-on-top overlay window
≈ 1700 ln in `OverlayWindow.swift`). Muster already shows the live screen in
`ComputerPanel.tsx`. Revisit only on owner request; it also stresses the
stability contract (route shells/layout preservation).

### What NOT to port (with reasons)
- **Sparkle `appcast.xml` + `scripts/release.sh`** — `electron/updater.mjs`
  already owns updates (and honestly documents Muster's ad-hoc signing).
- **Neko sprites / `NekoCursorView` / `RadialInputSwitcher` cat cursor** —
  Muster's mascot system is must-preserve and lives in `src/lib/mascot/*`;
  porting another mascot violates the layout/character contract.
- **`UIElementDetector.mlpackage` (99k-line binary weights)** — opaque binary
  dependency with unclear provenance; CUA/desktop-state elements suffice for
  slice 2. Revisit only with owner sign-off.
- **Gemini/JEV ProviderSetup key cards + mode-onboarding flags** — Muster has
  `safeStorage` + agent vault + its own onboarding (must-preserve saved
  choices).
- **Their localhost `:19474` harness** — duplicate of `server/fleet-mcp.ts` +
  HTTP API; a second control plane would blur the approval boundary.
- **Their `AGENTS.md` xcodebuild prohibition, analytics
  (`TipTourAnalytics`), Blender skill, `release.sh` notarization flow** —
  repo-local concerns, not Muster's.
- **Screen-aware one-action voice turn** — noted gap, not in the brief's
  ranked slices; defer.

### Conflict flags vs live streams (verified `git status --short` today)
| Stream | Dirty files | Impact on this study |
|---|---|---|
| Desktop parity (**DONE, uncommitted**) | `src/App.tsx`, `SettingsModal.tsx`, `SettingsPrimitives.tsx`, `ShortcutsSheet.tsx`, `src/lib/keyboard-shortcuts.ts`(+test), `electron/main.mjs` (+ `electron/updater.mjs`, `updater-coordinator.mjs` dirty) | Blocks **slices 4 & 5**; slices 1–3 avoid these files. |
| OTP | `server/auth.ts`, `server/email.ts`, `src/lib/auth.tsx`, `src/pages/LoginPage.tsx`, `src/pages/AuthPages.test.ts`, **`server/index.ts` (M)**, untracked `server/email-otp-*`, `src/components/EmailOtpSignIn.*` | **`server/index.ts` shared with slices 2–3** — rebase, keep hunks scoped. |
| Memory | untracked `server/memory-retrieval.ts`, `server/memory-grants.ts` | No overlap (new files elsewhere). |
| Backups / B1 | `server/workspace-backup-routes.ts` + new snapshot files + `SnapshotsCard.tsx` (not yet present), passphrase routes inside `server/index.ts` (~L8374+) | Shares `server/index.ts` with slices 2–3; different regions — coordinate. |
| iOS | `ios/**` (clean today) | Slice 2 Watch optional step touches `ios/Watch/WatchViews.swift` only if attempted — default web-only v1. |
| Other research docs | untracked `docs/plans/openmausbot-desktop-parity.md`, `docs/research/glm/*`, `docs/screenshots/openmuse/` | Doc-only; this study adds `docs/plans/tiptour-integration-study.md` + `docs/screenshots/tiptour/` (both new). |
| **Decision-engine research (parallel, appeared mid-session)** | untracked `docs/plans/jev-decision-model-study.md`, `docs/plans/laya-decision-engine-study.md` — sibling agents studying TypeSafe Jev and the Laya engine **right now** | Direct thematic overlap with §1.7/§2 row 11–12. Read `jev-decision-model-study.md` before implementing slice 1/2 (it maps the real Jev API onto Muster and knows `server/jev-dispatch.ts`'s Loop108/110 precedent); coordinate ranking so three studies don't produce two "candidate picker" designs. |

---

## 4. License / attribution notes

- TipTour is **MIT** — Copyright (c) 2026 Milind Soni, **portions Copyright
  (c) 2025 Farza (Clicky)** — with a separate `LICENSE-NEKO.txt` for the cat
  sprites. MIT permits use in Muster's private BSL 1.1 repo **provided the
  copyright notice and permission notice are retained** in copies/substantial
  portions. If any TipTour code is copied (slice 1 is a port/translation —
  keep it honest: retain their notice in the new file headers or record it in
  this doc's citation block).
- Cite this doc + the source tree path as provenance for any ported logic.
- Do **not** port the Neko sprites without also carrying `LICENSE-NEKO.txt`
  (we're not porting them at all — see §3).
- No security claims: nothing here attests that Muster's or TipTour's code is
  secure; the owed full scanner re-run stands.

---

## 5. Extracted frames (ffmpeg) — per-frame UI notes

New folder `docs/screenshots/tiptour/` (created by this study; no existing
files modified). The repo ships **no video**, so these are ffmpeg crops of
its two demo images. They are **marketing renders, not live screenshots** —
treat them as intent, not evidence of shipped UI.

| File | Frame note |
|---|---|
| `01-move-this.png` | Voice-chip demo: glowing cursor arrow on a blurred desktop with the mic chip **"Move this"** — Gemini mode's *point/act on the element under discussion* affordance (the visual for auto-click vs point-only). |
| `02-merge-those.png` | Same surface, pink hand-drawn cursor path into a target with mic chip **"Merge those"** — multi-element voice instruction resolving to one action. |
| `03-add-that.png` | Straight orange cursor trajectory with mic chip **"Add that"** — direct placement action; illustrates "one desktop action per turn". |
| `04-guide-me.png` | Dashed path landing on a concentric target ring with mic chip **"Guide me"** — point-only guidance mode (TipTour shows where to click instead of clicking). Maps to Muster's opposite default: suggest-on-card, human taps. |
| `05-hero-overview.png` | Full README hero (scaled to 1200px) of the same four chips over a collage of blurred windows — the product's one-line visual: voice chips over your real desktop. |
| `06-dmg-install-arrow.png` | Crop of `dmg-background.png` (the DMG install window art: minimal arrow on cream). **No app UI** — included only as release-pipeline evidence of their Sparkle/DMG flow (§1.6). |

---

## 6. Recommended first move for an implement-only agent

**Slice 1 only:** create `server/desktop-grounding.ts` +
`server/desktop-grounding.test.ts` (pure port of `JevGrounding` +
`LocalTargetContinuity` + strict decision decoding, `__none__` stop semantics,
200 cap, no confidence cutoff), port the Swift test cases one-for-one, run
`npx vitest run server/desktop-grounding.test.ts` and
`npx tsc --noEmit -p tsconfig.server.json`, then the full suite before any
commit. Zero conflict with every live stream. Do **not** start slice 2 until
its `server/index.ts` rebasing against the OTP/backups streams is sorted, and
stay out of `SettingsModal.tsx` / `electron/main.mjs` until parity lands.
