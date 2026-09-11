# Ecosystem references and release handoff — 2026-09-11

Implementation baseline: `fc13c71`. Loop 46 evidence records **236 root files / 3257 passed / 8 skipped; 222 Swift passed; 7/7 native scenarios; 42/42 HTTP checks; 67/67 final cleanup checks**. These are completed composer-slice gates, not fresh results from this research or a distribution claim. The iPhone tests used an owned simulator and offline fixture.

The [GLM handoff ledger](glm-handoff-2026-09-10.md) remains authoritative for retained failures, cleanup, deployment observations, and the full older backlog. Loop47 removed eight merged remote branches and two local audit branches: main is the only branch locally and remotely. A verified bundle preserves13 refs, including the patch-equivalent but topologically unique local commit and original stash. Deletion guards passed4/4 and postconditions9/9; consult the ledger for the archive and retained initial mismatch.

## Reference evidence and reuse limits

- [Orazen stars](https://github.com/Orazen?tab=stars) and [tharunramagiri stars](https://github.com/tharunramagiri?tab=stars) were accessible. Only their visible first pages were sampled; no private interests, quality endorsements, or integration readiness were inferred.
- [Gumloop](https://www.gumloop.com/home) presents connected apps, reusable skills, visible tool activity, and human controls. These are vendor-presented patterns, not tested Google backup or sync. No open-source reuse license was established.
- [Life Recorder](https://github.com/browser-use/life-recorder) describes local recording/transcription with pending chunks retained until receipt/transcription. Its queue and deletion conditions are useful references, not verified Muster behavior. [Root license: MIT](https://raw.githubusercontent.com/browser-use/life-recorder/main/LICENSE).
- [SwiftUI skills](https://github.com/FloWritesCode/fwc-swiftui-skills) supplies iOS 26 Liquid Glass guidance with availability fallbacks. [FrostFold](https://github.com/askmaddyy/FrostFold) supplies a SwiftUI/Metal visual effect with content limitations. Both have inspected MIT root licenses; neither was installed or run. Treat them as optional polish after correctness and accessibility.
- [iphone-duo](https://github.com/chuspeeism/iphone-duo) is a browser fold-animation demo. Its [notices](https://raw.githubusercontent.com/chuspeeism/iphone-duo/main/THIRD_PARTY_NOTICES.md) exclude Apple assets from its MIT code license. Preserve required notices; independently clear asset, dependency, model, and trademark rights.
- [Cadu's TestFlight invitation](https://testflight.apple.com/join/XfeprEPX) describes a Hermes iOS client and administration features. This is developer metadata; no beta was installed. [OpenMausBot's homepage](https://www.openmausbot.com/) and explicitly [scripted demo](https://www.openmausbot.com/demo) suggest contact/task navigation and approval surfaces. No signed-in competitor application or Watch behavior was exercised.

These references motivate engineering proposals. They establish neither AGI/ASI capability nor income outcomes, superiority, or release readiness.

## Ranked bounded slices

### 1. Guard iPhone Always allow as one operation

`ios/App/ChatView.swift` currently awaits grant saving and then answers unconditionally; `ios/App/Session.swift` catches the first error and reacquires the client for the second operation. `ios/Sources/CompanionCore/Client.swift` also needs explicit response-outcome handling. Capture one client/session, bot, thread, request, and grant key; lock synchronously; distinguish saved preference from accepted permission. Never approve after failed or unconfirmed grant saving, retarget after account changes, or automatically replay uncertain work.

**Acceptance:** real owned broker/HTTP and native tests for grant failure/lost response, success ordering, duplicate taps, unavailable outcomes, exact permission behavior, and account/task retirement. Require zero approval requests until the authorized continuation. No real tool permission is needed for this fixture.

**Loop 48 update:** the iPhone operation is now verified: root 3,352 passed / 8 skipped, Swift 267 passed, HTTP 32 checks, and six distinct iPhone scenarios across an initial 5 passes / 1 OS tutorial failure plus a targeted 1 pass rerun. See the latest CEO/handoff entries for scope and retained failures. Native Watch is still separate: `WatchViews.decideAlways` answers before saving, and both decision handlers play success after swallowed errors. Port the checked transport/coordinator semantics and prove Watch behavior in its own slice. The iPhone screenshots retain the old cursor avatar and truncated task title; those remain the next visual work. No new distributed native version is established.

### 2. Canonical native mascot and readable task identity

Reuse the authored flower from `src/components/MusterMascot.tsx` and teammate semantics in `src/components/Avatar.tsx`; retain bot colors and truthful status. `server/store.ts` assigns stable bot/thread IDs independently of names. Apply that identity to `ios/App/ChatView.swift` and native roster surfaces, with a readable task label/full-context reveal. Expressions must not substitute for approval, uncertainty, or completion text.

**Acceptance:** owned screenshots at small widths, keyboard open, task switch, Dynamic Type, VoiceOver, reduced motion, and older-iOS fallback. External gates are physical-device rendering and any separately licensed artwork. Keep glass/fold effects away from critical controls until independently demonstrated usable.

### 3. Expose existing Google identity and connector status

Extend the existing path: `server/auth.ts` already requests identity scopes plus `drive.appdata`; `server/desktop-auth.ts` bridges cloud sign-in to a local session. This does not establish Gmail/Calendar grants. `server/index.ts` exposes connector catalog/status/authorization and bot/thread/card-bound resume routes. Show the actual account, granted scope, connection state, and revocation/recovery; avoid a second parallel login system.

**Acceptance:** an authorized real test account, fresh consent, bounded read, cancellation, expiry, revocation, and wrong-account isolation. **External blockers:** configured OAuth clients/redirects, consent configuration, applicable verification, and explicit account authorization. Follow Google's [native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) and [scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth); mobile and desktop redirect arrangements differ.

### 4. Durable snapshot → Drive restore → separate sync contract

First address consistency and write-failure semantics in `server/store.ts` and `server/message-db.ts`: ordinary acceptance can survive a failed SQLite write in memory. Extend the existing `server/account-drive.ts` and `server/drive-sync.ts` paths instead of adding a parallel backup system. Ship storage consistency, versioned snapshots/upload, verified restore, and multi-writer sync as separate verified slices. Retain a known-good backup and restore explicitly into a new owned profile; exclude credentials and live approval authority. Preserve the ledger's deployment-secret-bound V1 portability gate until a migration is proved.

**Acceptance:** disk/transaction failure, interrupted upload, corruption, account mismatch, schema migration, and complete restore. Google's [appData storage](https://developers.google.com/workspace/drive/api/guides/appdata) is hidden and user-deletable, not permanent backup. Only afterward design multi-writer conflicts, tombstones, ownership, and recovery; [Drive changes](https://developers.google.com/workspace/drive/api/guides/about-changes) do not supply revision merging. Actual Drive authorization and portable restoration remain external acceptance gates.

### 5. Watch and platform acceptance

The next correctness slice is Watch approval handling. `ios/Watch/WatchViews.swift` currently answers before saving an Always allow preference; its decision handlers play a success haptic after methods that swallow failures. Reuse the checked `ApprovalTransport` and captured-operation semantics introduced on iPhone, bind them to `WatchSession` and the visible task, and emit success only after a matching outcome. A failed grant must send zero follow-up answers; an older server must show update guidance without sending the grant. Preserve exact permission choices, partial-save recovery, lifecycle retirement and physical duplicate protection. Keep a bounded bot/task/question surface with evidence handoff to iPhone.

**Acceptance:** actual owned Watch pairing, successful grant-then-answer ordering, grant failure, unavailable or lost answers, stale decisions, duplicate taps, reconnect, phone handoff and lifecycle retirement. Confirm both readable recovery and the absence of false success feedback. Portable Swift tests or a Watch compile alone cannot establish this runtime behavior. Minimum-iOS and physical-device checks remain distinct from simulator builds. Required hardware, signing/provisioning and distribution access are external prerequisites. Retain the ledger's separate Android release-policy gate.

### 6. Release one explicitly pinned current SHA

The GitHub audit observed billing/spending refusal before inspected CI/release job steps ran. Resolve that account condition before retrying. Its dated observations distinguish GitHub `v1.10.3`, public mirror `1.10.4`, and an older local `1.10.5` candidate; none attests current-source binaries.

Use `.github/workflows/release.yml`, `scripts/release-native-smoke.mjs`, `scripts/release-payload.mjs`, and `scripts/promote-release-mirror.py`. Require current-SHA platform/CLI artifacts, packaged-runtime and installer/update acceptance, and the intended signing/notarization evidence. `.github/workflows/package-win.yml` still checks a host-Node server and cannot replace packaged-runtime proof. Independently verify VPS host identity before writing; runtime `ssh-keyscan` alone is insufficient. Follow [mirror promotion](../release-mirror.md), preserve immutable old targets/Intel support, and reconcile publication provenance. Billing, signing credentials, runner/platform access, and production serving identity remain external gates.

Detailed research and dated GitHub observations are retained under `.omb-scratch/verification/loop46-ios-composer/`. Loop 48 implementation and verification receipts are under `.omb-scratch/verification/loop48-approval/`; its product commit is `bc69ca7`. This reference plan distinguishes those verified changes from the remaining proposals above.
