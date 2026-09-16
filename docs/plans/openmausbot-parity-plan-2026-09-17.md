# OpenMausBot parity plan for Muster — web app, features, and audits

Written 2026-09-17, after reading the full `docs/audits/` folder
(`repository-audit-2026-08-19.md`, `audit-strategy-2026-08.md`,
`security-logic-audit-2026-09-01.md`, `skills-integrated-2026-08.md`,
`monetization-tiers-2026-08.md`), the strategy docs (`astra-gpt6-mvp-brief.md`,
`competitive-landscape.md`, `openmausbot-design-study.md`, `current-state.md`,
`remaining-work-plan-2026-09-16.md`, `openmaus-onboarding-study-2026-09-12.md`,
`hermex-mausbot-ios-study-2026-09-17.md`, `muster-store-spec-2026-09-14.md`,
`voice-auth-agents-plan-2026-09-15.md`), the OpenMausBot README, and a direct
inspection of the working tree (`src/App.tsx`, `src/components/`, `server/drivers/`,
`src/components/os/`). This is a plan, not a claim of work done.

## 0. The one thing to decide first — "same design" conflicts with the standing owner contract

The request is to bring OpenMausBot's desktop-app design into the Muster web app.
Two standing owner instructions say the opposite:

- `AGENTS.md`: *"Preserve the current layout, mascot, route shells, saved choices
  and user sessions. Audits should fix reproduced defects; do not use them to
  redesign the app again."*
- `docs/guides/web-app-stability.md`: *"An audit is not permission to replace
  navigation, defaults, branding or the entire interface again."*

So this plan does **not** clone OMB's visuals. It takes OMB's **interaction
patterns and genuinely-missing features** and implements them in Muster's own
components, mascot and layout. A true visual redesign is a scope change that
needs an explicit, dated owner override; until then the compliant path is the
one below. If the owner does want the redesign, say so and the pattern list
becomes a skin list instead.

## 1. What Muster already has (verified by reading the tree — do not rebuild)

| OMB capability | Muster equivalent | Status |
|---|---|---|
| Model picker per bot | `src/components/ModelPicker.tsx` | Parity |
| Responsive chat header (compacts when the column narrows) | `src/components/ConversationHeader.tsx` + `conversation-header.css` | **Already matched** — the OMB pattern the design study queued is shipped |
| Per-task attention (waiting/working/queued reachable) | `TaskPicker.tsx`, `Sidebar.tsx` roster rows | Parity — verify sibling-task routing |
| Approval cards, Allow/Deny inline | `OptionCard.tsx` (A–F hotkeys), `ApprovalCard.tsx`, `PendingApproval.tsx`, `ApprovalWhyDetails.tsx` | **Ahead** — Muster attaches prior-run why-journal |
| Bot's computer | `ComputerPanel.tsx` | Parity |
| Connected apps / MCP | `McpServersSection.tsx`, `ConnectorCard.tsx`, `PluginsPanel.tsx` | Partial — no one-click Composio catalog |
| Manage bots like chats (pin/duplicate/hide/delete) | `Sidebar.tsx` context menus | Parity |
| Keys once, write-only | `ApiKeys.tsx`, `VaultSection.tsx` | Parity |
| Channels | `src/components/os/RoomsPanel.tsx`, `server/agent-rooms.ts` | Partial — rooms exist in the `/os` shell, not the `/app` chat shell |
| Install a team from one file | `server/team-library.ts`, `server/team-manifest.ts`, `TemplatesModal.tsx` | Parity (`.md` import) |
| Voice / bots that talk back | `CallView.tsx` (`CallButton`/`CallOverlay`), `src/lib/dictation.ts`, `voice-first-run.ts` | Partial — web call is half-duplex; W1–W3 gaps open |
| Routines + webhooks | `RoutinesPage.tsx`, `server/routines.ts`, webhook routes | Parity |
| Orchestrate over MCP | `server/fleet-mcp.ts` (bounded, read-only why-journal/scorecard) | Parity, deliberately asymmetric |
| Onboarding | `Onboarding.tsx` (7-step, canonical Flower) | Parity; tour pacing gap open |
| Backups | `PortableBackupCard.tsx`, backup v2 module (inert, no route) | Module only, not wired |
| Receipts / evidence | `ChatView.tsx` `JobReceiptModal` + `ReceiptShareButton`, `server/receipts.ts` | Parity |

Conclusion the audits already reached: Muster is **level or ahead** on approvals,
voice-on-mobile, receipts and bounded MCP. The gaps are narrower than OMB's
feature list implies.

## 2. What is genuinely missing (the real work)

1. **Remote-access client mode.** `RemoteAccessSection.tsx` has server-side
   pairing (Secure HTTPS / Tailscale / Direct Wi-Fi, scopes, paired devices) but
   no *client role* — "Connect to another computer" with a 6-digit desktop-
   companion code and a `https://host/pair#code=XXXX-XXXX-XXXX` self-hosted link
   (12 chars, query-string codes rejected), plus a secure remote-access account
   (email one-time code) and a connection-details reveal. This is the largest
   user-value gap.
2. **Engines "Add account" flow.** `EnginesSettings.tsx` shows Ready / Needs
   setup, version and `Set up`, but there is no account-add path (subscription
   OAuth vs API key vs Bedrock/Vertex) or config-dir reuse.
3. **Channels in the chat shell.** Rooms live only in `/os`. OMB's channels
   (per-context transcript + shared instructions + roster) map onto the existing
   `server/agent-rooms.ts` model; exposing them in `/app` is additive, not a
   redesign.
4. **Composio-style connected-apps catalog.** A one-click marketplace over the
   existing connector/proxy plumbing. Muster has the broker; it lacks the
   browse-and-OAuth surface.
5. **Tour pacing + engine-readiness recovery** (from `openmaus-onboarding-study`):
   user-paced tour, hold the last panel, label examples as simulations; keep
   last-known engine inventory on refresh failure with a separate error + Check
   again.
6. **Voice parity gaps W1–W3** (from `voice-auth-agents-plan-2026-09-15.md`):
   mute/captions/spoken-end-call in `GroupCallView`; spoken-register markdown
   rewrite before TTS; caption word-cursor.
7. **Mobile return-key / thread-switching edges** — OMB shipped live fixes for
   these (`#1335`, `#1317`); check MusterMobile's composer and thread switching
   for the same bugs.

## 3. Ranked feature slices (small, verifiable, additive)

| # | Slice | Why | Touched surface | Gate |
|---|---|---|---|---|
| 1 | Remote-access **client mode** + self-hosted pairing link | Biggest real gap; lets a desktop drive a remote server | `RemoteAccessSection.tsx`, pairing routes | focused tests + pairing-link parse tests (reject query-string codes) |
| 2 | Engines **Add account** flow | Second real gap; unblocks provider setup | `EnginesSettings.tsx`, `EngineSetup.tsx`, `GET /api/instances` | account-add happy path + failed-auth path |
| 3 | **Channels in `/app`** over `agent-rooms` | Parity, additive | `Sidebar.tsx`, chat shell, `server/agent-rooms.ts` | channel switch preserves task identity |
| 4 | Connected-apps **catalog** | Completes the connector story | `ConnectorCard.tsx`, `McpServersSection.tsx` | one-click connect + revoke |
| 5 | **Tour pacing** + engine-readiness recovery | From the onboarding study; accessibility | `Onboarding.tsx`, `EnginesSettings.tsx` | reduced-motion, keyboard, 320px |
| 6 | Voice **W1–W3** | Closes a measured gap | `GroupCallView.tsx`, speech helper | pure-function TTS tests |
| 7 | **Mobile return-key / thread-switch** audit | OMB hit live bugs here | `ios/App/ChatView.swift`, thread switching | reproduce before change |

Ordering rationale: 1–2 are genuinely missing; 3–4 are parity; 5–7 are polish
and defect work that the audits already queued.

## 4. Blockers that only the owner can clear (unchanged from the remaining-work plan)

1. **GitHub Actions billing** — no CI, no Windows/Linux legs.
2. **`APPLE_CERTIFICATE` secret** holds an Apple Development cert, not Developer ID.
3. **SSH to the mirror VPS** refused for every key.
4. **Apple Beta App Review** — nothing to fix locally.

## 5. Explicitly not verified

- No OMB binary was run; no competitor test executed.
- The "eleven engines" figure remains a documentation claim, not re-verified.
- The OMB parity list comes from reading its README/shipped strings, not from
  exercising its pairing or account-add flows.
- No security claim: the last full security scan did not complete cleanly.

## 6. Verification discipline (per the stability contract)

Each slice: state defect + expected behavior + smallest touched surface;
reproduce first; owned fixture, explicit free ports, isolated `OMB_DATA_DIR`;
GET-only production checks; record real focused/full test counts in
`current-state.md` and `ceo-log.md`. Never stop port 8845 or any user service.
Keep existing automation paused.