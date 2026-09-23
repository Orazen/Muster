# PocketCtrl → Muster integration study (2026-09-23)

Owner instruction (as relayed by the spawning session): *"checkout
https://github.com/PocketCtrl/pocketctrl — integrate the feature into Muster
accordingly."*

Read-only research pass. **Method:** fetched the repo page, `README.md`,
`LICENSE`, `LICENSING.md`, `NOTICE`, `SECURITY.md`, `TRADEMARKS.md`,
`GOVERNANCE.md`, `CONTRIBUTING.md`, `CLA.md`, `Package.swift`,
`.github/workflows/ci.yml`, all of `docs/*`, `mcp/README.md` +
`mcp/pocketctrl-host-server.mjs`, `Sources/PocketCtrlHostCLI/main.swift`,
`PocketCtrlNative/README.md`, `AgentSkills/pocketctrl/SKILL.md`, plus the
GitHub tree/commit/repo APIs — all over `webfetch`, no clone. This subagent
ran **no git commands**, changed no code, ran no tests, started no services;
conflict flags below are inherited from the sibling studies
(`openmuse-integration-study.md`, `tiptour-integration-study.md`) and MUST be
re-verified by the implementing loop with
`git status --short --untracked-files=all` before staging anything. This
study made **no edits** to `docs/plans/ceo-log.md` or
`docs/plans/current-state.md` (owner-only); recording a slice's verified
numbers in those ledgers is the implementing loop's own ledger step
(`docs/AGENT-ORIENTATION.md` §4.7). No security claims are made anywhere
below — PocketCtrl's own "no professional independent audit" statement is
theirs, and Muster's owed full scanner re-run still stands.

Sibling studies to read first if you touch desktop territory:
`docs/plans/tiptour-integration-study.md` (grounding/suggestions/guardrails
slices 1–3 are **already implemented** — see §3.4) and
`docs/plans/openmuse-integration-study.md` (the format this doc follows).

---

## 1. PocketCtrl teardown — what it actually is (verified from its own repo)

**PocketCtrl is a free, open-source, native remote-desktop product for
controlling a Mac from another Mac, iPhone, or iPad** — direct over your own
Wi‑Fi or Tailscale, no account, no cloud service — plus a small local
automation plane (Swift CLI + MCP bridge + agent skill) that lets a local
agent inspect or drive the running host app. It is *not* an agent-workforce
product: its only model-driven path is an **optional, supervised, OpenAI-only
"Computer Use"** mode on the iPhone/iPad viewer's robot button.

### 1.1 Architecture (files as they exist on `main`)

| Layer | What it is (their files) |
|---|---|
| **Host (macOS app)** | `PocketCtrlNative/PocketCtrl/*` — ScreenCaptureKit capture → VideoToolbox H.264 (`VideoPipeline.swift`, `VideoFraming.swift`, `H264AnnexB.swift`), system audio, CoreGraphics input injection (`RemoteInput.swift`), Bonjour `_pocketctrl._udp` advertising (`LocalDiscoveryAdvertiser.swift`), Tailscale fallback, quality ceilings + adaptive bitrate (`ViewerStreamSettings.swift`), login item, diagnostics for Screen Recording / Accessibility / Local Network (`MacPermissions.swift`, `MacTransportDiagnostics.swift`). |
| **Pairing & trust** | Pairing closed by default → 12-char short-lived invitation = QR = `pocketctrl://` link (`PairingInvitationCode.swift`); host owner reviews fingerprint + route, picks explicit capabilities, authenticates via Local Authentication; per-device random credentials, individually revocable, **unattended vs session-only** lifetime (`TrustedDeviceStore.swift`, `KeychainStore.swift` — device-only, non-syncing Keychain in Release). Traffic: ChaChaPoly authenticated encryption with channel-separated keys from the device credential; pairing responses use ephemeral Curve25519 (`SecureSessionDatagram.swift`); network-address policy (`NetworkAddressPolicy.swift`, `IPNetwork.swift`). *(Their SECURITY.md describes this model; it is a description, not an audit — no claim is made here.)* |
| **Viewers** | Same Mac app can view another Mac; `PocketCtrlNative/PocketCtrlMobile/*` is the iPhone/iPad viewer (QR/Computer Code entry, on-screen trackpad + keys, voice typing via on-device speech `ClientSpeechInput.swift`, Wake-on-LAN `ClientWakeOnLAN.swift`, detail/FPS sliders with data estimates, hold-to-talk). iOS/iPadOS 18+, macOS 15.6+, Xcode 26 to build. |
| **Control plane (the part Muster can consume)** | `PocketCtrlHostControlServer.swift` — loopback-only API on `127.0.0.1:47777` guarded by a random bearer token (Keychain copy + `~/Library/Application Support/PocketCtrl/cli-control-token`, 0700/0600). Consumers: Swift CLI `Sources/PocketCtrlHostCLI/main.swift` (installable to `/usr/local/bin` via Settings → Command Line), stdio **MCP bridge** `mcp/pocketctrl-host-server.mjs` (7 tools, token via `POCKETCTRL_CONTROL_TOKEN`, and it *rejects any non-loopback `POCKETCTRL_HOST_URL`*), and the portable agent skill `AgentSkills/pocketctrl/SKILL.md` (rules: status before state changes; never read/print the control-token file; never override the token/host env vars; state-changing commands only when directly requested). |
| **Optional Computer Use** | `ComputerUseCoordinator.swift` (45 KB) + `ComputerUseDesktop/FocusResolver/ScreenValidation/SettingsView` + `OpenAIComputerUseProvider/Options/ModelCatalog` — OpenAI Responses computer tool, models `gpt-6-luna` / `gpt-6-sol` / `gpt-6-astra`, key in the host Keychain, **separate per-device Computer Use grant** on top of remote input; requires a *supervising viewer* kept foregrounded; pauses on supervision loss; sensitive actions may demand an explicit Allow ("the approval applies only to the displayed request; changed targets may need a fresh review"); routine typing checks the keyboard destination and pointer actions check their hit area; a changed target triggers screenshot-based replanning that discards unexecuted actions and reports partial batches, **bounded to three retries per task segment**; Stop cancels pending work before releasing control; per-task dollar estimate (explicitly "not spending limits"); model catalog `distribution/ai/openai-models.json` with validated bundled fallback. Development-version feature; docs say a supervised live task per model remains a release test and their tests are mocked (`zsh script/test_computer_use.sh`). |
| **Release/update** | Sparkle 2.10+ signed appcast (`docs/mac-updates.md`), Developer ID + notarized DMG flow (`script/release_mac.sh`, `docs/mac-website-release.md`), Mac distributed from their website, iOS from the App Store, website in a **separate** Vercel repo. |
| **Tests** | 16 Swift case files under `Tests/` (incl. a ~90 KB `ComputerUseCases.swift`) driven by 9 `script/test_*.sh` harnesses; CI (`.github/workflows/ci.yml`, `macos-latest`) runs all of them, `swift build --product pocketctrl`, and both `xcodebuild` schemes with `CODE_SIGNING_ALLOWED=NO`. |

### 1.2 Tech stack

Swift 5.9+/SwiftUI (one Xcode project, two app targets), SwiftPM for the CLI,
one dependency-free Node `.mjs` for MCP, shell/AppleScript/Swift release
scripts, GitHub Actions on macOS. No server-side components anywhere in this
repo; nothing to host; everything is device-local or peer-to-peer.

### 1.3 Maturity signals (optional but checked)

Public since **2026-09-15** ("Initial public release"), created 2026-09-02,
last push **2026-09-23** (today — "Add supervised OpenAI computer use");
**5 commits total, 25 stars, 1 fork, 0 open issues**, commits unsigned;
full governance pack present (`GOVERNANCE.md`, `CLA.md`, `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, `SECURITY.md`, `TRADEMARKS.md`, `LICENSING.md`,
`NOTICE`); CI is real and green-shaped. Steward: Kylan O'Connor at Iterative
(TalkUp LLC). Capability truth, not stars, is what this study relies on.

### 1.4 Honesty notes (do not overclaim their repo)

1. **No relay exists in this repository.** The GitHub description says
   "self-hosted relay", but the tree has none — and `LICENSING.md` says
   managed relays/device directories "may be developed separately". Never
   describe PocketCtrl to a Muster user as having a relay.
2. Their README warns `main` may contain features **not** in published
   releases, and Computer Use is explicitly a development-version feature
   with mocked tests — "fixture-verified" is the only honest claim.
3. Their own words: the protocol "has not received a professional
   independent audit"; approvals/screen-validation "are not a security
   boundary against every model mistake or prompt-injection attack." This
   study inherits neither their caveats as ours nor any security claim.
4. Pairing output, control tokens and screenshots are treated as sensitive
   by their own skill doc — any Muster integration must be at least as
   quiet about them.

---

## 2. License and attribution verdict

**License: Mozilla Public License 2.0 — SPDX `MPL-2.0`** (verified three
ways: the `LICENSE` file is the verbatim MPL-2.0 text; GitHub reports
`spdx_id: MPL-2.0`; source files already carry `// SPDX-License-Identifier:
MPL-2.0` headers, e.g. `Package.swift`, `Sources/PocketCtrlHostCLI/main.swift`,
`mcp/pocketctrl-host-server.mjs`). **It is licensed — this is NOT an
unlicensed repo, and no area of this study is forced to "clean-room only" by
the absence of a license.** However, MPL-2.0 is *weaker-copyleft, file-level*
— stricter than the MIT/Apache-2.0 material Muster has absorbed before
(openmuse MIT, tiptour MIT, laya Apache-2.0, OpenMausBot Apache-2.0), and
this changes how slices must reuse code:

- **Verbatim or near-verbatim copies** of an MPL-covered file (or substantial
  portions of one) remain Covered Software: keep their SPDX header, add a
  Muster file-header attribution naming upstream project + license, and
  understand that the file must stay available under MPL-2.0 if Muster ever
  distributes it — it cannot quietly become BSL-only. If that obligation is
  ever unwanted, the copy must not happen.
- **House attribution rule (same rule Muster applies to openmuse, tiptour,
  laya, OpenMausBot):** any verbatim/near-verbatim reuse gets a file-header
  comment of the shape —
  `Adapted from pocketctrl (github.com/PocketCtrl/pocketctrl), MPL-2.0 License, Copyright 2026 TalkUp LLC dba Iterative, and PocketCtrl contributors.`
  Headers and plan docs only — per AGENTS.md that github.com link must never
  appear in user-facing UI.
- **Default for every slice below is a clean-room semantic port**: translate
  documented behavior/semantics into fresh TypeScript in Muster's house style
  (the pattern `server/desktop-grounding.ts` / `desktop-guardrails.ts` /
  `browser-panel.ts` already use), cite upstream file + MPL-2.0 in the header
  even though a clean-room port carries no copy obligation, and copy no
  Swift prose, structure, or identifiers beyond what the semantics require.
- **Trademark boundary (their `TRADEMARKS.md`):** the PocketCtrl *name, icon,
  official builds, website identity and "PocketCtrl Network" branding are
  owned by TalkUp LLC and are **not** under MPL-2.0. Muster may name the
  project truthfully in docs/headers; it may not put PocketCtrl branding,
  logos, or "official" framing anywhere in user-facing UI, and must not imply
  endorsement.
- **CLA:** their `CLA.md` binds *contributors to their project* — this study
  proposes contributing nothing upstream; never open issues/PRs there on
  Muster's behalf.

**Verdict:** permissively usable with weak file-level copyleft + a trademark
carve-out. Overlapping areas are **not** marked clean-room-only; they are
marked "clean-room preferred, attributed MPL header if copied", per slice in
§6.

---

## 3. Capability comparison vs Muster

Classes: **AE** = ALREADY-EQUIVALENT (Muster has it — cite), **AD** =
ADAPTABLE (their shape → Muster shape), **RG** = REAL-GAP (Muster lacks it),
**OOS** = real but OUT OF PLACE for Muster's model. Muster file cites below
were verified to exist during this study.

### 3.1 Mapping table (22 rows)

| # | PocketCtrl capability (their source) | Class | Muster equivalent / destination |
|---|---|---|---|
| 1 | Peer-to-peer remote desktop of the host Mac from phone/Mac viewer — H.264 over UDP, LAN/Tailscale, no cloud (`VideoPipeline.swift`, `UDPTransport.swift`) | **RG / OOS** | Muster's surfaces: This-Mac embedded CUA (`electron/cua.mjs`, `electron/cua-runtime.mjs`, `server/local-computer.ts`), cloud box (`server/box.ts`, `server/vps-computer.ts`), frame previews (`server/browser-panel.ts`, `/api/local-computer/screenshot` route in `server/index.ts`), and the iOS companion already renders bot screenshots (`ios/App/ComputerView.swift`, `ios/App/ChatView.swift` `ScreenShot`). A viewer-grade peer-to-peer stream would be a new product line → §7. |
| 2 | Capability matrix per device: screen always; remote input / clipboard / audio **separate, default off**; **unattended vs session-only** credential lifetime; fingerprint+route review before grant (`SECURITY.md`, `PocketCtrlNative/README.md`) | **AD** | This-Mac access is a binary session gate today (`electron/computer-access-sender.mjs` → `computer-access-off` in `electron/cua-runtime.mjs`, surfaced by `src/components/DesktopCapabilities.tsx` / `src/lib/desktop.ts`, per-bot Off in `src/components/ComputerPanel.tsx`). Port the *matrix shape* (view/input split, default-off, grant lifetime) → §6 S5. |
| 3 | Post-action screen validation: keyboard-destination check, pointer hit-area check, changed-target detection → screenshot-based replanning with unexecuted actions discarded + partial batches reported, **3 retries per segment**, unverifiable states pause (`ComputerUseScreenValidation.swift`, `ComputerUseFocusResolver.swift`, `docs/computer-use.md`) | **RG** | Muster has grounding (`server/desktop-grounding.ts`) and a step budget + stop vocabulary (`server/desktop-guardrails.ts`) but **no producer that checks whether the last action landed** — `desktop-guardrails.ts`'s own header says its reasons "ship as vocabulary… nothing in this repo reports them yet". This is the honest capability core → §6 S1/S3. |
| 4 | Supervision model: viewer foregrounded or task pauses; manual input withheld while the task owns control; Stop cancels pending work *before* releasing control; disconnect/background pauses, never auto-resumes (`docs/computer-use.md`) | **AE (Muster stronger)** | Stop-then-steer already ships: `src/components/Composer.tsx` stop slot, `server/steer-queue.ts` persisted queued messages, watchdog `setWaitingOnHuman` in `server/index.ts`. Their vocabulary (pause-on-supervision-loss) is copy/comment material for S3, nothing to rebuild. |
| 5 | Sensitive-action Allow scoped to the displayed request; changed target needs fresh review (`docs/computer-use.md`) | **AE (Muster stronger)** | The approval moat: `request.opened` card build (`server/index.ts` ~L1519–1646) with `approvalWhy` (`server/approval-why.ts`), `rehearsePlan` (`server/plan-rehearsal.ts`), history (`server/approval-history.ts`), `autoDecision` (`server/auto-approve.ts`) → `src/components/OptionCard.tsx` / `ApprovalCard.tsx` / `PendingApproval.tsx`, Watch one-tap (`ios/Watch/WatchViews.swift`). PocketCtrl's Allow is ephemeral — no history, no why, no Watch, no rehearsal. |
| 6 | Loopback-only host API + random bearer token from env/Keychain, never exposed to a network (`PocketCtrlHostControlServer.swift`, `SECURITY.md`) | **AE** | Muster's server is loopback/session-authed with env/secrets-only credentials (`server/auth.ts`, `server/redact.ts` — which explicitly redacts tokens traveling in MCP env). Their `configuredBaseURL()` loopback-or-refuse check is the same discipline Muster already applies. |
| 7 | MCP server for host control: 7 tools, status/pairing reads + start/stop/restart/regenerate-pairing/set-settings writes (`mcp/pocketctrl-host-server.mjs`) | **AD** | Muster already mounts **user-registered external stdio MCP servers** per bot: `server/custom-mcp.ts` (validation, unique names, env redaction so secrets never reach the renderer), routes `/api/mcp-servers[...]` (`server/index.ts` L8272+), UI `src/components/McpServersSection.tsx`, client `server/mcp-client.ts`. Muster's own `server/fleet-mcp.ts` keeps the stronger asymmetry (one writer, no approvals/credentials tools). → §6 S4. |
| 8 | Never-auto-answer discipline for host-control mutations is **implicit only**: nothing stops an *external agent* in auto mode from waving their write tools through — their skill doc says "make only the changes the user requested" (a prompt, not a gate) (`SKILL.md`) | **AD / RG** | Muster's non-human answer path is exactly one place: `autoDecision` (`server/auto-approve.ts`), whose destructive/sensitive pattern lists do **not** match `pocketctrl_host_*` names — `pocketctrl_host_stop`, `…_set_settings {remoteInputEnabled:true}`, `…_regenerate_pairing`, and `…_pairing_info` (returns a QR payload — sensitive by *their own* skill doc) would all wave through under `autoApprove` (L91). Close it → §6 S2. |
| 9 | Portable agent skill for Codex/Claude Code with explicit safety rules (`AgentSkills/pocketctrl/SKILL.md`) | **AE** | Muster's `skills/` + `server/workspace-skills.ts` (CRUD) already own per-bot skills; their safety-rule *style* (status-before-write, state changes only on direct request) is the same prompt discipline Muster's bounded tools encode in code. |
| 10 | Installable CLI against the local API, env-overridable token (`Sources/PocketCtrlHostCLI/main.swift`) | **AE** | `cli/muster.mjs` (`pair`, `mcp`, session persistence, `~/.muster/cli.json`) — Muster's CLI is richer; nothing to port. |
| 11 | Pairing by short-lived code/QR/link with expiry + explicit redemption (`PairingInvitationCode.swift`) | **AE** | `muster pair` code create/redeem (`cli/muster.mjs`, `/api/pair/create`, `/api/pair/claim/create`) — same shape, already shipped. |
| 12 | View-only by default; control/clipboard/audio are explicit toggles (`PocketCtrlNative/README.md`) | **AE** | This-Mac starts `computer-access-off` (`electron/cua-runtime.mjs` reason code); enable flow in `DesktopCapabilities.tsx`. Same default posture, different vocabulary (S5 refines it). |
| 13 | Trusted-device list with individual revocation + live connected-viewer list (`TrustedDeviceStore.swift`) | **AD** | `server/devices.ts` (device/session records incl. "Muster CLI") + session revocation (`cli/muster.mjs` `sessions revoked`). Adapt: per-device capability display next to existing device rows — smallest possible UX add-on, folds into S5's data. |
| 14 | Permission diagnostics with prompt buttons for Screen Recording / Accessibility / Local Network (`MacPermissions.swift`, `MacTransportDiagnostics.swift`) | **AE** | `src/components/DesktopCapabilities.tsx` wording + driver-side `sdk.requestMacOSPermissions()` in `electron/cua-runtime.mjs` (tiptour study rows 10/15 covered the prompt-once→deep-link refinement). |
| 15 | Per-task dollar estimate for model-driven computer work, priced from a validated catalog (`docs/computer-use.md`, `distribution/ai/openai-models.json`) | **AE** | Budgets + receipts already carry cost/token proof (`server/receipts.ts`, per-bot vault budget in `server/store.ts`, `server/role-eval.ts`/`fleet-eval.ts`). Muster's receipts are durable and journalable; theirs is an in-sheet estimate. |
| 16 | Adaptive bitrate / stream-quality model (detail+fps sliders, presets, data estimates) (`docs/stream-quality.md`) | **RG / OOS** | No streaming surface exists in Muster by design (see row 1) — nothing to attach it to. |
| 17 | Wake-on-LAN, keep-awake, launch-at-login (`ClientWakeOnLAN.swift`, `LoginItemManager.swift`) | **RG / OOS** | Absent and not on the Astra brief's ranked list; defer on owner request only. |
| 18 | Sparkle signed updates + notarized DMG release flow (`docs/mac-updates.md`, `docs/mac-website-release.md`) | **AE / OOS** | Muster's `electron/updater.mjs` + `electron/updater-coordinator.mjs` + release mirror docs already own updates (tiptour §7). Do not port; their Developer-ID/website flow is theirs. |
| 19 | **Bot fleet, persistent workers, threads, memory/workspace brain** | Muster-only | `server/store.ts`, `server/workspace-brain.ts`, `server/sync-journal.ts`, `server/agent-rooms.test.ts`. PocketCtrl has no agents except the optional supervised OpenAI flow — no roster, no persistence, no restart recovery. |
| 20 | **Approval evidence trail: why-journal, plan rehearsal, approval history, routine scorecards, receipts, Watch approvals, Goal-mode bounded autonomy** | Muster-only | `server/why-journal.ts`, `server/plan-rehearsal.ts`, `server/approval-history.ts`, `server/routines.ts` (`RoutineCheck`), `server/receipts.ts`, `ios/Watch/WatchViews.swift`, `server/goals.ts`. PocketCtrl's Allow evaporates; Muster's decisions leave proof. |
| 21 | **Connectors, channels, eval harness, bounded external-agent door** | Muster-only | `server/composio.ts`, `server/telegram-sync.ts` + `server/whatsapp.ts`, `server/role-eval.ts`/`server/fleet-eval.ts`, `server/fleet-mcp.ts` (73 tests), `server/jev-dispatch.ts`. |
| 22 | Multi-tenant ownership guards / multi-account server posture | Muster-only | PocketCtrl is single-owner, no accounts, by design ("no account required"). Muster's per-bot ownership guard upstream of every route stays the operative model. |

**Counts: AE = 8 (#4,5,6,9,10,11,12,14,15 — 15 counted AE, see table) ·
AD = 3 (#2,7,8/13 refinement) · RG = 3 (#1,3,16,17 with OOS flags) ·
Muster-only = 4 rows (#19–22).** The honest overlap is narrow and specific:
**the supervised-execution guardrails (#3), the capability-grant matrix (#2),
and the loopback-token MCP control plane Muster can already mount (#7,#8)** —
everything else is either already shipped in Muster or a product line Muster
should not open in an audit pass.

### 3.2 Where it fits "accordingly" — the honest overlap

1. **Supervised execution guardrails (the real feature to integrate).**
   PocketCtrl's Computer Use is the only mature, tested implementation among
   the two projects of the *"did the action land, did the target move, bound
   the recovery, let the human stop it"* loop. Muster already owns the
   *proposal* side (grounding → suggestions → budgeted turn) — tiptour
   studies slices 1–3 are wired into `server/index.ts` (imports at L151–152,
   `suggestionCardPatch(groundDesktopSuggestions(...))` at L1566,
   `desktopBudget.record` at L1856) — but the **verification side has no
   producer**. Porting PocketCtrl's validation semantics gives Muster's
   approval cards evidence about the *last* action, which is exactly the
   human-in-the-loop direction: the card shows what changed before a human
   allows the next step.
2. **The grant matrix, not the stream.** Default-off, per-capability,
   session-vs-unattended lifetime is the vocabulary Muster's binary
   `computer-access` gate should speak next; the H.264/UDP viewer it belongs
   to is out of place (§7).
3. **The control plane Muster can consume without copying anything.** Their
   host MCP is a peer of the external servers `server/custom-mcp.ts` already
   mounts; the integration is a profile + a never-auto-answer policy, not a
   port.
4. **Where PocketCtrl is simply ahead-by-absence:** Muster must *not* copy
   its ephemeral Allow, prompt-only safety rules, or single-owner model —
   those are the holes Muster's approval moat exists to fill.

---

## 4. Deep dives on the called-out capabilities

### 4.1 The validation semantics to port (S1/S3)
Their loop, precisely: after an input action, (a) routine typing validates
the **keyboard destination** (focused element), not unrelated screen
animation; (b) pointer actions validate their **hit area**; (c) a changed
target → **automatic screenshot-based replanning**: unexecuted actions are
discarded, partial batches are reported back to the model, and recovery is
bounded to **three retries per task segment**; (d) display changes or
unavailable screen validation **pause** rather than guess; (e) explicit
approvals keep broader checks and **never transfer** to a newly planned
action. Muster's landing shape: a pure `server/desktop-validation.ts` that
classifies an after-state as `landed | target_changed | unverifiable` and
feeds (i) the `DesktopActionBudget` stop vocabulary already in
`server/desktop-guardrails.ts` (`app_changed`, `target_absent`) and (ii) the
pending card as *evidence* — never as a verdict, never as an auto-answer.

### 4.2 The never-auto-answer gap (S2)
`autoDecision` (`server/auto-approve.ts` L71–93) order of operations:
unattended → refuse; destructive/sensitive patterns → refuse; `alwaysAllow`
key → answer; **`autoApprove` → answer anything else**. External
host-control tool names (`pocketctrl_host_stop`, `…_set_settings`,
`…_regenerate_pairing`, `…_pairing_info`) match no pattern. The fix is a
third refusal list ("external host-control mutations and pairing reads are
never machine-answered"), mirroring how `looksDestructive`/`looksSensitive`
already gate *before* `alwaysAllow` can widen — a **product rule, explicitly
not a security boundary**, exactly as the file's own header states.

### 4.3 The control plane as connector (S4)
`mcp/pocketctrl-host-server.mjs` needs three things from Muster's side: a
stdio entry (`command: node`, args = path to their `.mjs` — spawned where
the user installed it, **never bundled by Muster**), env
`POCKETCTRL_CONTROL_TOKEN` supplied by the user (fits `custom-mcp.ts`'s
env model — values are credentials, redacted on the wire by `toWire`), and a
bot scope (`bots: [id]`) so only the owner's desktop bot mounts it. Reads
(`status`) settle as ordinary tool results; writes and `pairing_info` must
land on OptionCards (S2 makes auto mode unable to bypass that). Their own
client rejects non-loopback host URLs — Muster adds no host-URL surface at
all.

### 4.4 Grant matrix (S5)
Map: *screen viewing* → Muster's existing preview path; *remote input* → the
desktop-action capability (today implied by `computer-access` being on);
*unattended vs session-only* → whether the `cua-connection.json` descriptor
survives an app restart (`server/local-computer.ts` validates it, doesn't
decide its lifetime). Their per-device revocation list maps onto
`server/devices.ts` rows. **Defaults stay off; only a human flips them; iOS
is untouched (§5).**

---

## 5. iOS angle — mapped, NOT touched

**Zero edits under `ios/**` in any slice of this study. iOS bundle IDs,
entitlements, and App Groups never change.** The iOS parity stream owns that
tree (openmuse study stream (v)); this study adds nothing native. Mapping
for the record, so a future owner-directed pass has the list:

| PocketCtrl mobile pattern | Muster today (map only) |
|---|---|
| Full-screen live view of the host Mac with trackpad/keys | Muster iOS shows bot screenshots + cards (`ios/App/ComputerView.swift`, `ChatView.swift`) — a host-Mac viewer would be a new product line, §7. |
| QR / Computer Code pairing with capability checklist | `muster pair` code redemption already exists server-side; the iOS screen would render it — **map only**. |
| Hold-to-talk instruction → pause/edit/resume task sheet | Muster has dictation/walkie (`ios/**` companion) — map only. |
| Detail/FPS quality sliders + data estimate | No stream in Muster — nothing to map. |
| Watch | PocketCtrl has **no watch app at all**; Muster's Watch approvals (`ios/Watch/WatchViews.swift`) stay exactly as they are. |

---

## 6. Ranked implementation slices (smallest-verifiable-first)

Verification gate for **every** slice (orientation §5): `npx tsc --noEmit
-p tsconfig.server.json` → `npx tsc -b` → `npx oxlint .` (expect 0 warnings
0 errors) → touched-file `npx vitest run <file>.test.ts` during dev → one
full `npx vitest run` before commit, compared against **the latest baseline
at the top of `docs/plans/current-state.md`** (orientation records Loop117:
292 files / 4320 passed / 8 skipped / 0 failed, e2e 26/26 — the ledger's top
entry wins; report any decrease explicitly). UI-touching slices also run
`npm run build && npx playwright test`. Electron-touching slices add
`node --check` on the touched `.mjs`. Report real numbers; a slice isn't
done until they pass.

**Hard constraints, every slice:** approvals stay human (the card is the
only actuator; `autoDecision` may only ever be *narrowed*); mascots, route
shells (`/app`, `/os`), saved choices and user sessions preserved; any auth
touch would have to be additive — **no slice here touches login** (the OTP
stream owns `server/auth.ts`, `server/email.ts`,
`server/email-otp-login.ts`, `src/lib/auth.tsx`,
`src/pages/LoginPage.tsx`, `src/components/EmailOtpSignIn.tsx`); **no edits
under `ios/**`** — bundle IDs/entitlements/App Groups never change; **no
security claims**; credentials come from env/secrets only; **never touch or
point anything at the demo server `127.0.0.1:8845`** (owned fixtures, free
ports, explicit `OMB_PORT`/`OMB_DATA_DIR` only); nothing under the excluded
parallel-session set — `www/*` (incl. `www/fonts/`, `www/templates.html`),
`.commandcode/`, `.freebuff/`, `.zcode/`, `docs/research/glm/*`,
`marketing-video/` — may be read or written. **Conflict streams (inherited,
re-verify yourself):** desktop-parity owns `src/App.tsx`,
`src/components/SettingsModal.tsx` + `SettingsPrimitives.tsx` +
`ShortcutsSheet.tsx`, `src/lib/keyboard-shortcuts.ts`, `electron/main.mjs`;
OTP owns the auth/login files above; memory owns `server/memory-*`; backups
owns `server/workspace-backup-routes.ts`; iOS parity owns `ios/**`.
`server/index.ts` and `src/state/store.tsx` are shared hot files — additive
hunks only. Stage explicit paths after `git status --short
--untracked-files=all` (orientation §4.6); pathless commit message.

### S1 — Pure post-action screen-validation module ← **best first slice**
- **What:** new pure module classifying an action's after-state —
  `landed | target_changed | unverifiable` — plus the bounded-recovery
  vocabulary: changed-target invalidates unexecuted actions and reports a
  partial batch; **3-retries-per-segment** as a named constant; unverifiable
  ⇒ `pause` (returns data that says "ask the human", never a guess). No
  wiring, no I/O, no Electron/Express imports — same isolation rule as
  `server/desktop-grounding.ts` (whose `test-jev.sh`-style harness this
  mirrors). **Clean-room semantic port** of their
  `ComputerUseScreenValidation.swift` / `ComputerUseFocusResolver.swift`
  semantics as documented in `docs/computer-use.md`; distinct type names
  (read `server/desktop-grounding.ts` + `server/jev-dispatch.ts` first —
  `ScreenTargetCandidate` and `JevCandidate` are taken; coordinate with
  `docs/plans/jev-decision-model-study.md` /
  `docs/plans/laya-decision-engine-study.md` so three studies don't invent
  rival vocabularies).
- **Files (all NEW, zero overlap with any live stream):**
  `server/desktop-validation.ts`, `server/desktop-validation.test.ts`.
- **Tests:** table-driven — keyboard-destination mismatch ⇒
  `target_changed`; hit-area mismatch ⇒ `target_changed`; no before/after
  pair ⇒ `unverifiable` (never `landed`); retry counter stops at the named
  segment bound and reports partial batches; partial batches never fabricate
  the discarded actions. Pattern: `server/desktop-guardrails.test.ts`.
- **Attribution:** no verbatim Swift copied. Header comment still names
  upstream: `Adapted semantics from pocketctrl
  (github.com/PocketCtrl/pocketctrl), MPL-2.0, Copyright 2026 TalkUp LLC dba
  Iterative, and PocketCtrl contributors — ComputerUseScreenValidation /
  docs/computer-use.md; clean-room port, no copied code.` (docs/headers only,
  never user-facing UI).
- **Conflict flags:** none (new files only). Does not touch
  `server/index.ts`.

### S2 — Never machine-answer external host-control tools
- **What:** extend `server/auto-approve.ts` so a third refusal list sits
  with `looksDestructive`/`looksSensitive` — external host-control MCP
  mutations (`pocketctrl_host_start|stop|restart|regenerate_pairing|
  set_settings`) and pairing/credential reads (`pocketctrl_host_pairing_info`)
  are **never** auto-answered, and the check runs *before* `alwaysAllow` and
  `autoApprove` (their guard order comment: "the guards come first, so an
  'always allow' can never widen into them"). Generic rule preferred over a
  single-brand hack: a small named `NEVER_AUTO` tool-name/prefix set +
  documented rationale, PocketCtrl as the first member. Product rule, **not
  a security boundary** — say so in the comment, matching the file's header.
- **Files:** `server/auto-approve.ts`, `server/auto-approve.test.ts`.
- **Tests:** auto-mode bot + each write tool ⇒ `autoDecision` returns null;
  `pairing_info` with a matching `alwaysAllow` key ⇒ still null (guards
  precede the key); `status` read under auto mode remains answerable;
  existing destructive/sensitive cases stay green.
- **Attribution:** tool names are upstream facts; cite `mcp/README.md` +
  this study in the comment. **No upstream code copied — nothing to carry
  beyond a prose citation.**
- **Conflict flags:** none recorded; pure logic file. Can ship in the same
  loop as S1 but as its **own commit** (one slice = one commit).

### S3 — Validation evidence on the pending desktop approval card
- **What:** wire S1 into the This-Mac ask as *evidence*, sibling to the
  tiptour suggestions patch: at the `request.opened` card build
  (`server/index.ts` ~L1519–1646, next to `suggestionCardPatch` at L1566),
  when `permission && isDesktopActionTool(event.tool)`, attach the last
  settled desktop action's verdict (`landed | target_changed |
  unverifiable` + retry count + partial-batch summary) as an additive card
  field, rendered beside `rehearsal`/`why` in
  `src/components/ApprovalCard.tsx` / `PendingApproval.tsx` (same rule as
  `approvalHistory`: **evidence, never a verdict**). `target_changed` also
  feeds the existing stop vocabulary (`server/desktop-guardrails.ts`
  `app_changed`/`target_absent`) so the chip and the card cannot disagree.
  First verdict for a thread ⇒ omit the field; the card stays byte-shaped
  like today's with nothing to show.
- **Files:** `server/index.ts` (additive hunks only — card build region),
  `server/contracts.ts` (additive card fields),
  `src/components/ApprovalCard.tsx` + `PendingApproval.tsx` (+ their
  `.test.ts`), `server/desktop-validation.ts` (a `verdictCardPatch`-style
  pure helper beside `suggestionCardPatch`), new
  `server/desktop-validation-card.test.ts`.
- **Tests:** verdict → patch (omitted when absent; never mutates
  suggestion/why/rehearsal fields); render test (evidence row appears, does
  not add any button that answers the card); a `target_changed` verdict
  surfaces the matching stop chip; full suite before commit.
- **Attribution:** Muster-side composition of S1's module — cite S1's
  header, no additional upstream material.
- **Conflict flags:** 🟡 `server/index.ts` shared hot file — keep hunks
  inside the `request.opened` build; 🟡 `src/state/store.tsx` only if the
  card type must move (prefer `server/contracts.ts`); do not open
  `SettingsModal.tsx`/`SettingsPrimitives.tsx` (desktop-parity stream).

### S4 — PocketCtrl host connector profile (mount, verify, gate)
- **What:** make the *external* control plane consumable without copying a
  line: document + fixture-verify a `custom-mcp.ts` profile for
  `mcp/pocketctrl-host-server.mjs` — `command: node`, args = the user's
  installed path, env `POCKETCTRL_CONTROL_TOKEN` (user-supplied; env-only),
  scoped `bots: [owner desktop bot]`, `enabled` opt-in. Verify (do not
  assume) the permission path: a `request.opened` with
  `requestType: "permission"` and `callKey(event.tool, …)` (`server/index.ts`
  L1874) must fire for these tools on every driver family Muster mounts
  (`server/mcp-client.ts` consumers), and S2 must hold under `autoApprove`.
  No new routes; no `McpServersSection.tsx`/`SettingsModal.tsx` edits — the
  section already exists (desktop-parity owns the modal).
- **Files:** new `server/pocketctrl-mcp.test.ts` (fixture: a PocketCtrl-shaped
  stdio server written fresh from `mcp/README.md`'s tool list — extend
  `server/testing/fake-mcp-server.mjs` conventions; **do not copy their
  `.mjs`**), `server/custom-mcp.ts` / `server/custom-mcp.test.ts` only if a
  validation gap is reproduced first (reproduce before fix), and a plan-doc
  subsection here or `docs/plans/` note for the profile shape. Optional
  wiring read-only: `src/components/McpServersSection.test.ts` patterns.
- **Tests:** read tool settles without a card; each write tool opens a
  permission card and stays open with no answer; under `autoApprove` the
  write still returns `null` from `autoDecision` (S2); env redaction keeps
  the token out of `GET /api/mcp-servers` (existing `toWire` behavior
  asserted with the fixture); never spawn against a live PocketCtrl app in
  tests — fixtures only.
- **Attribution:** **no verbatim upstream code** — the fixture is written
  from their documented tool list (facts); test comment cites
  `mcp/README.md` + this study. If an implementer ever copies their `.mjs`
  for any reason, it is MPL-covered: keep its SPDX header + the §2
  attribution header, and isolate it rather than merging it into Muster
  modules.
- **Conflict flags:** 🟡 `server/index.ts` if the card path needs a probe
  (land after S3 to avoid self-conflict); 🔴 `src/components/SettingsModal.tsx`
  + `SettingsPrimitives.tsx` + `McpServersSection.tsx` sit behind the
  desktop-parity stream — **no UI edits; API + tests only**.

### S5 — Per-capability desktop grants (view / input; default off; grant lifetime)
- **What:** adopt the grant-matrix shape (§3.1 #2) on Muster's existing
  gate instead of one binary switch: `view` (preview/screenshot — already
  how it behaves) stays the baseline; `input` (desktop actions/tools) is a
  separate explicit grant, default off; grant **lifetime** is explicit —
  session (discard when hosting/app stops) vs persistent (descriptor
  survives restart) — and per-device revocation wording attaches to
  `server/devices.ts` rows. Surfaces: capability reporting in
  `src/components/DesktopCapabilities.tsx` + `src/lib/desktop.ts`, the
  per-bot toggle in `src/components/ComputerPanel.tsx`, enforcement at the
  existing gate (`electron/computer-access-sender.mjs` sender check +
  `electron/cua-runtime.mjs` `computer-access-off` reason) and the server
  side of the descriptor lifetime in `server/local-computer.ts`.
- **Tests:** `electron/computer-access-sender.test.mjs`,
  `electron/cua-runtime.test.mjs`, `electron/capabilities.test.mjs`,
  `server/local-computer.test.ts` extended for the two lifetimes + default
  off; `node --check` on touched `.mjs`; full suite.
- **Constraints:** approvals stay human — a grant is a human flip, never a
  bot tool result; saved choices/sessions preserved (existing on/off
  preference must keep meaning what it meant); **iOS untouched**; no
  security claims (state capability facts as reported by platform APIs,
  wording stays "macOS may ask…").
- **Attribution:** semantic port of the *vocabulary* (labels/defaults);
  their Swift UI is not copied. If any literal default/label set is reused,
  add the §2 attribution header naming upstream + MPL-2.0.
- **Conflict flags:** 🔴 `electron/main.mjs` was dirty in the tiptour
  study's ledger (desktop-parity stream) — **re-check `git status` and do
  not start while that file is uncommitted**; 🟡 `SettingsModal.tsx`/
  `SettingsPrimitives.tsx` remain off-limits (keep grant rows in
  `DesktopCapabilities.tsx`/`ComputerPanel.tsx`).

### S6 — Live This-Mac frame on the pending desktop card (see before you allow)
- **What:** attach the freshest available frame to a desktop permission card
  — reuse the existing screenshot route (`POST /api/local-computer/screenshot`
  in `server/index.ts` L8002, same session/ownership guards; browser-session
  frames from `server/browser-panel.ts` for browser tools) as an additive
  optional `frame` field, rendered as a plain image in
  `ApprovalCard.tsx`/`PendingApproval.tsx` with the evidence row from S3.
  The human sees what the bot sees before Allow — the supervision idea from
  `docs/computer-use.md`, on Muster's existing card.
- **Files:** `server/index.ts` (additive), `server/contracts.ts` (additive),
  `ApprovalCard.tsx`/`PendingApproval.tsx` + tests; no new endpoints if the
  screenshot route's auth model already covers it (verify, don't assume).
- **Tests:** frame omitted when capture fails or no frame exists (card must
  render byte-identically without it); ownership: the frame field only ever
  carries bytes for the asking session's own bot (extend the existing
  screenshot-route tests, don't invent a new exposure); full suite +
  playwright for the card.
- **Attribution:** Muster-only composition; the "supervising viewer"
  provenance is this study (§4.1), no upstream code.
- **Conflict flags:** 🟡 shared `server/index.ts`; ⚠ renders beside, never
  inside, the mascot/route-shell surfaces — stability contract first.

**Deferred / owner-gate (not scheduled):** grant rows inside
`SettingsModal` (desktop-parity stream), anything native (`ios/**` — §5
map), live-frame streaming quality work (no stream exists), Wake-on-LAN,
device-revocation UX polish on `server/devices.ts` (fold into S5 if cheap).

---

## 7. What NOT to do (scope guardrails)

1. **Do not port the remote-desktop core** — Swift capture/encode/UDP/Bonjour
   stack, viewer apps, adaptive bitrate, Wake-on-LAN. That is a second
   product line, it collides with the stability contract's layout/route-shell
   preservation, and Muster's This-Mac + box + browser-panel surfaces already
   cover the *agent* side of seeing a screen. **The overlap is the guardrail
   semantics and the grant vocabulary — not the stream (#3, #2, not #1, #16,
   #17).**
2. **Do not port PocketCtrl's Computer Use provider flow.** Muster is
   multi-engine (`server/drivers/`); their OpenAI-only, screen-to-OpenAI
   supervisor path would both duplicate the engine layer and introduce a
   data-flow Muster hasn't designed for. Take the *guardrail semantics*
   (S1), never the provider, model catalog, or pricing JSON.
3. **Do not let any of it weaken the approval moat.** No new non-human
   answer path; `autoDecision` only ever narrows (S2); their ephemeral
   Allow, prompt-only safety rules, and "supervise yourself" posture are
   precisely what Muster's why-journal/rehearsal/history/Watch replace.
   Never auto-answer pairing/credential reads.
4. **Do not replace or touch login.** No pairing feature may become a Muster
   auth mechanism; the OTP stream owns every auth/login file — additive-only
   at absolute most, and none of these slices need them.
5. **Do not change iOS.** No `ios/**` edits; **bundle IDs, entitlements, and
   App Groups never change**; Watch approval flow stays exactly as shipped.
6. **No branding, no claims.** No PocketCtrl name/logo/"official" framing or
   github.com links in user-facing UI; docs/headers only for attribution.
   No security claims anywhere ("their protocol is unaudited" is *their*
   statement — we neither endorse nor repeat it as ours). No deployment
   claims; a push is not a receipt.
7. **No bundling or installing their app, DMG, Sparkle feed, release
   scripts, or website vars.** S4 is an opt-in profile for a separately
   installed app; Muster ships none of their bytes. Never contribute upstream
   (CLA), never open issues/PRs there.
8. **No credentials beyond env/secrets** — the control token is env-only in
   tests and config; never logged, never echoed to the renderer (the
   existing `toWire` redaction is the model), never committed.
9. **No demo-server contact:** never point a fixture, preview, or test at
   `127.0.0.1:8845` or stop/revise anything running there; owned free ports
   + throwaway `OMB_DATA_DIR` only. Excluded parallel-session paths stay
   byte-identical (§6 preamble).
10. **Do not build a second control plane.** Their loopback API + our
    `server/fleet-mcp.ts` + `custom-mcp.ts` mounts stay distinct; Muster
    remains the door external agents walk through, with `send_task` the only
    writer and no approvals/credentials tools exposed.

---

## 8. The 5-step eval (style of `astra-gpt6-mvp-brief.md` §4)

Runnable without any PocketCtrl app installed (fixture path); the real-app
path is noted in step 2 for an owner machine only.

1. **Pair & connect:** stand up an owned dev stack on an explicit free port
   and a throwaway data dir (never `127.0.0.1:8845`), pair as a CLI client
   (`muster pair --local --port <owned>`, or the owned harness
   `e2e/pairing-harness.ts`), then connect as MCP client (`muster mcp` →
   config → handshake).
2. **Mount the host profile:** register a PocketCtrl-shaped stdio server via
   `POST /api/mcp-servers` (fixture `pocketctrl_host` built fresh from
   `mcp/README.md`'s tool list; on an owner machine that has their app
   installed, the same steps mount the real
   `mcp/pocketctrl-host-server.mjs` with `POCKETCTRL_CONTROL_TOKEN` from
   env) and confirm `POST /api/mcp-servers/test` is green.
3. **Run the same task three ways and record evidence:** (a) `status` read →
   expect `settled` with the host status relayed; (b) a write
   (`pocketctrl_host_stop`) with the bot in **auto mode** → expect
   `needs-user` with card title + options relayed **verbatim** and the call
   still open after 30 s of silence — this is the differentiator, and it
   fails if S2 didn't land; answer **Deny** → nothing executed; (c) a
   This-Mac desktop step where the target has moved → expect a
   `target_changed`/budget stop on the card (S1/S3), **not** a silent hang
   and never an invented fallback click.
4. **Pull proof:** `get_receipt` + `get_approval_history` → the output must
   be self-explanatory proof-of-work — tool name, decision, who/when, the
   validation verdict and grounded suggestions as evidence — with no
   transcript spelunking.
5. **Score:** escalation correctness (3/3 paths), never-auto-answer
   correctness (0 write tools machine-answered), evidence completeness
   (why + rehearsal + suggestions + verdict present on desktop cards),
   tokens/cost per task, and the gate: server typecheck + `npx tsc -b` +
   `npx oxlint .` (0/0) + focused vitest + full `npx vitest run` +
   playwright against **the latest baseline at the top of
   `docs/plans/current-state.md`** — report real numbers, and state any
   decrease from that baseline explicitly.

---

## 9. Recommended first move for an implement-only agent

**Slice S1 only:** create `server/desktop-validation.ts` +
`server/desktop-validation.test.ts` (clean-room classification +
segment-bound + partial-batch semantics, distinct type names, pure/no-I/O),
run `npx vitest run server/desktop-validation.test.ts`, then
`npx tsc --noEmit -p tsconfig.server.json`, `npx tsc -b`, `npx oxlint .`,
and the full `npx vitest run` before any commit — new files only, zero
conflict with every live stream. Then S2 (pure, own commit). Hold S3 until
you've re-checked `git status --short --untracked-files=all` around
`server/index.ts`, and hold S5 entirely while `electron/main.mjs` or
`SettingsModal.tsx`/`SettingsPrimitives.tsx` are dirty.

---

*Written by the research/planning subagent (read-only pass): upstream mined
2026-09-23 via webfetch (repo page, LICENSE/LICENSING/NOTICE/SECURITY/
TRADEMARKS/GOVERNANCE/CONTRIBUTING/CLA, READMEs, all docs, MCP bridge, CLI
source, CI, GitHub tree/commit APIs). No git commands run, no tests executed,
no services started, no existing file modified — this document only.*
