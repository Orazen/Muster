#!/bin/sh
# Xcode Cloud discovers this directory beside ios/MusterCompanion.xcodeproj.
# The project is generated from the checked-in spec before the archive action.
set -eu

fail() { printf '%s\n' "Muster post-clone: $*" >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${CI_PRIMARY_REPOSITORY_PATH:-}" ]; then
  ios_dir="$CI_PRIMARY_REPOSITORY_PATH/ios"
else
  ios_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
fi
[ -f "$ios_dir/project.yml" ] || fail "Missing ios/project.yml in the checked-out repository."

# The App Store Connect workflow passes its three export options plists by
# path (`ci/<name>-exportoptions.plist`, resolved against the repository root).
# They were never committed, so every export step died with xcodebuild's
# opaque exit 70 and not one line of the build log named a missing file — the
# archive step had already passed, so the log read as a signing problem.
# Check them here, where the failure can say what is wrong, and before the
# slow xcodegen download rather than twenty minutes after it.
if [ -n "${CI_PRIMARY_REPOSITORY_PATH:-}" ]; then
  repo_dir="$CI_PRIMARY_REPOSITORY_PATH"
else
  repo_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
fi
spec_team=$(sed -n 's/.*DEVELOPMENT_TEAM: *\([A-Z0-9]*\).*/\1/p' "$ios_dir/project.yml" | head -1)
[ -n "$spec_team" ] || fail "Could not read DEVELOPMENT_TEAM from ios/project.yml."
for export_plist in ad-hoc app-store development; do
  path="$repo_dir/ci/$export_plist-exportoptions.plist"
  [ -f "$path" ] || fail "Missing $path. The export action passes this file by path; without it xcodebuild exits 70 without saying the file is absent."
  plutil -lint "$path" >/dev/null 2>&1 || fail "$path is not a readable plist."
  export_team=$(plutil -extract teamID raw "$path" 2>/dev/null || true)
  [ "$export_team" = "$spec_team" ] || fail "$path names teamID ${export_team:-<none>} but ios/project.yml signs with $spec_team."
done

# Match the generator used for local validation. A runner's other version must
# not silently change the generated project; download only this checked release.
xcodegen_version=2.46.0
xcodegen_sha256=4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806
xcodegen_bin=$(command -v xcodegen || true)
if [ -z "$xcodegen_bin" ] || [ "$("$xcodegen_bin" --version 2>/dev/null || true)" != "Version: $xcodegen_version" ]; then
  tool_dir=$(mktemp -d "${TMPDIR:-/tmp}/muster-xcodegen.XXXXXX") || fail "Could not create a temporary tool directory."
  trap 'rm -rf "$tool_dir"' EXIT
  trap 'exit 1' HUP INT TERM
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 120 \
    "https://github.com/yonaskolb/XcodeGen/releases/download/$xcodegen_version/xcodegen.zip" \
    --output "$tool_dir/xcodegen.zip" || fail "Could not download XcodeGen $xcodegen_version."
  printf '%s  %s\n' "$xcodegen_sha256" "$tool_dir/xcodegen.zip" | shasum -a 256 -c - \
    || fail "XcodeGen archive checksum did not match the pinned release."
  unzip -q "$tool_dir/xcodegen.zip" -d "$tool_dir" || fail "Could not unpack XcodeGen."
  xcodegen_bin="$tool_dir/xcodegen/bin/xcodegen"
fi
[ -x "$xcodegen_bin" ] || fail "XcodeGen executable is missing."
[ "$("$xcodegen_bin" --version)" = "Version: $xcodegen_version" ] || fail "Unexpected XcodeGen version."

cd "$ios_dir"
"$xcodegen_bin" generate --spec project.yml || fail "XcodeGen could not generate the iOS project."
[ -f MusterCompanion.xcodeproj/project.pbxproj ] || fail "XcodeGen did not produce MusterCompanion.xcodeproj."
[ -f MusterCompanion.xcodeproj/xcshareddata/xcschemes/MusterCompanion.xcscheme ] \
  || fail "The shared MusterCompanion archive scheme is missing."
printf '%s\n' "Muster post-clone: generated MusterCompanion.xcodeproj with XcodeGen $xcodegen_version."
