# Muster onboarding and recovery: decisions after the design study

12 September 2026. Reviewed decisions after Loop72, pushed as `e6bbf16`. This study does not establish a native release or competitive performance.

## What was actually studied

Keep the versions separate. Root inspected installed **OpenMausBot 0.1.74** and its six-step replay: welcome/contact, feature reel, engines, optional microphone/speech, optional phone and first bot. Contact/permissions/phone were skipped; no bot was created, and the original conversation was restored. Its updater downloaded **0.1.75** during the session; Later was selected, without restarting or applying it. This was not a zero-write session. The installed Muster Info.plist separately reported **1.12.0**.

The public source study pinned **0.1.75**, commit [`628cd93b4fdd2fa20f0c4b19e3ce7feebfa8ed19`](https://github.com/milind-soni/OpenMausBot/tree/628cd93b4fdd2fa20f0c4b19e3ce7feebfa8ed19). **259 documentation-area files were inventoried; 30 selected files were inspected fully or in recorded excerpts.** This was not a full repository review. The inspection inventory (local-only evidence: `research/docs-inventory.json`) and source receipts (local-only evidence: `research/selected-source-receipts.json`) distinguish reading from inventory and downloaded-but-partially-read material. No competitor code or tests were executed in that source study.

Root separately viewed the [public landing page](https://www.openmausbot.com/): a mascot-led introduction, clear platform download action and explicitly labelled scripted demo. Changing the Release example changed the displayed agent/transcript; no approval was clicked. The 390px view used horizontal bot tabs and had no document-width overflow. These observations support presentation decisions, not claims about provider execution, permissions or capability superiority. Details: source study (local-only evidence: `research/research.md`), root observations (local-only evidence: `research/root-observations.md`).

The [versioned audit summary](astra-glm-audit-2026-09-12.md) records the verified findings. Raw inventories/screenshots named above remain local evidence under `.omb-scratch/verification/astra-onboarding-refresh-2026-09-12/`; they are not distributed with a fresh clone.

## What Loop72 adopts

The useful pattern is a consistent guide and navigation frame, seen in the pinned [welcome shell](https://github.com/milind-soni/OpenMausBot/blob/628cd93b4fdd2fa20f0c4b19e3ce7feebfa8ed19/src/components/onboarding/WelcomeFlow.tsx). Muster implements its own 900px desktop frame, compact mobile header, canonical orange Flower, named seven-step progress and visible current-step heading. Flower reflects existing attention/pending/final-step state. New errors are revealed and focused above the form; long content and recovery remain scrollable. Provider Settings retain their separate dialog and focus return.

The wrapper is a named region, not a claimed global modal boundary. The seven semantic steps, account-scoped v2 drafts, ambiguous-v1 migration, default Flower, character choices and explicit first-task/finish receipt behavior remain authoritative. No exit-animation handshake, tour-timer change, provider setup or automatic task action is introduced. Do not adopt the competitor's early local-completion/finish-anyway behavior.

The design author inspected 17 final layout/recovery images covering all seven steps at 320px and 1440px, reload and 503 recovery; no shell-blocking visual finding. A clipped left edge on the selected teal teammate preview is a separate queued observation, not a diagnosed shell regression. Visual receipt (local-only evidence: `shell/visual-review.json`). Loop72 passed **244 Vitest files / 3520 tests / 8 skipped / 0 failed**, plus **15/15 browser tests**, production build/types and lint. All932 observed inputs stayed frozen. Screenshots supplement those checks; authenticated production flow and native execution remain unverified.

## Ranked next slices

1. **Contain unchecked account-linked Drive before promoting account backup.** Keep deliberate installation Drive/file backup working. Expose truthful availability and disable only account-linked connect/write paths until Google subject, granted scope, token continuity and single-use callback state are established. Preserve hosted workspace/Vault denial. Gate with two synthetic accounts, differing login/installation identities, real routes, no mutation/provider calls on denial, and failure paths that never stamp restore success. This is containment of known contract gaps, not a general assurance about the system.
2. **Make Tour user-paced.** Preserve its semantic step, examples and optional skip; use explicit navigation and hold the final panel instead of endlessly wrapping every 3.6 seconds. Clearly identify examples as simulations. The [competitor feature reel](https://github.com/milind-soni/OpenMausBot/blob/628cd93b4fdd2fa20f0c4b19e3ce7feebfa8ed19/src/components/onboarding/reel/FeatureReel.tsx) provides a useful last-panel/replay pattern. Verify keyboard navigation, reduced motion, reload/draft retention and zero task writes from navigation.
3. **Improve engine readiness and recovery.** Keep the last known inventory on refresh failure, show the error separately, and offer Check again. Distinguish Muster sign-in, provider access and device pairing; a phone-link click is not confirmed pairing. Test deferred/out-of-order refreshes, failed refresh with retained choices, explicit retry and both local/web states. The [engine beat](https://github.com/milind-soni/OpenMausBot/blob/628cd93b4fdd2fa20f0c4b19e3ce7feebfa8ed19/src/components/onboarding/beats/EnginesBeat.tsx) is inspiration, not code to transplant.
4. **Build portable file restore before automatic transport sync.** Define a v2 recovery kit independent of login-signing secrets, with a consistent messages/branches snapshot, explicit file manifest, owner filtering, bounded paths/sizes and staged failure rollback. Only then add Drive/Telegram transport and scheduling. Prove installation A can be destroyed and restored into B under an unrelated auth secret using only the recovery kit; compare exact rows, branches and file hashes. Wrong keys, tampering, truncation, unsupported versions, path escapes, interrupted imports and other-account data must leave live state unchanged.

## Backup truth that UI must preserve

Current v1 is **manual, installation-wide, partial and tied to the original installation secret**. It contains visible bot/group records and selected top-level memory, not message rows, attachments, branch heads, arbitrary workspace files, nested history, browser/CLI sessions, account databases or provider connections. IDs/resume strings are metadata, not a recoverable conversation. Restore incrementally merges missing records/memory; it is not an atomic full-machine recovery. A correct passphrase alone cannot decrypt v1 after losing the original auth secret. Do not distribute that signing secret as a portability workaround. [Detailed contract and source pointers](portable-backup-contract-2026-09-12.md).

Hosted `/api/workspace` denial predated this work. Loop71 additionally closes hosted `/api/vault` access and omits installation Vault data from hosted briefing while filtering its roster. That supersedes the older containment TODO in the backup audit, but does not complete account-linked Drive or portable restore. Google appData remains user-deletable storage ([Google documentation](https://developers.google.com/workspace/drive/api/guides/appdata)); Telegram transport limitations remain separate from file encryption ([Bot API](https://core.telegram.org/bots/api)). Successful upload is not proof of recoverability.

Use original Muster copy, Flower and implementation. The [licensing map](https://github.com/milind-soni/OpenMausBot/blob/628cd93b4fdd2fa20f0c4b19e3ce7feebfa8ed19/LICENSING.md) distinguishes Apache-licensed code, separate enterprise terms and reserved branding. No security, loss-proof backup or unmeasured AGI/competitive-performance claims follow from this study.


## Adoption experiment after reliability gates

Measure an explicit first task accepted by the server, the time from setup start to
that receipt, recovery after failure, and seven-day return use. Keep setup completion
separate from actual task acceptance. No conversion baseline or uplift was established
by this audit. After ownership/restore and distribution gates pass, test one guided
starter task with a small invited cohort and record observed failures before expanding
traffic. Pricing, paid acquisition and public launch remain board decisions; the
onboarding redesign alone does not establish product-market fit or revenue.
