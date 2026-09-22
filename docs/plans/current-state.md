

### Owner stop / superseding Loop144 handoff — 19 September 2026

Goal PAUSED at owner's request. Loop144 remains UNCOMMITTED; no product push or
deployment is claimed. Latest HEAD `e5b62dd` includes another agent's plugin-react
5.2.0 and Vaultgram lockfile changes. The 321-file/4821-pass/8-skip unit gate,
41/41 browser and14/14 packaged results above predate this dependency merge.
Merged full unit session44632 and lint90558 have no collected terminal result;
build16180 log reports14.12s but exit is not collected. Frozen install passed.
Full details, exact logs, ownership and remaining beta work are in
`docs/plans/astra-handoff-2026-09-19.md`, whose opening STOP section supersedes
older ready-to-commit statements. No new tests or product edits after the stop.

Successor FIRST priority: coordinate with release agent and diagnose GitHub
Autodeploy35469518670 failure at “Bump .deploy-trigger”, inspect newer CI and
merged-dependency checks, fix forward without bypassing gates. Other observed
CI runs succeeded; do not claim every build failed. Release workflows remain
the other agent's responsibility. Automation stays paused; production receipt,
real Google/hardware, hosted recovery/sync and15 tester-days remain outstanding.

### Mobile/Watch round — Slice 1: Watch crown scrolling (22 September 2026, Loop166)

Owner-directed mobile+Watch round, questions locked before building. Slice 1 ships
crown-driven fleet scrolling (musterwatch plan §3.6 #4), which was absent — no
`FocusState`/`focusable`/`digitalCrown` in `ios/` before it. A pure
`FocusDetentTracker` in CompanionCore owns the detent rule (entering a screen is
silent, each move between distinct rows clicks once, focus loss resets); every
fleet row carries a focus binding, a `.click` when the tracker says yes, and a
visible focus tint. Also repaired `ios/project.yml`: its `schemes:` block never
declared `MusterWatch`, so the README's documented watch build exited 65.

**Verified this slice:** `cd ios && swift test` **407 tests / 0 failures**
(baseline 399, +8); iOS simulator build **BUILD SUCCEEDED**; watchOS simulator
build **BUILD SUCCEEDED**. Compile + unit + simulator-build evidence only — no
physical Watch, no observed crown-detent feel. Remaining in this round, all
designed-not-built: reply-arrives/answered/bot-finished Watch haptics, phone
SFSpeechRecognizer dictation, Android deep-link + QR pairing. Owner-held hardware
acceptance still open. Unrelated working-tree edits preserved untouched.

### Mobile/Watch round — Slice 2: Watch haptic vocabulary (22 September 2026, Loop169)

Slice 2 ships ranked #3: a distinct felt event for approval arrival, approval
resolution, reply arrival and bot-finished. Reproduced defect first: three sites
owned fleet haptics between them (session mood transition, fleet-view count
change, coordinator confirm) and none owned an event — one approval played
`.notification` twice, a new reply played that *same* `.notification`, and a bot
finishing played nothing. Now one pure `FleetHapticPlanner` in CompanionCore
decides which single event each frame is (arrival `.notification`, answered
`.stop`, reply `.success`, settled `.directionUp`, started `.start`), priority-
ordered so one frame makes one pulse; the watch maps events to
`WKInterfaceDevice`. Fleet-view count buzz and coordinator confirm buzz removed —
an answer now pulses with the frame that resolves the card — and a live-guard
plus a `client.didSet` reset make hydrate, pairing wipes and sign-out silent
baselines.

**Verified this slice:** `cd ios && swift test` **417 tests / 0 failures**
(Slice 1 baseline 407, +10 FleetHapticsTests); iOS simulator build **BUILD
SUCCEEDED**; watchOS simulator build **BUILD SUCCEEDED**. Unit + simulator
evidence only — no hardware, no observed pulse, no claim that `.directionUp`
reads distinctly from `.click` on a wrist. Remaining this round: phone
SFSpeechRecognizer dictation, Android deep-link + QR pairing. Owner-held
hardware acceptance still open (haptic acceptance checklist to follow at round
end). Unrelated working-tree edits preserved untouched.

### Mobile/Watch round — Slice 3: phone composer dictation (22 September 2026, Loop170)

Slice 3 ships SFSpeechRecognizer dictation behind the composer mic — the
"no affordance without a feature" note in the iOS README said the mic was
undrawn because dictation did not exist; both now do. The words are owned by
a pure `DictationFlow` in CompanionCore: it snapshots the draft at mic-tap
(typed text is carried, never rewritten), each recognition result *replaces*
the capture's tail (a `bestTranscription` that appended would duplicate every
word on every result), the draft's own trailing whitespace decides the join,
and every ending — stop, dead screen, refusal — commits or preserves rather
than drops. It has no send: dictated text waits for the send button like
typed text. The iOS side (`App/Dictation.swift`) reuses Walkie's proven
`TalkSession` capture engine untouched, requests speech + microphone
permissions with distinct messages per Settings pane, and feeds results into
the flow; ChatView draws the mic/stop toggle, a live "Listening" line, the
refusal line, and disables the field and send during a capture so the
recogniser's write-back cannot race the keyboard. Both Info.plist usage
strings now name Walkie *and* dictation (project.yml reworded, xcodegen
re-run).

**Verified this slice:** `cd ios && swift test` **435 tests / 0 failures**
(Slice 2 baseline 417, +18 DictationFlowTests); iOS simulator build **BUILD
SUCCEEDED**; watchOS simulator build **BUILD SUCCEEDED**. Unit + simulator
evidence only — no microphone captured, no permission prompt observed, no
recognition accuracy claimed; the audio path is Walkie's existing engine,
unexercised here. Remaining this round: Android deep-link + QR pairing.
Owner-held hardware acceptance still open (dictation is on the acceptance
checklist). Unrelated working-tree edits preserved untouched.

### Mobile/Watch round — Slice 4: Android deep-link + QR pairing (22 September 2026, Loop171)

Final slice of the round. The companion's README stated the gap plainly ("QR
scanning and automatic deep-link delivery remain unimplemented"); the
`muster://pair` invitation grammar and the paste-never-sends invariant
already existed, so this slice adds **delivery only** — both routes validate
through the same parser (`pairingFillFromExternalText` in core) and fill the
address field; nothing ever pairs until the person taps Pair with computer.
A deep link arrives through RN `Linking` (cold-start `getInitialURL` + `url`
events) while PairingScreen is mounted — which is exactly when the app is
unpaired, so a link opened while paired meets no listener. QR opens a new
`PairQrScanner` (expo-camera `CameraView`, already a dependency; the
permission prompt fires only on Scan-tap, one scan delivered per mount,
denial explains instead of re-prompting). `app.json` gains
`"scheme": "muster"` so the Android intent filter exists at all. Arrivals
replace typed text (they are deliberate acts), invalid arrivals show one
honest error and touch nothing, and arrivals during an in-flight attempt
are ignored while fields are frozen.

**Verified this slice:** `cd android-companion && npm test` → **12 suites /
573 tests / 0 failed** (baseline 555, +18); `npm run typecheck` → 0 errors;
`npm run lint` → **0 warnings / 0 errors** (48 files). JS-host evidence only
— no camera permission prompt, no real scan, no real tapped link; device
acceptance remains owner-held. **Round complete on all four locked
slices**: crown scrolling, haptic vocabulary, phone dictation, Android
delivery. Owner-held hardware acceptance (Watch/iPhone/Android) is now the
open gate; the acceptance checklist is `docs/guides/mobile-round-acceptance.md`.
Unrelated working-tree edits (claim-flow, www/*) preserved untouched.

### AGI-harness round — Fleet MCP `list_sessions` completes ranked slice 2 (22 September 2026, Loop173)

The Astra brief's ranked slice 2 ("write-safe extensions") had shipped
`get_why_journal` and `get_scorecard` but never the discovery read the
brief names first: an external agent could reach a thread id only from
`wait_for_conversation`, because all seven `/api/threads/...` routes are
per-thread and no list endpoint exists anywhere. `list_sessions` closes
the gap with **no new server route** — `GET /api/bots/:id?messages=0`
already carries `tasks[].threadId/title/createdAt/usage` through
`wireTask`, so the 11th bounded tool projects them to
`{sessions, count, activeThreadId}`, flags the active session, strips
`cwd`, and reports a taskless legacy record as its one active thread
instead of an empty list. GET-only, strict `botId` args, a 404 stops
before any projection. `get_receipt`'s description now credits the tools
that actually emit thread ids (`fleet_status` never did). Stale counts
refreshed where they had drifted: AGENTS repo map (8→11), brief
capability table (8→11 tools, 73 tests) + ranked item 2 marked shipped,
public agents page (said "Six", now the full eleven).

**Verified this slice:** `npx vitest run server/fleet-mcp.test.ts` →
**73/73** (+6: three new behaviors — active-flag projection, taskless
legacy fallback, inaccessible-bot stop — plus three malformed rows);
delegation 6/6 + evidence 7/7 unchanged (86 across the three files);
full suite → **325 files / 4876 passed / 8 skipped / 0 failed** (488.00s;
+9 over today's earlier 4867 = my +6 plus parallel-WIP tests landing
live); server tsc exit 0; oxlint on both touched files **0/0**. Repo-wide
oxlint currently shows 1 error + 2 warnings, all in the parallel agent's
uncommitted live WIP (`social.ts` +194, `container-computer.ts`,
`env-path.ts`) — preserved, not staged, theirs to land. Evidence is
fetch-stubbed fixture behavior only — no live MCP session against a
running server, no e2e re-run (no app/React surface touched; the static
page edit is referenced by no spec). One honest incident: the first full
run reported 2 failed files/2 tests, both races with the parallel agent's
files mid-edit (container-computer's daemon test among them); an
immediate captured re-run was 325/0 with zero FAIL lines — reported as
observed, not as a flake dismissal.

### Backlog census — every remaining queue mapped (22 September 2026, Loop174)

Owner said "continue all remaining"; before building, every open queue was
audited against the tree so the next loops execute real gaps:

**Astra brief §5 — all five ranked slices now closed:** (1) eval harness
shipped (playbook + `muster eval` + capture harness + Loop157 trending);
(2) `list_sessions` completed the write-safe reads (Loop173); (3)
cross-fleet delegation ships as `send_task` `receiptRef`; (4) Watch
escalation depth ships — one-tap Allow/Deny in `WatchViews.swift` with
the previous-run why entry attached by `server/approval-why.ts`; (5)
engine parity's premise is retracted by competitive-landscape.md itself
(fixed engine counts are "not current measurements") while
`server/drivers/` spans every major provider family. Items 4/5 annotated
in the brief; competitive-landscape's stale "eight-tool" corrected to a
dated eleven.

**Voice W1–W5: only W4 (barge-in) remains.** W1 mute/captions/spoken-end
(c40ba38), W2 `speech-text.ts` applied at speak-time (`tts/index.ts:140`),
W3 `word-cursor.ts` driving `VoiceCaption`, W5 `session-controls.ts`
(quieter/louder/faster/slower + end-call) — all shipped with tests.
W4 is the next code slice (browser AEC + 250ms/200ms guard, default off;
device proof stays owner-held).

**DESIGN §38 ownership (do not collide):** L102 in flight (another
agent); S5/S6 social is the parallel agent's live WIP
(`social.ts`, `SocialView.tsx`, `store.tsx`, `server/index.ts` — never
stage those). A1–A4 and other index.ts-touching rows defer while that
WIP is live. **X5 credential vault stays spec'd-not-built** — its own
status line records a deliberate security-sensitive deferral ("shipping
a half-vault is worse than shipping none"); building it needs an
explicit owner override, not an agent's discretion. Remaining unowned
rows in order: U1–U5 (source audits: fleet-benchmark §sidebar,
agent-social §3 — store-touching sub-items collide with social WIP), P1,
K1, S0–S3, B1, M1–M2, T1, SS1, L2–L3, RC; R1 release rollout is
owner/release-agent surface.

### Voice parity completes — W4 barge-in behind a default-off toggle (22 September 2026, Loop175)

The last open voice item shipped. `src/lib/barge-in.ts` is the pure
sustained-speech guard (energy gate 0.02 RMS · 250ms sustain · 200ms gap
tolerance; Vellum's duty-cycle/echo-EMA deliberately NOT ported — a naive
duty cap cannot distinguish bot-bleed from a human talking without
pausing, and blocking a real speaker fails worse than a missed trip).
`src/lib/barge-in-monitor.ts` keeps an AEC'd getUserMedia analysis
stream open while the bot speaks (web capture path only; unsupported
capture resolves null → note + tap fallback). `src/components/CallView.tsx`
wires the trip to ONE shared `interrupt()` — Space, the Interrupt button,
and the guard all take the same path. The toggle defaults OFF, persists
in `localStorage` (`muster:barge-in`) and never touches
`src/state/store.tsx` (social-WIP-owned). Native desktop capture keeps
half-duplex by design.

**Gates:** barge-in **10/10**; focused tts+barge-in **40/40**; full
suite **327 files / 4893 passed / 8 skipped / 0 failed** (450.09s; +2
files/+17 tests vs Loop173, no decrease); oxlint **0/0** on all five
touched files; app tsc **0 errors for my files**; `vite build` ✓
(18.76s). Full `npm run build` (tsc leg) stays red ONLY on the parallel
agent's uncommitted `SocialView.tsx` (3 errors) — theirs, untouched.
**Not claimed:** real-device audio behavior (owner gate; headless has
no audio), native-path barge-in, e2e (no call e2e exists). Voice row
W1–W5 is now code-complete.

### U-row: agent-row New task · header collapse-on-scroll · composer /commands (22 September 2026, Loop176)

Three of the five U items shipped; two deferred with reasons instead of
invented. **U1:** `BotContextMenu` gains "New task" — existing `newTask`
dispatch, TaskPicker's busy rule and hint, no store edit. **U3:**
`src/lib/header-collapse.ts` pure `nextHeaderCollapse` (≤64px always
open · directional ±4px dead-zone) wired into ChatView's existing
`onScroll` before the `previousScrollTop` assignment;
`ConversationHeader` takes `collapsed` → `data-collapsed`, closes the
tools drawer on collapse; CSS hides the task/model/tools row and
tightens padding — identity + interrupt never hide and the interrupt
stays right-aligned via the last grid column. **U4:**
`src/lib/composer-commands.ts` — `commandQueryAt` mirrors
`mentionQueryAt` (word-start slash only, so URLs/paths stay literal),
`matchCommands` (six-row cap), closed `ComposerCommandId` union;
the commands are the composer's OWN actions (voice/goal/new/stop/
settings) each gated by its button's rule via `satisfies
Record<ComposerCommandId, boolean>`; unavailable Enter consumes the key
without sending literal words; rooms don't get commands.

**Deferred:** U2 drag-reorder — `store.tsx` is social-WIP-owned;
ordering the sidebar from divergent local state would lie. U5 activity
panel — name-only row, no source spec anywhere (U-row traced to
`ccbba1f`, which created DESIGN.md wholesale), and the nearest artifact
(FleetOrb dropdown) was unmounted by explicit owner direction — needs
owner shape first.

**Gates:** red 2 files → **15/15**; focused **25/25**; oxlint 8 files
**0/0** (1 `no-known-value-widening` fixed via union + `satisfies`, not
suppressed); app tsc **0 errors for my files**; `vite build` ✓ 14.72s;
full suite **329 files / 4908 passed / 8 skipped / 0 failed** (427.48s;
+2 files/+15 tests vs Loop175 = exactly this slice, no decrease).
**Not claimed:** browser/screenshot verification of the collapse or the
command picker (no chat-scroll e2e exists — pure-logic tests + CSS
only). Next per §38: P1 per-bot approval levels.

### K1 format half: recovery codes wrapping the MEK (22 September 2026, Loop177)

P1 audited first and **deferred**: its `Bot` type lives in `store.tsx`
and its spawn pass-through in `server/index.ts` — both social-WIP-owned,
the A1–A4 rule (board annotated). K1 was the next clean row (the v2
family lives in its own route table + format module, untouched by the
WIP). v2 had **no MEK** — the payload key was `scrypt(passphrase, salt)`
directly — so recovery structurally required introducing the MEK
indirection as an OPTIONAL envelope capability. Shipped:
`encryptBundleV2(..., { recovery: { codes } })` seals under a fresh
32-byte MEK; a passphrase slot (riding the envelope's own `kdf`) plus one
slot per code (`scrypt` on the normalized code with its own salt,
`slotId = sha256(canonical code)`) wrap it under AES-256-GCM bound to
`{kind, kdf, slotId}`; the slots ride the payload AAD via the
hand-listed `canonicalHeader`, whose explicit keySlots key vanishes on
legacy envelopes (JSON.stringify drops `undefined`) — **byte-identical
legacy auth** (43 existing bundle/restore tests green untouched). Codes:
Crockford base32 4x4 (80 bits), tolerant normalization, seal-time
validation (≥1, ≤16, distinct). Reads: `recoveryCode` opens exclusively
(no passphrase fallback — a wrong code can't be masked), wrong secrets
report the existing `bad-key`, the read path still never throws.
Recovery seal costs 1+N scrypt runs — uniform with the standing KDF,
recorded not hidden.

**Gates:** red 11 failed → **11/11**; bundle family **54/54** (zero
regressions) + post-fix **26/26**; oxlint **0/0** (5 errors fixed
properly: name ×2, SAFETY comment, named `MekWrap` contract,
restructured spread); server tsc **exit 0**; full suite **330 files /
4919 passed / 8 skipped / 0 failed** (449.07s; +1 file/+11 vs Loop176 =
exactly this slice, no decrease). **Not claimed:** product-reachable
recovery (no routes/UI yet — follow-up slice), security attestation
(scanner re-run still owed), legacy migration (old bundles stay
passphrase-only by design). Next per §38: S0 devices table (depends on
K1 — unblocked at the format layer).

### S0 device inventory: "Manage devices" (22 September 2026, Loop178)

S0 ships a **per-user view over the better-auth session rows** — no new
table, no migration: web sign-in, the claim-paired phone and `muster pair`
all create a session, so the session table already is the device raw
material. Rows group by user-agent (re-sign-ins collapse, newest sighting
wins); device id = sha256(userId + agent) so two accounts' identical
browsers never collide; no hardware fingerprint exists and none is
invented (stated line until S1). `keyEnvelopeStatus` is honestly "none"
on every row — DESIGN §29 names the column, the producer arrives with
S2/S3. GET /api/devices is one entry in the backup family's ordered
route table: identity from the ctx.session binding (never query/body),
Cache-Control no-store, foreign-row drop as a second fence after the SQL
predicate; ManageDevicesCard renders in Settings → Vault; all four CLI
session-creation fetches send `user-agent: muster-cli`. Cross-tenant pin:
real-server harness with two hosted signups (distinct browsers) — each
sees exactly own device, cookie-less → 401. Harness debug finding
(recorded in-file): an empty `instances: {}` boots config.ts's
DEFAULT_FLEET whose opencodeGo ACP child fetches its catalog at boot —
hence the house ghost-instance fixture; the owned preload now allows
loopback and refuses+logs non-loopback with stacks.

**Gates:** red 2 files (module absent) → unit **12/12**, harness **3/3
+ cleanup**; touched **15/15**; oxlint 7 files **0/0** (4 errors fixed
structurally: `unknown` param + 3× runtime-typeof moved into the zod
boundary, none suppressed); server tsc **exit 0**; app tsc **exit 0**
(parallel SocialView WIP errors resolved by their owner mid-loop — their
edits remain unstaged); `vite build` ✓ 16.89s; full suite **332 files /
4934 passed / 8 skipped / 0 failed** (468.12s; +2 files/+15 vs Loop177 =
exactly this slice, no decrease). **Not claimed:** revoke UI (S0 is
view-only; `muster sessions --revoke` stays the control surface),
hardware identity, key-envelope production, security attestation,
screenshot verification of the card. Next per §38: S1 the change journal
(DESIGN §10).

# Current Muster state — read before editing

**Full-tree re-verification (22 Sep 2026):** brought the existing `main`
checkout to `03da806` (autodeploy trigger ×2 over the stars-study commit —
nothing source). `git pull --rebase --autostash` was linear; inherited
parallel-agent WIP (Drives-loop test/spec edits, www edits) re-applied intact
and stayed uncommitted. Full gate held on tip + inherited WIP: types
(app + server tsconfigs) exit 0; oxlint exit 0 (silent); unit **325 files /
4856 passed / 8 skipped / 0 failed** (475.55s) — +1 file/+10 tests over the
Loop164 baseline, the Loop165 team-markdown tests; build exit 0; e2e
**42 passed (4.2m)** — +1 over the 41-baseline because the inherited
uncommitted backup spec adds a checked-retry acceptance, green. Native held:
swift test **399/0**; phone UI rig **5/5** (owned simulator created/deleted,
cleanup receipts clean); owned watch rig **passed** (pair/accept/enroll/
prepare/message/end settled, 34 requests, owned simulator deleted); electron
sweep + updater **14/14**. Production GET receipts: muster.today
`/`, `/api/health`, `/sign-in`, `/os`, `/marketplace` all **200**; health body
`{"app":"muster","pid":8,"static":true,...}`. Release channel GET: releases
latest **v1.14.1** (2026-09-21, 13 assets, matches package.json). No product
code edited, no release/deployment claim; releases remain the release agent's
surface.

**Latest verified slice: Loop144 Drive consent isolation.**
Separate verified Drive credentials preserve login/Calendar tokens, bind consent
to a one-use session request, and check identity/scope. Setup copy now explains
that connection is not automatic backup/sync; its mobile dialog is opaque.
Final unit321files/4804passed/8skipped/0failed, browser41/41, packaged-server14/14,
build/types/lint passed. No native source change or real Google/production claim.
[Complete handoff and next work](astra-handoff-2026-09-19.md).
Next reproduced defect: stale-device Drive uploads overwrite the only backup;
retain snapshots and make restore selection explicit. Releases belong to another agent.

**Merged-tree re-verification (20 Sep 2026):** brought the existing `main` checkout to `2937cc6` (3 release-agent dependabot merges on top of Loop144: `.deploy-trigger` ×3 — autodeploy, nothing source). `git pull --rebase --autostash` was linear with no conflicts; Loop144 working tree re-applied intact. Full gate re-run held: 321 files / 4804 passed / 8 skipped / 0 failed (550.50s); browser 41/41 (3.7m); packaged-server 14/14; build/types/lint pass; lint 0/0. The CI `test`-job failure observed on unmerged dependabot branch `2da05fa3` (run `35471546869`, `onboarding-draft` 4000-cap assertion) is **not** on `main` — release-agent domain. Local Node 22.22.3 is below engines>=23.4 (accepted per handoff).

**Latest owner direction (19 September, strategy interview):**
[Personal-assistant beta decisions](personal-assistant-beta-decisions-2026-09-19.md)
supersedes conflicting older strategy: everyone, all-platform small beta,
Watch calling and Plan my day, Drive-first recovery, capped included AI plus
BYOK, free beta. Public expansion requires passing core flows and five testers
completing daily planning on three separate days each. This is a decision record,
not a new implementation or verification claim.

Updated 19 September 2026 (Loop143).

**Loop143:** same-host signed-in Calendar approval now reaches the Watch through
single-delivery call-bound enrollment. The Watch reviews planning inputs and a
calendar-backed draft before explicit Send. Synthetic-provider native acceptance
passed1/1; unit317files/4734passed/8skipped, browser40/40, Swift390/390,
all three simulator builds and both typechecks/lint passed. No real Google,
physical-device, cross-host sync or production rollout claim. See the latest
handoff/audit for retained failures and next gates. The Loop136 hero gap below
is historical; Loops139–143 implement and test the foreground call journey.

Historical snapshot, 19 September 2026 (Loop136). This snapshot takes precedence over historical roadmap
status; the latest owner request takes precedence over this file.

**Loop136:** Automatic provider retry now requires persisted account opt-in, default off.
A retry requires a failed quota turn with no progress, current source-turn
identity, unchanged owner/task/message/provider and unchanged consent generation.
Stop, new work and revoke/re-enable invalidate pending retries. Only owned
providers participate. Missing explicit choices no longer silently select
another provider. A temporary alternate preserves the saved model and original
message identity; Stop and approvals target the active provider. Late predecessor
events cannot settle the active alternate. The existing Providers panel reports
unknown/loading/save failures honestly and explains possible paid-credit use.

Full unit **309 files / 4556 passed / 8 skipped / 0 failed** (483.77s),
+3 files/+51 passing tests over Loop135; fresh browser **39/39** (4.1m),
packaged-server **14/14**, final focused **6 files / 70 passed**. Build,
project/server/e2e typechecks and full lint passed. No native-device or
real-provider acceptance is claimed by these isolated fixtures.

Next owner hero: foreground Watch calling. Source audit confirms Watch currently
has dictation/TTS, no ring/accept/end call protocol or durable offline queue.
The acceptance matrix records the implementation boundary and hardware gates.
Included allowance reservations/accounting and numerical cost approval remain
open; no pool or spending was enabled. Production rollout still needs actual
served-artifact verification and authenticated Dokploy build/rollout evidence.

**Loop135:** selected-calendar planning now gathers one to three commitments
and durations, re-reads the complete day, computes deterministic available blocks
and appends a readable unsent proposal to the chosen bot. Mounted composers now
receive draft updates while preserving existing text and attachments. No task is
sent before explicit Send; no calendar events are written. Stale responses,
all-busy days, DST/work boundaries, exact time precision and 320px layout are
covered. Full unit **306 files / 4505 passed / 8 skipped / 0 failed** (435.55s),
+1 file/+35 passing tests over Loop134; full browser **36/36** (3.7m),
packaged-server **14/14**, focused recovery **52/52**. Project/server/e2e
typechecks, production build, native source import and lint passed.

A Node-only panel test needed its browser auth import mocked; the failed full run
and interrupted earlier run are preserved in ceo-log.md. Real provider, installed
device and production acceptance remain open. Next bounded correction: existing
automatic cross-provider fallback lacks the owner's explicit opt-in requirement;
see the acceptance matrix before implementing. No allowance spending enabled.

**Loop135 deployment audit:** GitHub CI run 35458357189 passed and automatic
deploy run 35459042896 succeeded (19 September, 17:45 UTC). Dokploy returned
“Application deployed successfully”; webhook 669688357 is active with last
HTTP 200. These supersede historical billing/404 explanations for the hosted
web rollout. GET at 17:52 UTC still returned backend 7632065f-88c9-4614-8faa-42adb590f61b
(started 18 September 14:08 UTC) and web 453b2f23-e6ce-4963-ad5b-c5d09ac598a6,
with null revisions and no attestation. The unresolved boundary is accepted
trigger → running service/artifact replacement. Inspect authenticated Dokploy
build/rollout logs and domain-to-application/build-context mapping next. This
CI receipt does not establish Windows/Linux release acceptance.

**Loop134:** connected users can explicitly choose a calendar/date/timezone
and read the complete agenda in the existing panel. Separate Calendar credentials
refresh with session/generation checks; old responses are discarded after
revocation or selection changes. Pagination/collection checks fail closed;
recurrence, all-day intervals and DST boundaries are handled without event writes.
Full **305 files / 4470 passed / 8 skipped / 0 failed**, browser **35/35**,
packaged-server **14/14**, focused **98/98**, build/types/lint pass. Gates caught
and fixed native Node strip-only syntax plus a browser fixture locator issue.
No real-provider or production acceptance claim. Next: explicit unsent planning
draft with user commitments and deterministic time blocks; verify current-bot
draft notifications/preservation first (source audit in acceptance matrix).

**Loop133:** account-owned Google Calendar consent now has separate token
storage, signed provider identity checks, PKCE, one-use session-bound state and
revocation-generation guards. The existing Connected apps panel offers explicit
read-only consent/local disconnect and reopens on callback, including at 320px.
Drive/login token rows are preserved; local disconnect does not revoke Google's
combined grant. Full **303 files / 4427 passed / 8 skipped / 0 failed**,
browser **34/34**, packaged-server **14/14**, focused backend **65/65**;
build/types/lint pass. Real Google consent and installed-device acceptance remain
open. Next: token refresh and complete selected-calendar day reads, then an
explicit planning draft; consent alone is not working daily planning.

**Loop132:** installation connections now require the hosted primary owner;
connector credentials are scoped to the active bot/thread/turn and revalidated
across async work. Opt-out and Stop revoke credentials and queued continuations.
Unavailable connections show their actual reason in the existing panel.
Full **300 files / 4371 passed / 8 skipped / 0 failed** (449.92s), browser
**31/31**, packaged-server **14/14**, focused **72/72**, build/types/lint pass.
Compared with Loop131: +2 unit files, +24 passing tests, +1 browser test.
The first browser gate exposed a backup fixture request-count race; corrected
fixture boundaries retain stale-result and zero-write assertions. No backup
product change. Real Calendar consent/day reading is next; provider, native,
production and whole-codebase security acceptance are not established here.

**Loop131:** added the Daylight personal-assistant template and an explicit
Plan my day first-task draft. Reproduced and fixed Agent Hub clipping off-screen
at 320px by portalling the dialog outside the translated sidebar. Owned browser
coverage verifies one hire, preserved unsent draft after reload, no auto-approval
grant, and one explicit send. Full **298 files / 4347 passed / 8 skipped**,
browser **30/30**, focused **61/61**, build/types/lint pass. Initial full run had
four process/startup failures under heavy host load; unchanged focused rerun
**49/49** and full rerun passed. See CEO log for all receipts. No real-calendar,
Watch calling, native release or production rollout claim. Next: reproduce and
close hosted connector ownership gaps before account-scoped Calendar reads;
[acceptance matrix](beta-acceptance-matrix-2026-09-19.md) records the source audit.

**Loop130:** fixed OpenConnector-only bot dispatch and connection cards that
incorrectly required Composio. Shared backend selection now mounts tools and
routes card creation, authorization and status to the configured runtime;
Composio fallback and bot opt-out remain. Reproduced before fix on an owned
server. Full **298 files / 4347 passed / 8 skipped**, browser **29/29**,
packaged-server smoke **14/14**, focused connector **20/20**, types/lint pass.
This verifies the connector prerequisite, not real Calendar consent or Plan my
day completion. No native release or production rollout claimed.

**Loop129:** beta decision record and [acceptance matrix](beta-acceptance-matrix-2026-09-19.md)
added. Owner-claim browser coverage verifies identity, fragment removal, single
submission/replay rejection, malformed input, and cloud-code namespace separation.
`/claim#CODE` already works; `/pair#CODE` must not be wired to its claim endpoint.
Full unit **296 files / 4341 passed / 8 skipped / 0 failed**; browser **29/29**;
focused unit **66/66**; all three typechecks, lint and fresh build pass. Native
and real-provider/device acceptance remain open. See the corrected
[handoff](handoff-next-agent.md); this is not a deployment receipt.

**Owner priority:** keep the existing web layout, Flower mascot, /app and /os
shells, choices and sessions stable. Read [the stability contract](../guides/web-app-stability.md).

**Loop126 (19 September 2026):** the parked verification finished; a real chat re-greet bug found behind a flaky-looking e2e. Resuming the interrupted run, workspace-backup e2e showed 2 failures in signIn's first-run dismissal; trace extraction proved no Escape ever ran — the helper sampled each first-run surface once and the async wizard mounted during the closing assertion (the late-decision delay is correct product behavior). The settle helper now waits up to 2.5s per round for a surface before acting. That exposed two real OnboardingChat defects: (1) it wrote `muster.onboarding-chat.done` but never read it, so any empty-roster account re-greeted on every load — now the persisted gate is read via `onboardingChatDone()`; (2) no connect guard, so the chat flashed during the pre-SSE boot window when every account reads as empty — now `shown` requires `state.connected` (same rule the classic wizard applies). Receipts: e2e **26/26**, onboarding-draft **7/7**, unit **294 files / 4327 passed / 0 failed**, both typechecks 0, oxlint **0/0** (827 files), fresh build ✓.

**Loop118 (18 September 2026):** speed + systematic docs. **Bundle split (measured):** the app shipped one eager 1,882KB main bundle — route/overlay code-splitting did not exist. The conditional surfaces (SettingsPanel, PluginsPanel, ComputerPanel, BrowserPanel, InspectorPanel, SettingsModal, RoutinesPage, SocialView, Onboarding) are now lazy chunks with per-overlay Suspense boundaries, plus route-level lazy for /sign-up, /pair, /claim, /forgot-password, /reset-password and /os; the boot surface (Sidebar, ChatView, GroupView, auth, /app shell) stays eager so /app paints identically. Result: **main 1,882KB → 1,509KB (−373KB, −20% raw; gzip ~0.50 → ~0.40MB)**, 9 new on-demand chunks; first-open of a panel costs one local fetch. **Bench on demand:** `pnpm bench:roles` runs the per-role benchmark capture + grade pipeline. **Agent orientation hub:** `docs/AGENT-ORIENTATION.md` — the 5-minute systematic map (read-order, ranked list + status vocabulary, plan-doc index, non-negotiable rules, verification gate with baselines, parallel-agent etiquette with file-ownership claiming, owner-gate table, one-command slices); AGENTS.md's read-first section now points there. Production note: HEAD still 404s on muster.today — the autodeploy trigger commit has not deployed the Loop116 server fix yet (owner action). Gate: unit **292 files / 4320 passed / 8 skipped / 0 failed**, e2e **26/26**, both typechecks exit 0, oxlint **0/0** (822 files), `pnpm bench:roles` green.

**Loop117 (18 September 2026):** two owner-reported field bugs fixed. **Podman setup failed while podman was healthy:** the runtime-start verifier probed `podman info` once (20s) immediately after machine start — a cold API forwarder loses that race — so a running podman read as "not answering yet"; the probe is now a bounded retry window (10×1.5s), and the setup card's copy-paste command is idempotent (`init 2>/dev/null; start; info`). **Desktop Google sign-in never landed:** the flow opened in the system browser, so `/oauth/finish` set the session cookie in Safari's jar while the app polled its own — now the cloud sign-in opens in a sandboxed in-app window sharing the app's session (`openAuthHandoff` IPC, cloud-host allowlist), the cookie lands where the existing get-session poll sees it, and the window self-closes; web builds unchanged. Acceptance-only: one real Google sign-in on an installed app.

**Loop116 (18 September 2026):** muster.today production checkout (GET-only, no credentials) + two fixes. **Production truth:** health `200 {app:muster, static:true, messageSendVersion:1, approvalActionVersion:1}`; all public pages 200 (`/`, `/sign-in`, `/app`, `/os`, `/docs`, `/marketplace`, `/sitemap.xml`, `/robots.txt`, `/privacy-policy`, `/terms-of-service`); TLS terminates on the VPS (Let's Encrypt CN=muster.today, valid to 2026-12-10); the served bundle contains the mascot character system (poke/annoyed/dizzy/calm code verified in the live JS) — Loop113–115 web work **is deployed**. **Defect found in production:** every HEAD request 404'd (curl -I /, /docs/install.html, /robots.txt → 404) because all static branches gate on `method === "GET"` — monitors/CDNs/updater probes broke. Fixed at the single derivation point (`server/index.ts:4049`): HEAD normalizes to GET; Node strips the body; no unsafe route widens (verified `req.method` referenced nowhere else outside tests). Regression test added to server/index.test.ts (HEAD 200 + body suppressed on /, /app, /assets; HEAD 404 preserved on missing assets). **Deployed desktop is 1.12.1** (Sep 14 mirror; `latest-mac.yml` + all three assets serve, GET-verified) while GitHub Releases v1.12.3 carries the full signed/notarized payload (14 assets, published Sep 16) — the mirror is stale because the Actions `deploy-downloads` leg never ran; promotion needs VPS SSH (owner-gated). Also verified on the mirror: stable aliases (`Muster.dmg`, `Muster-intel.dmg`, `Muster-setup.exe`, `Muster.deb`, `Muster.AppImage`, `latest.json`, `muster-cli.mjs`) all GET-200. **Ranked item #1 closed:** the per-role benchmark capture harness now exists — `server/role-eval-harness.test.ts` boots an owned server (two fake-ACP instances: `auto` fullAuto for working scenarios, `ask` manual so escalation exercises the real card → respond → audit path), runs all six required benchmarks as real settled turns, records captures in the role-eval schema and grades them with the shipped grader to a passing scorecard; deterministic across three consecutive runs (4.3–4.8s). "Router metrics error handling: NaN in 0/0 division" could not be reproduced — the only metrics code (server/computer-observation.ts) is pure counters with no division; recorded as unverifiable rather than invented. Full gate: unit **292 files / 4319 passed / 8 skipped / 0 failed**, e2e **26/26**, both typechecks exit 0, oxlint **0/0** (820 files).

**Loop115 (18 September 2026):** mascot character system completed across all four surfaces. **Slice D — desktop tray companion:** the mascot lives in Electron as a small always-on-top companion window (`tray.html` + `src/tray-main.ts`, a 3KB second Vite entry, not the app bundle), showing one bot in focus (the one that needs you, precedence in pure `src/lib/mascot/tray-state.ts` — tested in sync with the web reducer) and the rest as face+line, polled from the same local `/api/bots` feed while visible, paused when hidden; toggled from the View menu (⌘⇧M) or `window.ogb.trayToggle()`; verified live on the dev stack (tray.html 200 + real feed through the owned proxy). **Slice E — iOS widget:** `MusterFleetWidget` extension (small + medium) renders the fleet from `FleetSnapshot` (new CompanionCore module: app publishes to the `group.com.muster.companion` app group after each state change, content-throttled; widget renders the same vector flower from CompanionCore's artwork; stale >15min reads as offline, not a lying "Working"). **Slice F — Watch haptics:** fleet state transitions now fire haptics (`needsYou` → notification, `working` → start) on the mascot-first root that already shipped. **Slice G — share card:** `src/lib/mascot/share-card.ts` builds the LaoA-style 1080×1440 card data (name, real face, narrated line, resolved hexes) with a tested layout contract. Verified: iOS app + widget extension + Watch targets all **BUILD SUCCEEDED** on the generated project; core **352 tests / 0 failures** (incl. new snapshot tests); web full suite **291 files / 4317 passed / 0 failed**; e2e **26/26**; both typechecks exit 0; oxlint **0/0**. App Store/Live-Activity-on-lock-screen acceptance remains device-gated (physical device + Apple approval) per the release plan.

**Loop113 (18 September 2026):** owner-directed mascot character system planned from the Novra GrokBot case study and 18 supplied references (study with per-source adopt/leave calls: `docs/research/mascot-character-study-2026-09-18.md`). Owner decisions binding: upgrade the existing Flower (no ported/copied engine), four surfaces in v1 (web, desktop tray/notch, iOS Live Activity/widget, Watch), full playful interactions with a calm-mode off switch, two-layer state model (status × expression). Execution plan with slices A–G, a file-ownership map for parallel agents and per-slice acceptance gates: `docs/plans/mascot-character-system-plan-2026-09-18.md`; agent skill `skills/mascot/SKILL.md`; ranked-plan §7 notes the new owner-priority item. **Web slices A+B+C shipped same day (see Loop114).** Slices D (Electron tray), E (iOS Live Activity/widget), F (Watch), G (delight/docs) remain open for parallel agents.

**Loop112 (18 September 2026):** the iOS "build failed" report reproduced, root-caused and closed. The GitHub Actions red was the documented billing rejection (zero steps executed on every push — no code involved). Locally everything native passed: core **352 tests / 0 failures**, iOS app + embedded Watch target, Release archive, UI-test scheme. The real defect was the owned acceptance rig: (1) ad-hoc signing (`CODE_SIGNING_ALLOWED=NO`) leaves no application-identifier entitlement, so the simulator keychain refuses `SecItemAdd` (-34018) *after* the server redeemed the token — pairing appears to fail at the last step; fixed by building with default signing. (2) `server/config.ts` reads `config.json` only from `OMB_DATA_DIR`, so harness instances written to `$HOME/.muster` never loaded and every bot showed "Not logged in"; fixed in the rig. (3) Xcode 26.6 UI-test snapshot starvation (predicate/indexed queries hang while the app renders) — fixed with stable app-side identifiers (`chat-header-capsule`, `walkie-answer-quote`, `walkie-answer-headline` in ChatView/WalkieView) queried via `descendants(matching: .any)` with fresh-query retries, TTS off during the live turn, and pairing-window pre-install (pre-boot + pre-install before the invite is minted). New owned rig `scripts/owned-ios-acceptance.mjs` drives pair → identity tour → Walkie turn end to end: real harness + sidecar on probed free ports, throwaway `HOME`/`OMB_DATA_DIR`, fake ACP engine, disposable simulator etiquette, cleanup receipts. **Two consecutive all-green runs** (pair ✅ identity ✅ walkie ✅, exit 0). Desktop package verified locally: `Muster.app 1.12.3` → `release/Muster-1.12.3.dmg` + `-arm64.zip` (163M each, ad-hoc, publish never). Web gate holds at tip: both typechecks exit 0, oxlint **0/0** (808 files); unit/e2e baselines unchanged from Loop111 (no web code touched). Actions/Windows/Linux/TestFlight legs remain owner-gated (billing, APPLE_CERTIFICATE, VPS SSH).

**Loop111 (17 September 2026):** continuation audit — the inherited Drive-connect slice (GET-shaped connect in PortableBackupCard, consent-redirect e2e with an owned Google consent stub, plan §7, DESIGN §41) verified through the full gate and committed; e2e is now **23/23** (new consent-redirect acceptance). README rewritten around the real `docs/screenshots/` captures (was embedding zero images; `iphone-roster.png` added as a copy of the iOS App Store roster shot) and its backup-boundary row corrected to the shipped account-Drive truth. The drive-by priority list was corrected in remaining-work-plan §7: the per-role benchmark grader (`server/role-eval.ts`) and `muster bench` CLI ship today — the missing piece is the automated capture harness and product/CI wiring, not the whole benchmark.

Receipts: unit **287 files / 4287 passed / 8 skipped / 0 failed**; e2e **23/23**; both typechecks exit 0; oxlint **0/0** (806 files).

**Loop110 (17 September 2026):** brain-backed dispatch — the Jev-style recommend_team engine now uses the workspace brain's institutional memory to bias ranking. server/jev-dispatch.ts accepts owner-filtered brain facts and awards a capped +2 per fact (max +4) when a fact's source names a candidate and its text overlaps the task. server/index.ts queries brain facts in the same peer-lease scope as the roster. server/brain-dispatch-harness.test.ts proves the full chain over a real booted server: the same candidate is out-ranked by memory evidence, and the cap prevents a prolific bot from buying the top slot.

Receipts: unit **287 files / 4287 passed / 8 skipped / 0 failed**; focused brain slice 19/19; both typechecks exit 0; oxlint **0 warnings / 0 errors**.

**Loop109 (17 September 2026):** the Muster workspace brain shipped — gbrain's load-bearing ideas (explicit facts with provenance, withdrawal, zero-LLM entity edges, gap-aware retrieval), none of its operational weight. Harness routes /api/brain* owner-scoped; Fleet MCP gains brain_write + brain_query (8 to 10 tools). Live harness test caught cross-account fact leakage on local installs — fixed through the read-only session seam.

Receipts at merged tip (3a49b05): unit 287 files / 4282 passed / 8 skipped / 0 failed; e2e 22/22; both typechecks exit 0; oxlint 0/0. PR #13 merged with checks platform-refused per PR-#8 policy.

**Loop108 (17 September 2026):** Jev-style recommend_team — the Chief of Staff ranks the roster before delegating. Pure engine: weighted overlap (title x3, name x2, description x1), busy tie-break, complexity read, model-fit ADVISORY only. MCP tool recommend_team in agents-proxy under peer-lease auth. Fake-acp-cli recommend-peer mode proves the chain over real server.

Receipts at merged tip (903cfe8): unit 285 files / 4273 passed / 8 skipped / 0 failed; e2e 22/22; both typechecks exit 0; oxlint 0/0. PR #12 merged with checks platform-refused per policy.

**Loop107 (17 September 2026):** the Muster Connector — own-branded connected apps via OpenConnector (oomol-lab/open-connector). server/openconnector.ts implements the runtime contract (Bearer token, {success,data} envelope, /v1/providers, /v1/apps/authenticated, /v1/connections/{service}/connect, /v1/actions/{id}, /mcp with session forwarding). Wins backend priority when configured; Composio paths remain untouched fallbacks. Settings gains write-only runtime URL/token; PluginsPanel names backend honestly.

Receipts: live probe 5/5 (catalog mode, branded cards, batched status, authorize link, config no token echo). Full gates: unit 283 files / 4250 passed / 0 failed; e2e 22/22; both typechecks; oxlint 0/0. PR #11 merged per policy.

**Loop106 (17 September 2026):** blue selection fix — global ::selection replaced bright accent 45% with raised-hover surface tone (skin-correct), html declares color-scheme: dark, mobile tap-flash transparent. Verified in live preview: computed style rgb(61,61,61)/80%, zero blue, console clean. PR #9 merged (119001a) per policy.

**Loop105 (17 September 2026):** account-Drive happy path pinned — three real fixes: (1) session resolved on local installs (was only under SELF_HOSTED, where family is 403-walled); (2) refreshed tokens now persist (every operation was paying fresh grant); (3) fixture exchange check fixed from 4 to 5 params. Plus 15 anti-slop lint errors from PR #8 extraction healed. Suite: server/account-drive-roundtrip.test.ts 8/8 over real booted server.

Receipts: unit 283 files / 4250 passed / 0 failed; e2e 22/22; both typechecks; oxlint 0/0. PR #10 merged per policy.

**Loop104 (17 September 2026):** the e2e suite runs on this machine for the first time and is green (22/22). Playwright's Chromium had never been downloaded here. Fixed: PortableBackupCard hosted 403 + POST-shaped status read; FleetOrb idle pill deliberately unmounted 2026-09-15; pairing carried-code browser acceptance added (/pair#CODE survives bounce, displays, still redeemable). Bisected: all inherited red pre-dated recent commits.

Receipts: e2e 22/22; unit 281 files / 4235 passed / 0 failed; both typechecks; oxlint 0/0. Pushed to origin/main.

**Loop98 (16 September 2026):** remote-access client role for pairing links. src/lib/pairing-link.ts owns planWorkspaceConnect(): self-hosted #code=XXXX-XXXX-XXXX connects and carries code; bare /pair connects; 6-digit companion code produces status notice; query-string codes refused; bare-fragment /pair#CODE accepted. Settings → Connected workspaces only UI change.

Receipts: focused pairing-link + workspaces tests 28/28; full 281 files / 4218 passed / 8 skipped / 0 failed; both typechecks; oxlint 0/0; vite build ✓.

**Inherited, preserved and deliberately NOT committed** (hashes byte-identical to preservation receipts):
`docs/research/glm/{01..05,README}.md` and `www/templates.html` (`aa2ba679…2f09c60`), plus the uncommitted **M** `src/state/teach-replay.ts` + `.test.ts` from a later session (focused suite 20/20). Treat `docs/research/glm/` as a dated snapshot, not as status.

**Published source:** the Loop112 commit on main. Loop112 closes the iOS acceptance report (owned rig all-green ×2, desktop DMG verified locally); Loop111 adds the README screenshot gallery, the corrected continuation plan (§7) and the committed Drive-connect acceptance; Loop110 brain-backed dispatch; Loop109 the workspace brain; Loop108 Jev recommend_team; Loop107 Muster Connector; Loop106 selection fix; Loop105 account-Drive round trip; Loop104 e2e green; Loop98 client-role pairing.

**Deployment wiring:** registered push hook 669688357 returned 404; Actions billing-rejected. Another path delivered static fixes to production. Do not invent URLs or equate failed hook with no rollout. Authenticated Dokploy access remains owner-blocked. Keep existing automation paused.

**Next:** scheduled/CI wiring for the benchmark harness (the capture + grade pipeline now exists in `server/role-eval-harness.test.ts`), mirror promotion of desktop 1.12.3 (VPS SSH owner-blocked), redeploy the HEAD fix so monitors see 200s, memory history + rollback UI (prereq for any self-proposal touching memory), skills-creation API (largest server gap), browser-side pairing redeem on the existing `/api/pair/claim` route, voice W4 barge-in (needs real-device testing), OpenMausBot parity items (channels in /app, Engines Add-account, tour pacing), Windows/Linux legs (CI billing), TestFlight review, full Mimosa re-run before any security claim.

## Structure note — server route-table pattern

The workspace/v2 + account-Drive backup family no longer lives inline in server/index.ts. It is extracted to server/workspace-backup-routes.ts behind an ordered route table: each entry has a match(method, path, ctx) predicate and a handle(req, res, ctx) handler; handlers receive a BackupRequestContext (requestUserId, live config, appVersion, dataDir) and index.ts owns session resolution and per-request state. Shared HTTP plumbing (json, isText, readBody) moved to server/http-helpers.ts — route modules import the one definition.

The registration point is order-sensitive and documented in the module header: inside the session gate, above the multi-tenant guard, with capability advertisement ahead of the hosted installation wall inside the table. First match wins; the handler returns false when the family does not claim the request, and index.ts proceeds unchanged.

Extracting the next family is mechanical: write the module with its own ordered table, register it at its exact current position with the same one-call pattern, run the gate. Committed as b61c771 on refactor/server-route-table; merged via PR #8.
