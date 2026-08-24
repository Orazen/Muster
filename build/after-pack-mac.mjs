// electron-builder afterPack hook — macOS only.
//
// Real root cause of the "Muster is damaged and can't be opened. You should
// move it to the Bin." Gatekeeper message on the unsigned release build,
// reproduced and diagnosed live: `codesign --verify` on the packaged .app
// reports "code has no resources but signature indicates they must be
// present" even though electron-builder correctly skipped real signing
// (CSC_IDENTITY_AUTO_DISCOVERY=false, confirmed in CI logs). The cause is
// that Apple Silicon binaries always carry a low-level ad-hoc Mach-O
// signature applied at compile time; electron-builder's later packing
// steps (extraResources, asar, entitlements/Info.plist writes) modify the
// bundle's contents afterward without resealing it, leaving that
// signature internally inconsistent — which Gatekeeper reports as
// "damaged," not as "unsigned" (the two are different failure states, and
// only the fully-consistent one — signed OR cleanly ad-hoc, never
// partial — avoids the "damaged" message).
//
// Fix: explicitly re-sign the whole bundle with a fresh, internally
// consistent ad-hoc identity ("-") whenever there is no real Apple
// Developer identity in play. This does not make the app "signed" in any
// trust sense (Gatekeeper still requires the user's one-time xattr -cr /
// right-click-Open bypass, same as the README already documents, or the
// Homebrew cask which does this automatically) — it only fixes it from
// "damaged" (a hard block) to "unidentified developer" (the normal,
// expected, resolvable unsigned-app prompt).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  // Real Developer ID signing in play: drop the marker electron/updater.mjs
  // looks for, which unlocks Squirrel.Mac's in-place restart updates. Its
  // absence is what routes unsigned builds to the direct-download flow.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "true" && process.env.MAC_SIGNING_IDENTITY) {
    const markerPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app/Contents/Resources/trusted-mac-updates`;
    writeFileSync(markerPath, `identity: ${process.env.MAC_SIGNING_IDENTITY}\n`);
    console.log(`[afterPack] trusted-mac-updates marker written (${markerPath})`);
    return;
  }

  // Never fight a real Apple Developer identity — this hook exists only
  // for the "no cert configured" path CI already detects and handles via
  // CSC_IDENTITY_AUTO_DISCOVERY=false.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "true") {
    // Signed by an outside mechanism but no identity name passed to us:
    // conservative default is still the manual-update flow; the marker
    // only appears through the explicit branch above.
    return;
  }

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`[afterPack] re-sealing ${appPath} with a clean ad-hoc signature`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
}
