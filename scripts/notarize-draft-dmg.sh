#!/usr/bin/env bash
# Complete the draft release's macOS assets that CI cannot notarize.
#
# The arm64 leg notarizes its own dmg/zip when the ASC_* secrets are valid,
# but the Intel leg has no notarization step, and the publish job refuses to
# flip a draft public while any platform leg failed. The documented release
# path (docs/plans/ceo-log.md, Loop102/Loop151) closes both from this Mac,
# which holds a working notarytool profile:
#
#   1. download the named macOS assets from the draft release
#   2. codesign-verify each app-side artifact BEFORE submitting (notarytool
#      accepts binaries codesign rejects — see the workflow's pre-notarize gate)
#   3. notarytool submit --wait, then stapler staple + validate
#   4. re-upload the stapled artifacts with --clobber
#
# After this script exits 0, the draft carries notarized dmg/zip for both Mac
# architectures and the next release run's publish job can verify and publish.
#
# Usage: scripts/notarize-draft-dmg.sh v1.15.0 [assets-dir]
# Requires: gh (authenticated), xcrun notarytool profile "muster-notary".
set -euo pipefail

TAG="${1:?usage: notarize-draft-dmg.sh <tag> [assets-dir]}"
DIR="${2:-${TMPDIR:-/tmp}/muster-notarize-${TAG}}"
PROFILE="${MUSTER_NOTARY_PROFILE:-muster-notary}"
REPO="${GITHUB_REPOSITORY:-Orazen/Muster}"

command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || {
  echo "notarytool profile '$PROFILE' is not usable — run:" >&2
  echo "  xcrun notarytool store-credentials $PROFILE --key-id <id> --issuer <id> --key <p8>" >&2
  exit 1
}

mkdir -p "$DIR"
echo "== downloading $TAG macOS assets into $DIR"
for name in "Muster-${TAG#v}-intel.dmg" "Muster-${TAG#v}-x64.zip"; do
  gh release download "$TAG" --dir "$DIR" --clobber --repo "$REPO" --pattern "$name"
done
ls -la "$DIR"

# A dev-signed or partial signature fails here, before Apple sees it.
echo "== preflight: seals must verify and carry Developer ID + hardened runtime"
for f in "$DIR"/*.zip; do
  [ -e "$f" ] || continue
  APP="Muster.app"
  rm -rf "$DIR/app-probe"; mkdir -p "$DIR/app-probe"
  ditto -x -q "$f" "$DIR/app-probe"
  APP_PATH="$DIR/app-probe/$APP"
  codesign --verify --deep --strict "$APP_PATH"
  AUTHORITY=$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 | awk -F= '/^Authority=Developer ID Application/ {print $2; exit}')
  [ -n "$AUTHORITY" ] || { echo "::error::$f is not Developer ID signed (authority: ${AUTHORITY:-none})"; exit 1; }
  codesign -dv --verbose=4 "$APP_PATH" 2>&1 | grep -q "flags=0x[0-9a-f]*.*runtime" || {
    echo "::error::$f lacks hardened runtime"; exit 1; }
  echo "   $f: Developer ID ($AUTHORITY), hardened runtime OK"
done

echo "== notarize and staple"
for f in "$DIR"/*.dmg "$DIR"/*.zip; do
  [ -e "$f" ] || continue
  echo "-- submitting $(basename "$f")"
  xcrun notarytool submit "$f" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$f"
  xcrun stapler validate "$f"
  echo "-- $(basename "$f") stapled and validated"
done

echo "== re-uploading stapled artifacts to the draft"
for f in "$DIR"/*.dmg "$DIR"/*.zip; do
  [ -e "$f" ] || continue
  gh release upload "$TAG" "$f" --clobber --repo "$REPO"
done

echo "Done. $TAG now carries notarized macOS assets; re-run the Release workflow's publish job (or publish the draft) to make it public."
