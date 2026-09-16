#!/usr/bin/env bash
# Notarize and staple a macOS DMG so a downloaded copy passes Gatekeeper.
#
# This is the manual post-build step electron-builder.yml refers to
# ("Notarization runs manually after the build").
#
# IMPORTANT — what this script does and does not do:
#
#   Notarization does NOT make an unsigned build trusted. Apple only accepts
#   a submission whose payload is already signed with a *Developer ID
#   Application* certificate and built with the hardened runtime. Signing the
#   DMG itself afterwards is pointless: Gatekeeper evaluates the .app inside.
#
#   So the build has to be signed correctly in the first place, by
#   electron-builder, before this script runs:
#
#     CSC_IDENTITY_AUTO_DISCOVERY=true \
#     MAC_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" \
#     pnpm package:mac:arm64
#
#   (build/after-pack-mac.mjs looks for exactly those two variables; when both
#   are set it skips its ad-hoc reseal and writes the `trusted-mac-updates`
#   marker that unlocks in-place updates.)
#
#   This script therefore VERIFIES the payload before submitting, and refuses
#   with a specific message when the app is not Developer ID signed — rather
#   than letting notarytool reject it with an opaque error minutes later.
#
# Prerequisites that cannot be committed:
#   1. a "Developer ID Application" certificate in the login keychain
#      (create it in the Apple Developer portal as the Account Holder —
#      the App Store Connect API refuses to mint Developer ID certs), and
#   2. a notarytool credential profile (run once):
#        xcrun notarytool store-credentials muster-notary \
#          --key ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 \
#          --key-id <KEY_ID> --issuer <ISSUER_ID>
#
# Usage:
#   scripts/notarize-mac.sh release/Muster-1.12.1.dmg
#   NOTARY_PROFILE=other scripts/notarize-mac.sh path/to.dmg
#
# Set SKIP_PAYLOAD_CHECK=1 only if you know the app inside is already signed.
set -euo pipefail

DMG="${1:?usage: notarize-mac.sh <path-to.dmg>}"
PROFILE="${NOTARY_PROFILE:-muster-notary}"

[ -f "$DMG" ] || { echo "no such file: $DMG" >&2; exit 1; }
command -v xcrun >/dev/null || { echo "xcrun not found; install Xcode command line tools" >&2; exit 1; }

# --- 1. a Developer ID identity must exist ---------------------------------
if [ -z "$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ {print $2; exit}')" ]; then
  cat >&2 <<'MSG'
No 'Developer ID Application' signing identity in the keychain.

Create one in the Apple Developer portal as the Account Holder:
  Certificates, Identifiers & Profiles -> Certificates -> + -> Developer ID Application
Then import the downloaded .cer together with its private key into the login keychain.

Note: this cannot be automated. The App Store Connect API returns
403 "This operation can only be performed by the Account Holder" for
DEVELOPER_ID_APPLICATION, regardless of the API key's role.
MSG
  exit 1
fi

# --- 2. the app inside must already be Developer ID signed ------------------
MOUNT_DIR=""
cleanup() { [ -n "$MOUNT_DIR" ] && hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ "${SKIP_PAYLOAD_CHECK:-0}" != "1" ]; then
  echo "Verifying the app inside $DMG is Developer ID signed..."
  MOUNT_DIR="$(mktemp -d /tmp/muster-notarize.XXXXXX)"
  hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_DIR" -quiet

  APP="$(find "$MOUNT_DIR" -maxdepth 1 -name '*.app' -print -quit)"
  [ -n "$APP" ] || { echo "No .app found at the root of $DMG" >&2; exit 1; }

  # Read codesign's output in full before parsing it. An awk that exits on its
  # first match closes the pipe while codesign is still writing; under
  # `set -o pipefail` that SIGPIPE (141) becomes the pipeline's status and
  # `set -e` aborts the script here, before it ever submits anything.
  SIGNATURE="$(codesign -dv --verbose=4 "$APP" 2>&1 || true)"
  AUTHORITY="$(printf '%s\n' "$SIGNATURE" | awk -F= '/^Authority=Developer ID Application/ && !found {print $2; found=1}')"
  if [ -z "$AUTHORITY" ]; then
    echo >&2
    echo "REFUSING TO SUBMIT: $(basename "$APP") is not Developer ID signed." >&2
    echo "  currently signed by: $(printf '%s\n' "$SIGNATURE" | awk -F= '/^Authority=/ && !found {print $2; found=1}')" >&2
    echo >&2
    echo "Apple will reject a notarization request for this payload. Rebuild it with" >&2
    echo "CSC_IDENTITY_AUTO_DISCOVERY=true and MAC_SIGNING_IDENTITY set to your" >&2
    echo "Developer ID Application identity, then run this script again." >&2
    exit 1
  fi

  if ! printf '%s\n' "$SIGNATURE" | grep 'flags=0x10000(runtime)' >/dev/null; then
    echo >&2
    echo "REFUSING TO SUBMIT: $(basename "$APP") was not built with the hardened runtime." >&2
    echo "electron-builder.yml sets mac.hardenedRuntime: true — check the signing step ran." >&2
    exit 1
  fi

  echo "  signed by: $AUTHORITY"
  echo "  hardened runtime: yes"
  hdiutil detach "$MOUNT_DIR" -quiet
  MOUNT_DIR=""
fi

# --- 3. submit, staple, verify ---------------------------------------------
echo
echo "Submitting $DMG to Apple (this can take several minutes)..."
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

echo "Stapling the notarization ticket..."
xcrun stapler staple "$DMG"

echo "Verifying..."
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG" || true

# Stapling rewrites the DMG, so a manifest written at build time now carries a
# hash and size for bytes that no longer exist. electron-updater compares
# those against the download and refuses a mismatch, so refresh the entry.
MANIFEST="$(dirname "$DMG")/latest-mac.yml"
if [ -f "$MANIFEST" ] && command -v python3 >/dev/null; then
  echo "Updating $(basename "$MANIFEST") with the stapled size and hash..."
  python3 - "$MANIFEST" "$DMG" <<'PY'
import base64, hashlib, os, re, sys

manifest, dmg = sys.argv[1], sys.argv[2]
with open(dmg, "rb") as handle:
    digest = base64.b64encode(hashlib.sha512(handle.read()).digest()).decode()
size = os.path.getsize(dmg)
name = os.path.basename(dmg)

with open(manifest) as handle:
    text = handle.read()

pattern = re.compile(r"(- url: " + re.escape(name) + r"\n    sha512: )[^\n]+(\n    size: )\d+")
updated, count = pattern.subn(lambda m: f"{m.group(1)}{digest}{m.group(2)}{size}", text)
if count:
    with open(manifest, "w") as handle:
        handle.write(updated)
    print(f"  {name}: {size} bytes")
else:
    print(f"  no {name} entry in {os.path.basename(manifest)}; left unchanged")
PY
fi

echo
echo "Done. $DMG carries a stapled ticket and will open without a Gatekeeper prompt."
echo "Publish it with the matching stable alias, e.g.:  cp '$DMG' release/Muster.dmg"