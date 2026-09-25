# Gates: desktop + web + onboarding bug sweep

- [x] G1: voice probe tears down a late-resolving microphone grant (the onboarding mic leak)
  CHECK: npx vitest run src/lib/voice-test.test.ts
  EXPECT: voice probe
  EVIDENCE: 2026-09-25 17:31Z — 5/5 passed, incl. grant resolving after stop/unmount → track.stop() called exactly once; denied-after-stop stays silent.

- [x] G2: onboarding window drag invariants survive stylesheet refactors (Windows overlay + macOS inset have no other drag surface during first-run)
  CHECK: npx vitest run src/styles.test.ts
  EXPECT: onboarding drag
  EVIDENCE: 2026-09-25 17:31Z — 4/4 passed (drag strip scoped to data-window-drag, title no-drag, opt-in platforms pinned).

- [x] G3: onboarding draft/finish behavior unchanged by the fixes
  CHECK: npx vitest run src/state/onboarding-draft.test.ts src/state/onboarding-finish.test.ts e2e/onboarding-draft.e2e.spec.ts
  EXPECT: onboarding regression
  EVIDENCE: 2026-09-25 17:24Z — unit 79/79 passed; playwright e2e 7/7 passed (first run hit ENOSPC — disk was 100% full from stale .omb-scratch/verification artifacts; cleared 15G of loop-33..49 scratch, rerun clean).

- [x] G4: typecheck and lint clean for every touched file
  CHECK: npx tsc -b && npx oxlint src/lib/voice-test.ts src/lib/voice-test.test.ts src/styles.test.ts src/components/Onboarding.tsx
  EXPECT: 0 warnings
  EVIDENCE: 2026-09-25 17:31Z — tsc -b zero errors across the tree; oxlint 0 warnings, 0 errors on all four files.

- [ ] G5: audited areas with no defect found are recorded with evidence, not asserted
  EVIDENCE: manual — Windows feed https://muster.orazen.online/downloads/latest.yml returned 200 serving 1.19.0 with sha512 (checked live 2026-09-25); electron-builder.yml carries the NSIS x64 target; GroupView/ChatView Windows drag styles verified applied (GroupView.tsx style={drag}, ConversationHeader windows flag); src/lib/auth.tsx reviewed end-to-end (sign-out-before-OAuth, relative callbackURL, capability coercion all correct); /api/config profile 403 for non-primary hosted users is deliberate server policy (server/index.ts:6660), surfaced here as a known product decision rather than a bug.

## Sweep 2 (2026-09-25, live-audit): three more real bugs, same discipline

- [x] G6: the sidebar renders exactly ONE default Teammates header; a stray pre-sections duplicate stacked two for every user with bots (reproduced live before the fix)
  CHECK: npx vitest run src/lib/roster-sections.test.ts src/lib/sidebar-preferences.test.ts
  EXPECT: sections
  EVIDENCE: live DOM count pre-fix = 2 headers, post-rebuild = 1; section/preference suites 112/112 across the five touched-area suites.

- [x] G7: a failed settings config save surfaces its error and never overwrites the app-wide config object (previously a 403/400 body was dispatched AS config, poisoning every other settings card until the next fetch)
  CHECK: npx oxlint src/components/SettingsModal.tsx && npx tsc -b
  EXPECT: 0 errors
  EVIDENCE: all three raw-fetch save sites (ProfileFields, ChannelTurnCapCard, VpsCard) now route through api() which throws with the server message; each card renders role=alert with that message; failure path proven against a SELF_HOSTED server: non-operator PUT /api/config -> 403 "only the deployment operator can change configuration"; happy path proven live: PUT -> 200, server profile updated, zero alerts, config intact.

- [x] G8: "Replay welcome tour" actually reopens the wizard on accounts with history (previously App hid the wizard, the wizard's returning-user guard auto-skipped, and the account was re-gated — replay silently did nothing)
  CHECK: npx vitest run src/lib/analytics.test.ts
  EXPECT: 14 passed
  EVIDENCE: repro'd live pre-fix (flag consumed, wizard never mounted, gate re-marked done:true, polls=11) then fixed (App.tsx honors tourReplayPending() without consuming the one-shot flag) and verified live post-fix (wizard mounts at Welcome, gate stays done:false through the walkthrough); new peek test 14/14.

- [x] G9: full regression net stays green after all three fixes
  CHECK: npx vitest run src/lib/analytics.test.ts src/lib/roster-sections.test.ts src/lib/sidebar-preferences.test.ts src/state/onboarding-draft.test.ts src/state/onboarding-finish.test.ts && npx playwright test e2e/onboarding-draft.e2e.spec.ts
  EXPECT: 7 passed
  EVIDENCE: units 112/112, onboarding e2e 7/7, tsc -b clean tree-wide, oxlint 0/0 on the five touched files. Full-suite context: 380 files / 5,728 unit tests passed at sweep start; all 15 e2e specs (40 tests) passed before these fixes were layered in.

## Sweep 3 (2026-09-25): OpenMausBot installed live and diffed feature-by-feature

OMB (milind-soni/OpenMausBot @ 0.1.87) cloned to /tmp/omb, pnpm install,
vite build, harness run on http://127.0.0.1:9412 with a throwaway data dir
(/tmp/omb-data) and walked in the browser: first-run tour (5 steps incl.
terminal + engine-detect scenes), 9-step guided product tour (coach marks
opening the Computer panel, plugins, automations, calendar), bot context
menu (New thread / New folder / Pin / Make Chief of Staff / Move to team /
Mark as Unread / Edit Profile / Duplicate / Copy conversation ID / Archive
/ Delete), model picker (provider rail CLOUD/LOCAL, "Only this thread"
vs "Thread + bot default" scope, effort levels Default..Max, suggested +
show-all models), Team map (teams canvas, shared instructions, per-bot
default model), Automations (scheduled task / scheduled call / webhook,
calendar drag), Plugins (marketplace + MCP servers), Templates (Explore /
Import .mausbackup.json + BotMRR .md + GitHub URL / From a folder /
Share), bot profile tabs (Overview, Identity w/ image-provider, Soul
standing instructions mirrored to SOUL.md on disk, Skills, Memory with
change history, Routines, Access, Model, Permissions w/ Chief-of-Staff +
approval level, Voice & alerts), App Settings (About me shared context,
language picker w/ partial i18n, effort default for new bots, parallel
threads per bot, event-log cleanup, preset sharing, BOTH tours replayable
separately, People/Activity/Backups sections).

- [x] G10: user shared context ("About me") — the one OMB feature Muster genuinely lacked — implemented and verified
  CHECK: npx vitest run server/config.test.ts server/index.test.ts
  EXPECT: 88 passed
  EVIDENCE: profile.about added to server schema (zod-validated, 2000-char cap in UI), echoed in configStatus for both operator and signed-in branches, injected into EVERY bot's system prompt via the persona seam (server/index.ts startTurn), and editable in Settings → Profile with the same failure-proof save path as sweep 2. Verified LIVE: PUT -> 200, ~/.muster/config.json holds the value, GET echoes it; UI textarea round-trips (typed via the real React events, focusout -> PUT -> 200). Parity items already present in Muster and NOT re-implemented: standing instructions (soul-md.ts), skills (workspace-skills.ts), memory w/ history, routines, channels, engine CLIs, approval levels, tour replay, context menus, model per thread+bot, local VM/cloud computers.

Note: concurrent agent shipped onboarding fixes (2e34471) mid-sweep; my diff stays out of their files.
