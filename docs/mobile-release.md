# Muster mobile distribution readiness runbook

Everything needed to take the two phone apps from "builds on a laptop" to
"installable by a tester through TestFlight and Google Play", in order. This
document is the master runbook; [`android-release.md`](android-release.md) is
the Android-specific appendix (EAS config, keystore, Gradle details).

Audited against the tree on 2026-08-23. If `ios/project.yml` or
`android-companion/app.json` change, re-check Section 1 before trusting the
rest.

---

## 1. Current state audit

There are **two separate mobile deliverables** in this repo:

| | iOS app | Android app |
|---|---|---|
| Source | `ios/` — native SwiftUI | `android-companion/` — Expo / React Native |
| Project shape | XcodeGen spec (`project.yml`); `.xcodeproj` is generated, never committed | Managed Expo workflow; **no native `android/` Gradle project exists yet** |
| Identity | bundle id `com.muster.companion` | applicationId `com.muster.companion` (from `app.json` → `expo.android.package`) |
| Version | `MARKETING_VERSION 1.0.0`, build `CURRENT_PROJECT_VERSION 1` | `version 1.0.0`, `versionCode 1` |
| Status | Feature-complete, device-tested, store drafts already written under `ios/AppStore/` | Core rewritten 2026-09-09 against the real wire protocol (the old core called endpoints that don't exist); signing still to configure |

Do not confuse them: the Expo app also carries an `ios` section in `app.json`,
but the shipping iOS app is the native SwiftUI one. The Expo `ios` config is
vestigial.

### 1a. iOS audit (`ios/`)

Read from `project.yml` and the sources it compiles:

| Item | Value | Notes |
|---|---|---|
| Product name | `MusterCompanion` | Display name under the icon is `MusterMobile` (`CFBundleDisplayName`) |
| Bundle ID | `com.muster.companion` | `PRODUCT_BUNDLE_IDENTIFIER`; prefix managed via `bundleIdPrefix: com.muster` |
| Version | marketing `1.0.0` / build `1` | Bump `CURRENT_PROJECT_VERSION` for every upload |
| Deployment target | iOS 17.0 | Swift 5.9 |
| Devices | iPhone + iPad (`TARGETED_DEVICE_FAMILY "1,2"`) | Universal ⇒ **iPad screenshots are required** at submission (see §5) |
| Signing | **None committed** — no `DEVELOPMENT_TEAM`, no profiles | Deliberate; set at archive time (§3 step 6). CI builds with `CODE_SIGNING_ALLOWED=NO` |
| Entitlements | `App/MusterCompanion.entitlements` (XcodeGen-generated) | Time Sensitive Notifications declared (`com.apple.developer.usernotifications.time-sensitive`) since 2026-09-09 — `interruptionLevel = .timeSensitive` now actually takes effect. No push, no iCloud, no app groups. Keychain uses the default access group with `ThisDeviceOnly` accessibility — fine without a capability |
| Capabilities used | Local network + Bonjour (`_muster._tcp`), camera (QR pairing), ATS local-networking + `ts.net` exception, URL scheme `muster`, notifications + time-sensitive entitlement | Info.plist-driven except the entitlement above |
| Export compliance | `ITSAppUsesNonExemptEncryption: false` | Standard crypto only ⇒ skips the yearly export-compliance prompt |
| App icon | `AppIcon` catalog present (1024px, generated from the mascot) | Regenerate with `node scripts/make-app-icon.mjs` if the mascot changes |
| Privacy manifest | `App/PrivacyInfo.xcprivacy` present | Keep in sync with the App Store privacy answers (§7) |

**Known gap (capability):** ✅ CLOSED 2026-09-09 — `project.yml` now declares
`com.apple.developer.usernotifications.time-sensitive` and XcodeGen generates
`App/MusterCompanion.entitlements` from it. The capability still has to be
enabled on the App ID in the Apple developer portal when provisioning is set
up (§3 step 6); automatic signing picks it up from the entitlements file.

### 1b. Android audit (`android-companion/`)

| Item | Value | Notes |
|---|---|---|
| Framework | Expo SDK ~52, React Native 0.76.7 | Managed workflow |
| Application ID | `com.muster.companion` | From `app.json`; there is no committed `build.gradle` to override it |
| versionCode / versionName | `1` / `1.0.0` | From `app.json` |
| Signing | **None configured** | No keystore anywhere in the repo. EAS can generate one, or bring your own (appendix) |
| Native project | Absent | Generated on demand by `expo prebuild` or by EAS Build; nothing to audit in Gradle today |
| Permissions | `CAMERA`, `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | Legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` removed entirely on 2026-09-09 — the rewritten app never touches Bluetooth, and uncapped legacy permissions trigger Play Console warnings. If Bluetooth discovery is ever wanted, re-add with `maxSdkVersion="30"` |
| Camera rationale | Set via `expo-camera` plugin config for iOS; **Android needs the same string** once prebuilt | Play rejects missing permission explanations less often than Apple, but the pairing flow still needs it visible |
| EAS config | ✅ FIXED 2026-09-09: real profiles — `development` (dev-client APK), `preview` (internal APK), `production` (AAB, autoIncrement) | `eas build --profile production -p android` now valid; keystore still to generate on first EAS build |
| Core | Rewritten 2026-09-09 against the real sidecar protocol (mirrors `ios/Sources/CompanionCore`): `/api/bots?messages=50`, `/api/threads/{id}/messages`, `/api/threads/{id}/respond`, `/api/pair`, SSE with `id: <streamId>:<seq>` cursors | The previous core called `/api/rooms`, `/api/approvals/*`, `/api/companion/pair`, `/api/events/stream` — none exist; the app could never have worked. Fold behavior (dedupe, leaf walk, streaming buffers, notify cap 100, hydrate-replace) is behavioral-tested |

### 1c. Existing GitHub workflows (`.github/workflows/`)

| Workflow | Mobile relevance |
|---|---|
| `ci.yml` → job `ios` | ✅ Exists: `swift test --package-path ios`, then `xcodegen generate` + an **unsigned simulator build**. Proves compilation only |
| `ci.yml` → other jobs | Desktop typecheck/lint/test/packaging. Nothing runs the Expo app's tsc/jest |
| `release.yml` | ❌ Desktop-only (mac/win/linux Electron). No TestFlight upload, no AAB |
| `package-win.yml`, `autodeploy.yml` | None |

So today: **no workflow produces a distributable mobile artifact.** What must
be added (and what secrets it needs) is in §8.

---

## 2. Developer accounts (one-time)

### 2a. Apple Developer Program — $99/year, renews annually

Enroll at <https://developer.apple.com/programs/enroll/> with the Apple ID
that will own the app (ideally a shared/team Apple ID, with 2FA enabled).

You will be asked for:

- Apple ID with two-factor authentication turned on (mandatory).
- Entity type:
  - **Individual**: legal name, address, phone. Fastest (often same-day).
  - **Organization**: legal entity name, D-U-N-S number (free, but can take
    days to obtain), authority to bind the company, website, work email.
    Muster ships under Orazen — if enrolling as an organization, start the
    D-U-N-S check first; everything else waits on it.
- Acceptance of the Developer Program License Agreement.
- Payment ($99) with a credit/debit card tied to the region of the account.

After enrollment (allow up to 48h for activation):

1. Sign in at <https://developer.apple.com/account> → note the **10-character
   Team ID** (needed in §3 and for CI secrets).
2. Certificates, Identifiers & Profiles → the bundle id
   `com.muster.companion` gets registered automatically on first upload, but
   registering it explicitly now avoids surprises (Capabilities tab: enable
   **Time Sensitive Notifications** per §1a).
3. Users and Access: invite teammates; generate an **App Store Connect API
   key** (Admin) later only if automating uploads (§8).

### 2b. Google Play developer account — $25 one-time

Sign up at <https://play.google.com/console/signup> with a Google account.

You will be asked for:

- Developer name (shown publicly — "Orazen"), contact email + phone
  (optionally website) shown on the store listing.
- **Identity verification**: government-issued photo ID; individuals must do
  address verification. Personal accounts created after Nov 13 2023 are
  subject to the **20-tester / 14-day closed-testing requirement** before
  production access (§4b). Organization accounts need D-U-N-S instead and
  skip that gate — same D-U-N-S as §2a if going org.
- Two-step verification on the Google account.
- $25 registration fee (one-time, card).
- US tax form (W-8BEN/W-8BEN-E for non-US persons) and banking details —
  only required to *charge* money; Muster is free, so these can be skipped,
  but the tax form prompts during setup anyway.

Activation can take 24–48h after payment and verification.

---

## 3. App Store Connect app record + TestFlight internal testing

For **this** repo's values: bundle id `com.muster.companion`, name
**Muster Mobile**, category Productivity. (`ios/AppStore/RELEASE.md` is the
shorter in-repo version of this section.)

1. <https://appstoreconnect.apple.com> → Apps → **+** → New App.
2. Platform iOS, Name `Muster Mobile` (13/30 chars), Primary language
   `en-US`, Bundle ID `com.muster.companion` (registered automatically since
   the team owns the `com.muster.*` prefix — pick it from the list),
   SKU `muster-mobile-companion` (internal only, any unique string).
   Full access vs limited access: default is fine.
3. Under Distribution → **TestFlight** a default **Internal Testing** group
   concept exists; create one named `Internal` and add up to 100 internal
   testers (anyone with a role on the team in App Store Connect or added by
   email — App Store Connect users only; external groups are the public lane).
4. On a Mac with Xcode (15+):
   ```sh
   brew install xcodegen            # once
   cd ios && xcodegen generate      # regenerate after pulling file changes
   open MusterCompanion.xcodeproj
   ```
5. In Xcode: target MusterCompanion → Signing & Capabilities → set **Team**
   (this writes `DEVELOPMENT_TEAM`; alternatively pass it on the command line
   below so the generated project stays unmodified). Ensure "Automatically
   manage signing" for TestFlight simplicity.
6. Bump versions: `CURRENT_PROJECT_VERSION` +1 for every upload;
   `MARKETING_VERSION` only for a new public release. Edit in `project.yml`
   (source of truth) or override at archive time:
   ```sh
   cd ios
   xcodegen generate
   xcodebuild archive \
     -project MusterCompanion.xcodeproj \
     -scheme MusterCompanion \
     -destination 'generic/platform=iOS' \
     -archivePath ../release/MusterCompanion.xcarchive \
     DEVELOPMENT_TEAM=<TEAM_ID> \
     CURRENT_PROJECT_VERSION=2 \
     MARKETING_VERSION=1.0.0
   ```
7. Validate + upload (Organizer → Distribute App → TestFlight & Internal
   Testing), or headless:
   ```sh
   xcodebuild -exportArchive \
     -archivePath ../release/MusterCompanion.xcarchive \
     -exportOptionsPlist <(printf '%s' '{
       "method":"app-store-connect",
       "destination":"export",
       "teamID":"<TEAM_ID>",
       "uploadSymbols":true }') \
     -exportPath ../release/export
   # then drag ../release/export/*.ipa into Transporter.app, or:
   xcrun altool --upload-app --type ios \
     -f ../release/export/MusterCompanion.ipa \
     --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>   # requires an ASC API key in ~/.private_keys
   ```
   First upload ever? Xcode Organizer is the least-moving-parts path. The
   CLI/API-key route matters only when CI does the uploading (§8).
8. Wait for "Processing" in TestFlight (~10–30 min), answer anything under
   **Export compliance** — already answered in the binary
   (`ITSAppUsesNonExemptEncryption=false`), so internal builds usually go live
   without waiting for a review.
9. Internal testers install via the TestFlight app on their iPhone. Run the
   real-device pass from `ios/AppStore/RELEASE.md`: QR pairing, Bonjour
   permission prompt, approval round-trip from Mac to phone, backgrounding/
   foreground reconciliation, Tailscale MagicDNS connect, transcript share.

Internal TestFlight builds expire after 90 days — bump the build number and
re-upload rather than letting testers' installs die quietly.

---

## 4. Google Play Console app record + internal testing

### 4a. Create the app

1. <https://play.google.com/console> → All apps → **Create app**.
2. Name `Muster Mobile` (same 30-char limit as iOS), default language
   `en-US`, **App** (not game), Free, then tick the declarations (developer
   program policies, US export laws — free app with standard crypto: declare
   and continue).
3. Complete **App content** (Policy → App content): privacy policy URL (§6),
   ads declaration (**No ads**), data safety form (§7), content rating
   questionnaire (IARC — expect Everyone/PEGI 3 for a productivity tool),
   target audience (18+; "not designed for children"), news app declaration
   (No), COVID app (No), government app (No).

### 4b. Internal testing track

1. Testing → Internal testing → create track `internal`.
2. Upload an AAB (from EAS or local Gradle, see appendix):
   ```sh
   cd android-companion
   eas build --platform android --profile production   # after fixing eas.json
   eas submit --platform android --latest \
     --android-package com.muster.companion            # service account JSON configured once
   ```
   or manually drag the `.aab` onto the Internal testing page.
3. Rollout to the track, add testers by email list (up to 100), share the
   opt-in link. Internal-track updates propagate within minutes-to-hours and
   do **not** require Play review.
4. Reminder: the internal track does **not** satisfy the personal-account
   **closed-testing requirement** (20 testers opted-in for 14 days before you
   can request production access). Schedule that closed test early if the
   account is individual — it gates the *first production release*, not
   internal testing.

Play requires the AAB to target a recent API level (within one year of the
latest Android release). Expo SDK 52 targets API 34/35 — verify at first
upload; if Play complains, bump `expo.android` SDK or use the current Expo
SDK before submitting.

---

## 5. Store listings — paste-ready metadata drafts

The canonical iOS copies already live in the repo and are within limits:

| Asset | File | Length | Limit |
|---|---|---|---|
| Name | *(entered in ASC)* `Muster Mobile` | 13 | 30 |
| Subtitle | `ios/AppStore/en-US/subtitle.txt` | 28 | 30 |
| Promo text | `ios/AppStore/en-US/promotional_text.txt` | 124 | 170 |
| Description | `ios/AppStore/en-US/description.txt` | 1176 | 4000 |
| Keywords | `ios/AppStore/en-US/keywords.txt` | 82 | 100 |
| Release notes | `ios/AppStore/en-US/release_notes.txt` | — | — |
| Review notes | `ios/AppStore/review-notes.md` | paste into ASC review info | — |

Copy them verbatim into App Store Connect. Do not edit lengths casually —
each was written against the actual feature set (approvals, streaming,
search/edit/share transcripts, computer view) and the no-cloud-copy story.

### Android listing drafts (Play Console → Main store listing)

Title (≤30):

```
Muster Mobile – AI Agents
```

Short description (≤80):

```
Answer bot approvals, follow replies, steer your AI team from anywhere.
```

Full description (≤4000) — adapted from the verified iOS copy:

```
Muster Mobile is the companion for Muster on your computer.

Keep your AI team moving when you step away from your desk:

• Answer approvals and questions
• Follow replies as they stream
• Send messages to bots and rooms
• See the roster with unread badges at a glance
• Watch a bot's computer when you need context

YOUR COMPUTER STAYS IN CHARGE

MusterMobile connects directly to the companion service on your own
computer. Your bot transcripts remain in Muster's local storage; this app
does not upload a cloud copy to the developer.

PAIR ONCE, REVOKE ANY TIME

Pair with a short-lived code or QR from Muster's Companion panel. The
computer stores only a hash of the phone credential and lets you revoke the
device at any time.

USE IT AT HOME OR AWAY

On a trusted local network the phone finds your computer directly. For
private remote access, put both devices on a Tailscale network and connect
by MagicDNS name.

Requires Muster running on a Mac, Windows, or Linux computer.
```

Graphic assets for Play:

- App icon: 512×512 PNG (32-bit, no alpha). Generate from the mascot like the
  iOS icon (`scripts/make-app-icon.mjs` pattern).
- **Feature graphic (required)**: 1024×500 JPG/PNG, no alpha. Dark background
  (`#0a0a0a` matches the app), mascot face left, tagline right.
- Phone screenshots: min 2, 16:9 or 9:16, 320–3840px each side, JPEG/PNG
  without alpha. Capture at 1080×2340 or 1080×2400.

### Screenshots shot-list (both platforms)

Capture from the **running app**, not mockups. iOS has a built-in fixture:
launch with `-store-preview` (`ios/App/Session.swift`) which loads
`StorePreview.json` — a deterministic roster/approval state, safe to show
publicly. `iPhone-6.9-roster.png` was captured that way; follow
`ios/AppStore/screenshots/README.md`.

Shot list, in order:

1. **Roster / ChatList** — bots with mascot faces, role chips, unread badge,
   a "waiting on you" item pulled to top. (Exists: `iPhone-6.9-roster.png`.)
2. **Approval card** — ChatView showing a blocking approval with
   Approve/Deny, mid-stream reply above it. This is the hero shot.
3. **Streaming chat** — transcript with typing delta and composer focused.
4. **Pairing** — PairingView with the QR scanner or discovered-computer list
   (shows the security model; reviewers look for this).
5. **Computer view** — ComputerView with a live screen frame.
6. **Settings** — connection status + unpair (trust story).
7. Optional: TaskManagerView / search / share sheet if space allows.

Required sizes:

| Platform | Size | Notes |
|---|---|---|
| iOS 6.9" (required set) | 1320×2868 portrait | iPhone 16 Pro Max simulator. 1290×2796 also accepted in this class |
| iPad 13" (required while universal) | 2064×2752 portrait | `TARGETED_DEVICE_FAMILY` includes iPad ⇒ mandatory. Alternative: switch the app to iPhone-only in `project.yml` and skip this set |
| Android phone | 1080×2400 (9:16) | ≥2 shots; reuse shots 1–5 |
| Android 7" / 10" tablets | optional | Skip while the Expo app is phone-only |

Simulator recipe (iOS): `xcrun simctl io booted screenshot shot.png` after
setting the simulator to 1320×2868 points-scale; crop status bars per Apple
guidance (status bar content may be cleaned, frame may not be faked into
looking like another device).

---

## 6. Privacy policy URL — what's needed

Current state:

- `https://muster.orazen.online` is the marketing site (`www/index.html`).
  It links to the **BSL 1.1 license** on GitHub. A license is not a privacy
  policy — both stores require a document describing data practices, and
  Play additionally surfaces it on the listing.
- The repo already contains a correct policy: `docs/ios-privacy.md`
  (data stays between the phone and the user's own computer; no analytics,
  no tracking, no sale). Its content is accurate to the codebase.

What to do (pick one, then keep it stable):

1. **Recommended:** publish `https://muster.orazen.online/privacy` serving
   the text of `docs/ios-privacy.md` (generalized to cover Android too —
   replace "iOS Keychain" with "the device keystore"). Add the link to
   `www/index.html` footer next to the license link.
2. Acceptable interim: use
   `https://github.com/Orazen/Muster/blob/main/docs/mobile-privacy.md`
   (create it as the combined doc) — stores accept GitHub URLs if publicly
   reachable, but a domain URL reads better in review.

Then set: ASC Privacy Policy URL field ← chosen URL; Play App content →
Privacy policy ← same URL. One policy covering both platforms avoids drift.

Trigger events that force a policy rewrite (already noted in
`docs/ios-privacy.md`): hosted push relay, analytics SDKs, accounts hosted by
Orazen, or the optional cloud-desktop viewer becoming developer-operated.

---

## 7. Data safety forms — draft answers

Ground truth from the codebase:

- The phone pairs to **the user's own computer** over LAN/Tailscale
  (companion sidecar, default-deny). Credentials: short-lived pairing
  exchange → device token stored in Keychain (`kSecAttrAccessible...ThisDeviceOnly`)
  / Expo SecureStore. The desktop stores only a hash.
- Message content lives on the user's computer; the developer operates no
  copy. There are **no analytics/ad SDKs** (iOS: zero third-party deps;
  Expo core libs only on Android).
- **better-auth Google sign-in is NOT part of the mobile apps.** It lives in
  `server/auth.ts` (desktop web UI / self-hosted cloud login, enabled only
  when `GOOGLE_CLIENT_ID/SECRET` are set). The mobile companions authenticate
  exclusively with device tokens. Do **not** declare OAuth identity in either
  store's form for the mobile apps; if a future mobile build adds Google
  sign-in against a Muster-hosted backend, revisit everything below.

### iOS App Privacy (ASC → App Privacy) — matches `ios/AppStore/privacy-answers.md`

- Data used to track you: **No**
- Data collected by the developer: **None** (nothing linked, nothing
  unlinked)
- Third-party SDKs collecting data: **None**

Justification on file: transmissions go device↔user's own computer; the
developer cannot read them. Keep `App/PrivacyInfo.xcprivacy` consistent.

### Google Play Data safety form

Recommended answers (self-hosted architecture, developer has no access):

| Question | Answer |
|---|---|
| Does your app collect or share user data? | **No** |
| Is all user data encrypted in transit? | n/a when answering No |
| Do you provide a way to request data deletion? | n/a when answering No |

If you prefer the maximally conservative reading (Play's definition of
"collection" is literally "transmission off device", and messages do leave
the phone toward the user's server), declare instead:

- Categories: **App activity** (in-app messages/actions) and **User content**
  (message text) — collected for **App functionality** only.
- Shared with third parties: **No** (the destination is the user's own
  server, not a third party).
- Linked to identity: **No** (tokens are random device credentials; no
  account identity is attached).
- Transient/on-device processing notes where applicable.
- Encryption in transit: answer honestly — LAN transport can be plain HTTP
  by design (Tailscale users get WireGuard). Declaring "encrypted" falsely is
  worse than the conservative path above.

Either answer is defensible; **do not mix them** across the form. Whichever
is chosen, record the decision next to `ios/AppStore/privacy-answers.md`
logic so future submissions stay consistent. Answer **No** aligns the two
stores and matches the published privacy policy — recommended.

Also in Play App content: **Data deletion** — point to the policy's
"Control and deletion" section (unpair deletes the token; revoking on the
computer kills the credential; transcripts are deleted by the user's own
Muster install).

---

## 8. Build + upload commands: exists today vs. must be added

### Exists today (verified in repo)

```sh
# iOS — tests + compile proof (mirrors ci.yml `ios` job)
cd ios && swift test
brew install xcodegen && cd ios && xcodegen generate
xcodebuild -project MusterCompanion.xcodeproj -scheme MusterCompanion \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build

# iOS — signed distribution (manual, Xcode GUI)
#   Xcode → Archive → Organizer → Distribute App → TestFlight

# Screenshot fixture state for captures
#   launch scheme with argument -store-preview  (loads ios/App/StorePreview.json)

# Android — dev loop
cd android-companion && pnpm install && npx expo start
npx expo run:android          # debug build, debug keystore, sideloads fine
```

### Must be added

| Gap | Where | What |
|---|---|---|
| Signed archive CLI | `ios/` docs or Make-style script | `xcodebuild archive` + `DEVELOPMENT_TEAM`, per §3 step 6 |
| Headless TestFlight upload | new script / fastlane | `fastlane pilot upload` or ASC API key + `xcrun altool --upload-app` (API key stored in `~/.private_keys`, never in repo) |
| Time Sensitive entitlement | `ios/project.yml` | capability/entitlements file (§1a gap) |
| **Fixed `eas.json`** | `android-companion/eas.json` | Replace bogus expo-blob with real build profiles — exact contents in [`android-release.md`](android-release.md) |
| Android signing | EAS credentials or local keystore | Appendix steps; keystore + passwords go in a password manager / EAS remote creds, never git |
| Play upload | script or CI | `eas submit -p android --latest` with a Play service-account JSON (repo secret) |
| CI: TestFlight job | `.github/workflows/` | macos runner, import p12 or ASC API key secret, archive+upload on tagged releases (pattern to copy: `release.yml` macos job) |
| CI: AAB build | `.github/workflows/` | ubuntu runner, `eas build` (EAS token secret) or self-hosted Gradle after `expo prebuild` |
| Expo app checks in CI | `ci.yml` | `tsc --noEmit` + `jest` inside `android-companion/` (currently untested in CI) |
| Version bumps | process note | `scripts/bump-version.mjs` covers desktop only — bump `MARKETING_VERSION/CURRENT_PROJECT_VERSION` in `project.yml` and `version/versionCode` in `android-companion/app.json` by hand until a mobile-aware bump script exists |

Secrets inventory for automation (all as GitHub Actions secrets, none
committed): `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_API_KEY_P8` (or the
p12 pair `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` already modeled in
`release.yml`), `EAS_TOKEN`, `PLAY_SERVICE_ACCOUNT_JSON`,
`ANDROID_KEYSTORE`(+password/alias secrets if self-managed).

---

## 9. Definition of done

Distribution readiness = every box ticked. Split by owner when delegating.

Accounts & records

- [ ] Apple Developer Program active (Team ID recorded)
- [ ] Google Play developer account active (identity verified)
- [ ] ASC app record exists: `com.muster.companion` / "Muster Mobile" / SKU
- [ ] Play app record exists with matching package `com.muster.companion`
- [ ] Privacy policy URL live and pasted into both consoles

iOS pipeline

- [ ] Time Sensitive entitlement added (approval alerts actually time-sensitive)
- [ ] `swift test` green; `xcodegen generate` clean
- [ ] Signed archive succeeds with real Team; export compliance auto-cleared
- [ ] Build visible in TestFlight → Internal group installs on a physical iPhone
- [ ] Real-device pass done (pairing, Bonjour prompt, approvals, background
      resume, Tailscale, sharing) per `ios/AppStore/RELEASE.md`
- [ ] Screenshots captured: full 6.9" set (+13" iPad set, or app switched to
      iPhone-only deliberately)
- [ ] Metadata pasted from `ios/AppStore/en-US/`; review notes filled incl.
      contact info entered in ASC (not committed)

Android pipeline

- [ ] `eas.json` replaced with working profiles (appendix)
- [ ] Keystore created/backed-up or EAS-managed credentials confirmed
- [ ] `eas build -p android --profile production` produces an AAB that
      installs via the internal testing link
- [ ] Listing complete: title/short/full description, icon, feature graphic,
      ≥2 phone screenshots
- [ ] Data safety form submitted (decision recorded per §7)
- [ ] Content rating, ads declaration, target audience completed
- [ ] If individual account: closed test scheduled (20 testers / 14 days)

Cross-cutting

- [ ] Versioning rule followed everywhere: build/versionCode increments per
      upload; marketing version only per release
- [ ] No secrets in git (grep for key/keystore/token before tagging)
- [ ] Both apps reviewed against final binary for privacy-answer accuracy
      (`PrivacyInfo.xcprivacy`, permission strings)
- [ ] Optional but recommended: CI jobs from §8 wired so the next release is
      one tag away

Ship order that minimizes risk: TestFlight internal → fix what the device
pass finds → Play internal track in parallel → external TestFlight +
Play closed test → production submissions.
