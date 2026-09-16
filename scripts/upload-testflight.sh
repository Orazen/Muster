#!/usr/bin/env bash
# Upload the built companion IPA to TestFlight.
#
#   scripts/upload-testflight.sh <KEY_ID> <ISSUER_ID> <PATH_TO_AuthKey.p8>
#
# App Store Connect only offers a team API key's .p8 file once, at creation.
# The key is scoped to a role; uploading a build needs App Manager or higher,
# and a Developer-role key authenticates fine and then fails the upload with
# a permissions error that reads like a network problem — so check the role
# before blaming the credentials.
#
# The IPA must already have been exported for App Store distribution, which
# re-signs the development-signed archive with an Apple Distribution
# certificate. An archive is not uploadable; only the exported IPA is.
set -euo pipefail

KEY_ID="${1:-}"
ISSUER_ID="${2:-}"
P8_PATH="${3:-}"
IPA="${4:-/tmp/muster-ipa2/MusterCompanion.ipa}"

if [ -z "$KEY_ID" ] || [ -z "$ISSUER_ID" ] || [ -z "$P8_PATH" ]; then
  echo "usage: $0 <KEY_ID> <ISSUER_ID> <PATH_TO_AuthKey.p8> [IPA_PATH]" >&2
  exit 2
fi

if [ ! -f "$P8_PATH" ]; then
  echo "error: no .p8 file at $P8_PATH" >&2
  exit 2
fi
if [ ! -f "$IPA" ]; then
  echo "error: no IPA at $IPA" >&2
  echo "hint: export the archive first —" >&2
  echo "  xcodebuild -exportArchive -archivePath /tmp/muster-walkie.xcarchive \\" >&2
  echo "    -exportOptionsPlist /tmp/muster-ipa/ExportOptions.plist -exportPath /tmp/muster-ipa2 \\" >&2
  echo "    -allowProvisioningUpdates" >&2
  exit 2
fi

# altool looks for keys in ~/.appstoreconnect/private_keys/AuthKey_<ID>.p8.
# Copying rather than symlinking: altool follows the name, not the file, and
# a symlink out of a synced folder has broken this in practice. 0600 because
# this is a credential that can publish to the App Store.
KEYDIR="$HOME/.appstoreconnect/private_keys"
mkdir -p "$KEYDIR"
chmod 700 "$HOME/.appstoreconnect" "$KEYDIR"
cp "$P8_PATH" "$KEYDIR/AuthKey_${KEY_ID}.p8"
chmod 600 "$KEYDIR/AuthKey_${KEY_ID}.p8"

echo "==> validating $IPA"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"

echo "==> uploading $IPA"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"

echo "==> done. Processing usually takes 5-15 minutes before the build"
echo "    appears in App Store Connect under TestFlight."