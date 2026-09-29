// Xcode Cloud's export actions pass their export-options plists by PATH
// (`ci/<name>-exportoptions.plist`, resolved against the repository root).
// Those files were never committed, so every export step in build 587 died
// with xcodebuild's opaque exit 70 — while the archive step above it had
// already passed, which made the log read as a signing problem rather than a
// missing file. The post-clone script now checks them, but a check that only
// runs inside a build that is already failing is a slow alarm; this fails in
// CI instead, and pins the two ways they can drift again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../", import.meta.url));

/** The export methods Xcode Cloud runs, and the file each one needs. */
const EXPORTS = {
  "ad-hoc": "ad-hoc",
  "app-store": "app-store-connect",
  development: "development",
} as const;

/** Read one top-level `<key>k</key><string>v</string>` out of a plist.
 *  Deliberately not a plist parser: these files are three lines of Apple
 *  configuration, and a test that must survive a toolchain that is not
 *  installed to check them should not need one. */
function stringValue(plist: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match?.[1];
}

const spec = readFileSync(`${REPO}ios/project.yml`, "utf8");
const declaredTeam = /DEVELOPMENT_TEAM:\s*([A-Z0-9]+)/.exec(spec)?.[1];

describe("iOS export options", () => {
  it("ios/project.yml still declares exactly one signing team", () => {
    // If this fails, the team id is unreadable and every assertion below is
    // vacuous — which is the failure mode that makes a guard quietly useless.
    expect(declaredTeam, "no DEVELOPMENT_TEAM in ios/project.yml").toBeTruthy();
  });

  for (const [name, method] of Object.entries(EXPORTS)) {
    describe(name, () => {
      const path = `ci/${name}-exportoptions.plist`;
      const load = () => readFileSync(`${REPO}${path}`, "utf8");

      it("is committed, so the export action finds a file at the path it passes", () => {
        expect(() => load(), `${path} is missing; the export action passes this path by name`).not.toThrow();
      });

      it("is a plist document", () => {
        const plist = load();
        expect(plist).toContain("<plist");
        expect(plist).toContain("</plist>");
      });

      it(`exports with the ${method} method`, () => {
        expect(stringValue(load(), "method")).toBe(method);
      });

      it("signs with the team the project actually builds for", () => {
        // Hand-named provisioning profiles would be the alternative, and they
        // would have to match the account exactly. Automatic signing is why
        // this plist can be correct without inventing profile names — and it
        // is the thing to notice if someone switches to manual.
        const plist = load();
        expect(stringValue(plist, "teamID")).toBe(declaredTeam);
        expect(stringValue(plist, "signingStyle")).toBe("automatic");
      });
    });
  }

  it("the post-clone script checks every export plist the workflow passes", () => {
    // A guard that names two of three files is a guard with a hole in it, and
    // the omission is invisible until that one action starts failing.
    const script = readFileSync(`${REPO}ios/ci_scripts/ci_post_clone.sh`, "utf8");
    expect(script, "the post-clone script no longer validates the export plists").toContain("exportoptions.plist");
    for (const name of Object.keys(EXPORTS)) {
      expect(script, `post-clone never checks ${name}`).toContain(name);
    }
  });

  it("never lets an export rewrite the build number it was archived with", () => {
    // The archive carries the version and build Xcode Cloud was given.
    // Letting export manage them is how a build number gets replaced between
    // the archive and the upload.
    const plist = readFileSync(`${REPO}ci/app-store-exportoptions.plist`, "utf8");
    expect(/<key>manageAppVersionAndBuildNumber<\/key>\s*<false\/>/.test(plist)).toBe(true);
  });
});
