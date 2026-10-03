#!/usr/bin/env bash
#
# Assemble a LOCAL DEVELOPMENT .app bundle for the native Mac target.
#
# This is NOT a release packaging script. It exists because macos/ is a SwiftPM
# package whose only product is a bare Mach-O executable, so there is no bundle to
# launch during development. It deliberately:
#
#   * signs with an AD-HOC identity (codesign -s -) - never Developer ID
#   * does NOT notarize, staple, upload, publish or write any feed
#   * does NOT install into /Applications and does NOT modify the working install
#   * NEVER launches the bundle
#   * touches no GitHub Actions workflow
#
# SAFETY MODEL - this script deletes exactly one directory, so that one deletion is
# fenced in three ways:
#
#   1. CONTAINMENT. OUT_DIR and SCRATCH_PATH must resolve (symlinks followed) to
#      paths inside the workspace. A path that escapes - directly or through a
#      symlink - is refused. Override only with ALLOW_OUTSIDE_WORKSPACE=1, and the
#      ownership check below still applies even then.
#   2. NO SYMLINKS AT THE TARGET. If the output directory or the bundle path is
#      itself a symlink, the script refuses rather than following it.
#   3. OWNERSHIP MARKER. A sibling file, OUT_DIR/.muster-local-dev-bundle, records
#      the absolute path of the bundle this script built. Only a bundle named in a
#      matching marker is ever removed. A pre-existing directory at the same path
#      is left untouched and the run fails, so an unrelated bundle cannot be
#      destroyed.
#
#      The marker is deliberately a SIBLING of the bundle and never a file inside
#      it. codesign seals every file under Contents/, so a marker placed in the
#      bundle would make signing fail outright with "code object is not signed at
#      all". The marker survives a rebuild because only the .app is removed.
#
# Usage:
#   macos/Scripts/package-mac-app.sh
#   CONFIG=debug macos/Scripts/package-mac-app.sh
#   OUT_DIR=macos/.build/local-app-bundle macos/Scripts/package-mac-app.sh
#   ALLOW_OUTSIDE_WORKSPACE=1 OUT_DIR=/tmp/dev macos/Scripts/package-mac-app.sh

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
ALLOW_OUTSIDE_WORKSPACE="${ALLOW_OUTSIDE_WORKSPACE:-0}"

MARKER_FILE=".muster-local-dev-bundle"
MARKER_HEADER="created-by macos/Scripts/package-mac-app.sh - safe to replace"

step() { printf '\n=== %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

INFO_PLIST_SRC="${MACOS_DIR}/Resources/Info.plist"
ENTITLEMENTS="${MACOS_DIR}/Resources/MusterMac.entitlements"

for f in "${INFO_PLIST_SRC}" "${ENTITLEMENTS}"; do
  [ -f "$f" ] || fail "missing required file: $f"
done
[ -f "${REPO_ROOT}/package.json" ] || fail "package.json not found at ${REPO_ROOT}"
command -v python3 >/dev/null || fail "python3 is required for path resolution"

# --- SAFETY 1: resolve, follow symlinks, enforce containment ------------------
step "Safety: resolve output paths and enforce workspace containment"

WORKSPACE_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(os.path.abspath(sys.argv[1])))' "${REPO_ROOT}")"

# Validate both caller-influenced paths in one place, so the rule is stated once.
python3 - "${WORKSPACE_REAL}" "${SCRATCH_PATH}" "${OUT_DIR}" "${ALLOW_OUTSIDE_WORKSPACE}" <<'PY'
import os, sys

workspace, scratch, out, allow = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
workspace = os.path.realpath(workspace)
problems = []

def resolve(p):
    return os.path.realpath(os.path.abspath(p))

def inside(p):
    return p == workspace or p.startswith(workspace + os.sep)

for label, raw in (("SCRATCH_PATH", scratch), ("OUT_DIR", out)):
    real = resolve(raw)
    # A symlink anywhere in the chain that lands outside the workspace is an escape.
    if not inside(real) and allow != "1":
        problems.append(
            f"{label} escapes the workspace\n"
            f"    configured : {raw}\n"
            f"    resolved   : {real}\n"
            f"    workspace  : {workspace}\n"
            f"  A symlink in that path may be redirecting it. Use a path inside the\n"
            f"  workspace, or set ALLOW_OUTSIDE_WORKSPACE=1 to accept it deliberately."
        )
    # A symlink AT the final component is refused outright, even if it stays inside.
    if os.path.islink(raw):
        problems.append(
            f"{label} is a symlink and will not be followed: {raw} -> {os.readlink(raw)}"
        )
    print(f"  {label:<13} {raw}")
    print(f"  {'':<13} -> {real}{'  (OUTSIDE WORKSPACE, allowed)' if not inside(real) else ''}")

if problems:
    print("\nERROR: refusing to continue:\n", file=sys.stderr)
    for p in problems:
        print("  - " + p, file=sys.stderr)
    sys.exit(1)
PY

# --- SAFETY 2 and 3: no symlink at the target, ownership marker ---------------
APP="${OUT_DIR}/MusterMacDev.app"
CONTENTS="${APP}/Contents"

step "Safety: refuse symlinked target, require ownership marker before replacing"

[ ! -L "${OUT_DIR}" ] || fail "OUT_DIR is a symlink and will not be followed: ${OUT_DIR}"
if [ -L "${APP}" ]; then
  fail "refusing: ${APP} is a symlink -> $(readlink "${APP}"). Move it aside; this script does not write through symlinks."
fi

MARKER_PATH="${OUT_DIR}/${MARKER_FILE}"
APP_ABS="$(python3 -c 'import os,sys;print(os.path.realpath(os.path.abspath(sys.argv[1])))' "${APP}")"

if [ -e "${APP}" ]; then
  [ -d "${APP}" ] || fail "refusing: ${APP} exists and is not a directory. Move it aside."
  if [ ! -f "${MARKER_PATH}" ]; then
    fail "refusing to remove ${APP}
  It exists but there is no ownership marker at ${MARKER_PATH}, so this script did
  not create it. The directory is left completely untouched. Move it aside, or
  choose another OUT_DIR, and re-run."
  fi
  MARKED_PATH="$(sed -n '2p' "${MARKER_PATH}" 2>/dev/null || true)"
  if [ "${MARKED_PATH}" != "${APP_ABS}" ]; then
    fail "refusing to remove ${APP}
  The marker at ${MARKER_PATH} names a different bundle:
    marked : ${MARKED_PATH:-<empty>}
    actual : ${APP_ABS}
  Refusing rather than deleting something this script cannot prove it created."
  fi
  printf '  marker matches this bundle - safe to replace: %s\n' "${APP_ABS}"
else
  printf '  no existing bundle at %s\n' "${APP}"
fi

step "Inputs"
printf '  package path : %s\n' "${MACOS_DIR}"
printf '  workspace    : %s\n' "${WORKSPACE_REAL}"
printf '  product      : %s\n' "${PRODUCT}"
printf '  config       : %s\n' "${CONFIG}"
printf '  scratch path : %s\n' "${SCRATCH_PATH}"
printf '  out dir      : %s\n' "${OUT_DIR}"
printf '  bundle       : %s\n' "${APP}"
printf '  ad-hoc sign  : yes   |   launch: never\n'

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
# Ownership marker lives OUTSIDE the bundle: codesign seals every file under
# Contents/, so a file placed inside the bundle would break signing. This sibling
# survives a rebuild because only the .app directory is removed.
{
  printf '%s\n' "${MARKER_HEADER}"
  printf '%s\n' "${APP_ABS}"
} > "${MARKER_PATH}"
printf '  ownership marker: %s\n' "${MARKER_PATH}"

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
ENT_KEYS="$(codesign -d --entitlements - "${APP}" 2>/dev/null | grep -c '<key>' || true)"
printf '  entitlement keys requested: %s\n' "${ENT_KEYS}"
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
