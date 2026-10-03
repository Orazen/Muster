#!/usr/bin/env bash
#
# Assemble a LOCAL DEVELOPMENT .app bundle for the native Mac target.
#
# This is NOT a release packaging script. It exists because macos/ is a SwiftPM
# package whose only product is a bare Mach-O executable, so there is no bundle to
# launch during native development. It deliberately:
#
#   * signs with an AD-HOC identity (codesign -s -) - never Developer ID
#   * does NOT notarize, staple, upload, publish or write any feed
#   * does NOT install into /Applications and does NOT modify the working install
#   * NEVER launches the bundle
#   * touches no GitHub Actions workflow
#
# Usage:
#   macos/Scripts/package-mac-app.sh
#   CONFIG=debug macos/Scripts/package-mac-app.sh
#   OUT_DIR=/tmp/whatever macos/Scripts/package-mac-app.sh
#
# Outputs are confined to the build scratch path and OUT_DIR, both overridable, so
# nothing is written outside the workspace.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${MACOS_DIR}/.." && pwd)"

# The SwiftPM product declared in macos/Package.swift:
#   .executable(name: "MusterMac", targets: ["MusterMac"])
# CFBundleExecutable and the file inside Contents/MacOS must match this exactly.
PRODUCT="MusterMac"

CONFIG="${CONFIG:-release}"
SCRATCH_PATH="${SCRATCH_PATH:-${MACOS_DIR}/.build}"
OUT_DIR="${OUT_DIR:-${SCRATCH_PATH}/local-app-bundle}"
APP="${OUT_DIR}/MusterMacDev.app"
CONTENTS="${APP}/Contents"

INFO_PLIST_SRC="${MACOS_DIR}/Resources/Info.plist"
ENTITLEMENTS="${MACOS_DIR}/Resources/MusterMac.entitlements"

step() { printf '\n=== %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

for f in "${INFO_PLIST_SRC}" "${ENTITLEMENTS}"; do
  [ -f "$f" ] || fail "missing required file: $f"
done
[ -f "${REPO_ROOT}/package.json" ] || fail "package.json not found at ${REPO_ROOT}"

step "Inputs"
printf '  package path : %s\n' "${MACOS_DIR}"
printf '  product      : %s\n' "${PRODUCT}"
printf '  config       : %s\n' "${CONFIG}"
printf '  scratch path : %s\n' "${SCRATCH_PATH}"
printf '  out dir      : %s\n' "${OUT_DIR}"
printf '  bundle       : %s\n' "${APP}"

step "Lint the committed plists (before substitution)"
plutil -lint "${INFO_PLIST_SRC}"
plutil -lint "${ENTITLEMENTS}"

step "Build the real Swift target"
# The only dependency is .package(path: "../ios") - a local path package - so this
# resolves with no network access.
swift build \
  --package-path "${MACOS_DIR}" \
  --scratch-path "${SCRATCH_PATH}" \
  --configuration "${CONFIG}" \
  --product "${PRODUCT}"

BUILT_BINARY="${SCRATCH_PATH}/${CONFIG}/${PRODUCT}"
[ -f "${BUILT_BINARY}" ] || fail "expected built binary at ${BUILT_BINARY}, but it is absent"
printf '  built: %s\n' "${BUILT_BINARY}"

step "Assemble the bundle"
rm -rf "${APP}"
mkdir -p "${CONTENTS}/MacOS" "${CONTENTS}/Resources"
install -m 0755 "${BUILT_BINARY}" "${CONTENTS}/MacOS/${PRODUCT}"
printf 'APPL????' > "${CONTENTS}/PkgInfo"
install -m 0644 "${INFO_PLIST_SRC}" "${CONTENTS}/Info.plist"

step "Stamp the version from package.json"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${REPO_ROOT}/package.json")"
BUILD="$(git -C "${REPO_ROOT}" rev-list --count HEAD 2>/dev/null || echo 1)"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "${CONTENTS}/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${BUILD}" "${CONTENTS}/Info.plist"
printf '  CFBundleShortVersionString = %s\n' "${VERSION}"
printf '  CFBundleVersion            = %s\n' "${BUILD}"

step "Sign ad-hoc with the development entitlements"
# Ad-hoc only. This grants no trust and is not a distribution signature.
codesign --force --sign - \
  --entitlements "${ENTITLEMENTS}" \
  --timestamp=none \
  "${APP}"
codesign --verify --deep --strict --verbose=2 "${APP}"

step "Verify: structure, executable, architecture, plist"
[ -d "${APP}/Contents/MacOS" ]        || fail "Contents/MacOS missing"
[ -d "${APP}/Contents/Resources" ]    || fail "Contents/Resources missing"
[ -x "${CONTENTS}/MacOS/${PRODUCT}" ] || fail "Contents/MacOS/${PRODUCT} is not executable"
plutil -lint "${CONTENTS}/Info.plist"

# CFBundleExecutable must equal the file name, or Launch Services will not start it.
PLIST_EXEC="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${CONTENTS}/Info.plist")"
[ "${PLIST_EXEC}" = "${PRODUCT}" ] || fail "CFBundleExecutable '${PLIST_EXEC}' != binary '${PRODUCT}'"
printf '  CFBundleExecutable matches the on-disk binary: %s\n' "${PLIST_EXEC}"

printf '  arch: %s\n' "$(lipo -archs "${CONTENTS}/MacOS/${PRODUCT}")"

step "Verify: linked libraries (no non-system dylibs to bundle)"
otool -L "${CONTENTS}/MacOS/${PRODUCT}"

step "Verify: entitlements actually applied"
codesign -d --entitlements - "${APP}" 2>/dev/null | tr -d '\0'
codesign -dvv "${APP}" 2>&1 | grep -E 'Identifier|TeamIdentifier|Signature|CodeDirectory' || true

step "Verify: no distribution artifacts leaked into the bundle"
# This bundle is not a release channel. If any of these appear, packaging has
# grown an updater or feed it was never meant to have.
LEAKS="$(find "${APP}" \
  \( -name 'latest*.yml' -o -name '*.blockmap' -o -name 'app-update.yml' \
     -o -name '*.dmg' -o -name '*.zip' -o -name '*.pkg' \) -print)"
[ -z "${LEAKS}" ] || fail "distribution artifacts found in a development bundle:
${LEAKS}"
printf '  no feeds, blockmaps, archives or updater config present\n'

step "Result"
printf '  Built a LOCAL DEVELOPMENT bundle at:\n    %s\n\n' "${APP}"
printf '  It is ad-hoc signed, unnotarized and unpublished. NOT an installable release.\n'
printf '  It has NOT been installed and has NOT been launched.\n'
