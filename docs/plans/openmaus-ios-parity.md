# OpenMausBot → Muster iOS parity map

Teardown of the OpenMausBot iOS companion (read-only source snapshot,
Apache-2.0, github.com/milind-soni/OpenMausBot) against Muster's
`ios/` tree, and the record of what was ported, what already existed in
equivalent form, and what is deliberately deferred. Implement-only pass:
every "shipped" row below is in the tree; every "deferred" row is a
decision left to the owner, not taken here.

Verification for this pass (real runs, this machine, Xcode 26.6):

| Gate | Result |
|---|---|
| `cd ios && swift test` | **457 passed / 0 failed** (baseline before this pass: 435; +22 new tests) |
| `xcodebuild -project ios/MusterCompanion.xcodeproj -scheme MusterCompanion -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build` | **BUILD SUCCEEDED** (app + FleetWidget + embedded watch compiled; `xcodegen generate` re-run first for the new `App/` files) |

No root Vitest/oxlint run (out of scope for this slice). No deployment
claim of any kind.

## Parity map

Status key: **Now** = shipped in this pass · **Eq** = Muster already had
an equivalent surface (not rebuilt) · **Deferred** = kept out on purpose,
reason in the column · **Owner** = needs an owner decision before anyone
builds it.

| OpenMausBot surface | Muster target | Status | Note |
|---|---|---|---|
| Settings: colored `SettingsIcon` tiles, notifications row w/ status + a11y hints | `ios/App/SettingsView.swift` | **Now** | Same actions, Muster copy preserved (APNs-relay footer, unpair flow) |
| Settings → computer row w/ status dot → `ConnectionSecurityView` (full address show/copy, troubleshooting, "Try reconnecting") | `ConnectionDetailsView` in `SettingsView.swift` | **Now** | Reach via the Computer row; reconnect = `session.refresh()` |
| Settings: "Edit address" | — | Deferred | Needs a `Session.updateAddress` capability this client does not have (single saved connection, Keychain-keyed) |
| Multi-computer list (`ConnectedComputersView`, switch/forget, "Connect another computer") | — | Deferred | Muster pairs with **one** computer (`connectionKey "companion.connection"`); a saved-connection store is a Session feature, owner-gated |
| Settings → Quick Replies link | `SettingsView` "Chat" section → `QuickRepliesEditor` | **Now** | |
| Quick replies model (`QuickReply`, defaults, icon choices, decode rules) | `ios/Sources/CompanionCore/QuickReplies.swift` + `QuickRepliesTests` | **Now** | Storage key `companion.quickReplies`; empty-string ≠ cleared-list rule kept and tested |
| `QuickRepliesEditor` (add/edit/reorder/delete/reset) | `ios/App/QuickRepliesEditor.swift` | **Now** | |
| Composer chip row (`PredictiveActionChipsView`) | chip row in `ChatView.composer` | **Now** | Visible only when draft empty, composer editable, not dictating, bot not busy, no pending card; tap edits+submits through the same composer lease as a typed send. Styled in Muster's glass language rather than OMB's hex chips |
| Updates pill (`UpdatesPill` + `MascotStack`) | `UpdatesPill` + `UpdateStack` (flowers) in `ios/App/UpdatesViews.swift`, under the roster header | **Now** | Classification lives in `CompanionCore/FleetUpdates.swift` (threadId-keyed, tested in `FleetUpdatesTests`) |
| Updates sheet (Needs you / Working / To review) | `UpdatesSheet` + `UpdateRow` | **Now** | Rows **navigate to the chat** — see deviation below |
| Inline answer pills in the sheet | — | Deferred | **Approval-lease design**: `ApprovalActionCoordinator` requires an active view lease whose context is the conversation itself; answering from a sheet answers outside the context being viewed. Rows show "Open the chat to answer" instead |
| `TypingIndicatorView` (busy, nothing streamed yet) | `ios/App/TypingIndicatorView.swift`, shown in `ChatView` when `current.busy` and no stream/reasoning | **Now** | Near-verbatim port |
| `SelectableTextSheet` + "Select Text" context menu | `ios/App/SelectableTextSheet.swift`; menu entry on messages with text | **Now** | Also added OMB's "Copy" menu entry |
| `Haptics.selection()` | `ios/App/Haptics.swift` | **Now** | Used by chip taps, editor icon tiles, pill tap |
| Fleet widget / Live Activity / Dynamic Island | `FleetWidget.swift`, `FleetActivitySync.swift` | **Eq** | Muster already ships OMB's Island equivalent — deliberately not rebuilt |
| Onboarding | `WelcomeView.swift` | **Eq** | |
| Task list per bot | `TaskManagerView.swift` | **Eq** | OMB's Tasks surface |
| Computer panel | `ComputerView.swift` | **Eq** | |
| Reactions, edit-and-retry, versions, export/share | `ChatView.swift` | **Eq** | |
| Walkie (hold-to-talk) | `WalkieView.swift` / `WalkieVoice.swift` | **Eq** | |
| OptionCard approvals, seed cards | `SeedCardView.swift`, `CardView` | **Eq** | |
| Search, dictation, streaming bubble | `ChatListView` search, `Dictation.swift`, `StreamingBubble` | **Eq** | |
| Glass surfaces | `Glass.swift` | **Eq** | Already an OMB-derived port carrying its own Apache-2.0 header |
| ShareExtension (share into a chat) | — | **Owner** | Needs a **new bundle id, App Group, and entitlements** — identity/signing changes are owner-gated, never taken in a port pass |
| `AgentProfileView` (per-bot avatar/effort profile) | — | **Owner** | Needs server profile routes; Muster's `Bot` record has no `avatarCrop`/effort fields — a server contract change |
| Island intro / ActivityDetail prefs (`IslandIntro`, `ActivityDetail` pickers) | — | Deferred | OMB-only: Muster's transcript has no activity-detail folding setting and no island intro animation |
| App language picker (`AppLanguage`, `Localizable.xcstrings`) | — | **Owner** | Localizing the app is an owner-scoped release decision (string catalog + CI) |
| Attachments (`+` menu, pending chips), `CommandSkillHUD` | — | Deferred | Muster's composer contract has no attachment transport; slash-command HUD is an OMB server feature |
| New group / new section sheets | — | Deferred | OMB admin scopes; Muster creates bots from the roster `+` and rooms are server-created |
| `TasksRoutinesView`, `ConnectedAppsView` (settings workspace) | — | Deferred | Need Muster server routes (routines, composio apps) that do not exist in this client |
| Cards: `GitPRDiff`, `SQL`, `SkillReceipt`, question cards, secret/credential card | — | Deferred | No corresponding Muster wire kinds; `Message.Kind` would degrade them to `.unknown` text (by design) |
| Send queue surfaced as updates (`pendingQueued`, capacity holds) | — | Deferred | Muster has no client-side send queue state to headline |
| OMB test targets (`ConnectionRegistryTests`, `ProfileClientTests`, island tests, …) | — | Deferred | Each needs the missing Session/server capability above; the two ported behaviors **are** covered (`QuickRepliesTests`, `FleetUpdatesTests`) |

## Deliberate deviations (port ≠ copy)

1. **Sheet rows navigate, they do not answer.** OMB's updates sheet shows
   the card's options as tappable pills. Muster answers approvals under a
   view lease bound to the open conversation
   (`ApprovalActionCoordinator`); answering from a sheet would submit
   outside the viewed context. Preserved the safety property; the row
   opens the chat instead.
2. **Single connection.** No switcher, no saved-computer list, no address
   editing — this client's Session pairs with one computer. The details
   page shows, copies, diagnoses and reconnects; **Unpair stays on the
   main Settings screen** where Muster has always kept it (not moved one
   level down as OMB does).
3. **Flowers, not maus.** Faces in the pill/sheet are `FlowerAvatar`;
   palette is `AgentPalette`. Brand preserved.
4. **Wire differences honored.** Updates classification reads Muster's
   `busy`/`unread`/`busyBotId` and `pendingApprovals`, keyed by
   `threadId` — not OMB's ordered task activities.
5. **Muster copy kept** wherever the two apps phrase the same thing
   (notifications footer, unpair dialog, "Not here" section).

## Attribution

Near-verbatim ports carry a one-line Apache-2.0 header pointing at
`public/third-party-notices.txt` (same pattern as `ios/App/Glass.swift`):
`TypingIndicatorView.swift`, `SelectableTextSheet.swift`,
`QuickRepliesEditor.swift`, `Haptics.swift`, `QuickReplies.swift`,
`FleetUpdates.swift`, `UpdatesViews.swift`, and the row/tile section of
`SettingsView.swift`.

## Owner-gated decisions (not taken here)

- Share extension: new bundle id / App Group / entitlements.
- Agent profile screens: server profile routes + `Bot` fields.
- App-language localization: string catalog + release process.
- Multi-computer support and saved-address editing: a Session feature
  decision (connection store), not a UI port.
- Inline approval answering outside the conversation: would change the
  approval-lease contract — explicitly left alone.
