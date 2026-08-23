# Android release appendix

Companion to [`mobile-release.md`](mobile-release.md) — the Android-specific
details: the broken EAS config and its replacement, signing, local Gradle
builds, and upload paths. Values audited from `android-companion/` on
2026-08-23: applicationId `com.muster.companion`, `versionCode 1`,
`versionName 1.0.0`, Expo SDK ~52 / RN 0.76.7, managed workflow (no native
project committed).

## 1. Fix `eas.json` first

The current file is a copy of an Expo app config, **not** an EAS config:

```json
{ "expo": { "name": "Muster Mobile", "slug": "muster-mobile", ... } }
```

EAS reads `build.profiles.<name>` — none exist, so every documented command
(`pnpm build:android:production` → `eas build --platform android --profile
production`) fails. Replace the file wholesale:

```json
{
  "cli": {
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "production": {
      "autoIncrement": true,
      "android": {
        "buildType": "app-bundle"
      }
    }
  },
  "submit": {
    "production": {
      "android": {
        "packageName": "com.muster.companion",
        "releaseStatus": "draft",
        "track": "internal"
      }
    }
  }
}
```

Notes on the choices:

- `appVersionSource: remote` lets EAS own `versionCode` increments once the
  first build registers; drop it and set `"versionCode"` manually in
  `app.json` if you prefer repo-owned versions.
- `preview` produces a side-loadable APK for quick device checks without Play.
- `production` produces the AAB Play requires, auto-incrementing the build.
- `submit.track: internal` drops each submission into the internal testing
  track as a draft release — flip to `"completed"` only when you intend to
  publish.

After replacing the file: `cd android-companion && pnpm install && npx eas-cli
--version` (or `npx expo install eas-cli`) and log in with the Expo account
that will own builds.

## 2. Signing

Two supported paths; pick one and stay with it.

### EAS-managed keystore (recommended)

```sh
eas credentials                       # inspect/create
eas build -p android --profile production   # offers to generate a keystore
```

EAS generates an upload keystore and holds it server-side. Back it up
immediately (`eas credentials` → export) into the team password manager:
losing it after the first production release means changing the app's
identity or doing a key-reset with Google.

### Local keystore (fully self-hosted)

```sh
keytool -genkeypair -v \
  -keystore muster-upload.keystore -alias muster-upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then either point EAS at it (`eas.json` build profile:
`"credentialsSource": "local"`) or do a pure-local build:

```sh
npx expo prebuild --platform android          # generates android/
cd android
./gradlew bundleRelease                        # android/app/build/outputs/bundle/release/
```

With `expo prebuild` you get the real Gradle project — that is where
`applicationId` (`com.muster.companion`) and signing configs materialize;
keep them in sync via `app.json`, not by editing generated files, since
prebuild regenerates them.

Never commit the keystore or its passwords. GitHub secrets for CI:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

## 3. Upload paths

- **EAS Submit** (needs a one-time Play service account):
  1. Play Console → Setup → API access → link a Google Cloud project →
     create a service account with the *Release to testers* role → download
     JSON.
  2. `eas submit -p android --latest --android-package com.muster.companion`
     (reads the JSON from `EXPO_ANDROID_SERVICE_ACCOUNT_KEY_FILE` or the
     interactive prompt).
- **Manual**: drag the `.aab` onto Play Console → Testing → Internal testing
  → New release. Fine until automation lands.

Either way, finish the release in the console: add release notes ("What's
new"), review the expanded-device list, roll out to the internal track.

## 4. Versioning rules

- Every uploaded AAB needs a strictly larger `versionCode`. With
  `autoIncrement` + remote version source, EAS handles it; otherwise bump
  `expo.android.versionCode` in `app.json` per upload.
- Bump `version` (versionName) only for user-visible releases, mirroring the
  desktop's scheme.
- The root `scripts/bump-version.mjs` does not touch mobile configs — update
  `android-companion/app.json` by hand until it does.

## 5. Pre-submission checklist (Android slice)

- [ ] `eas.json` replaced (above), committed
- [ ] Production AAB builds green from a clean checkout
- [ ] Keystore backed up outside the laptop
- [ ] Camera permission rationale string present in the built manifest
      (check `android/app/src/main/AndroidManifest.xml` after prebuild)
- [ ] Legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` permissions capped at SDK 30 in
      the prebuilt manifest if pairing never uses classic Bluetooth
- [ ] Internal-track release installed from the opt-in link on a real device:
      pair over LAN, answer one approval end-to-end
- [ ] Data safety form answers match `mobile-release.md` §7
