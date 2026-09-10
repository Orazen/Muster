#!/usr/bin/env node

/**
 * Bump Muster's version. package.json is the ONLY version source —
 * electron-builder.yml has no version key. The download-page badge is
 * updated to match the candidate version when its current badge is found.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch     → 1.10.3 → 1.10.4
 *   node scripts/bump-version.mjs minor     → 1.10.3 → 1.11.0
 *   node scripts/bump-version.mjs major     → 1.10.3 → 2.0.0
 *   node scripts/bump-version.mjs 1.11.0    → explicit version
 *
 * Does not run git or start a release. The Release workflow can validate
 * a candidate SHA with dry_run enabled; pushing its exact v* tag starts
 * the publishing pipeline. Next steps are printed when this finishes.
 */

import { readFileSync, writeFileSync } from "node:fs";

const bumpArg = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!bumpArg) {
  console.error("Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

// Read current version
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const current = pkg.version;
const [major, minor, patch] = current.split(".").map(Number);

let next;
switch (bumpArg) {
  case "patch": next = `${major}.${minor}.${patch + 1}`; break;
  case "minor": next = `${major}.${minor + 1}.0`; break;
  case "major": next = `${major + 1}.0.0`; break;
  default:
    if (/^\d+\.\d+\.\d+$/.test(bumpArg)) {
      next = bumpArg;
    } else {
      console.error(`Invalid version or bump type: ${bumpArg}`);
      process.exit(1);
    }
}

console.log(`Bumping ${current} → ${next}`);

// Update package.json
pkg.version = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// Prepare the download-page badge for this candidate. Changing the badge
// does not prove that installers have been published. Its shape is part of the
// hand-edited page — if the regex misses, say so instead of silently
// writing the file back unchanged. package.json is already bumped by
// this point, so a missing page must warn, not crash.
let dl;
try {
  dl = readFileSync("www/download.html", "utf-8");
} catch {
  console.warn("WARNING: no www/download.html — skipping the download-page badge.");
  dl = null;
}
if (dl !== null) {
  const badge = new RegExp(`(<h1>Download Muster <span[^>]*>)v${current.replace(/\./g, "\\.")}(<\\/span>)`);
  if (badge.test(dl)) {
    writeFileSync("www/download.html", dl.replace(badge, `$1v${next}$2`));
    console.log(`Updated package.json and www/download.html to ${next}`);
  } else {
    console.warn(
      `WARNING: version badge for v${current} not found in www/download.html — ` +
      `update the <span id="dl-version"> text by hand.`,
    );
    console.log(`Updated package.json to ${next}`);
  }
}

console.log(`
Release candidate v${next} prepared. No Git commands or release actions were run.

Review the candidate diff and run the required checks, then commit it on main:
  git diff
  git add -A
  git commit -m "release: v${next}"
  CANDIDATE_SHA="$(git rev-parse HEAD)"
  git push origin main

In Actions → Release → Run workflow, set ref to that full CANDIDATE_SHA.
Keep dry_run checked (the default). It builds and validates without release
uploads, public mirror writes, or notarization submissions.

After the dry run passes and the release is authorized, tag that exact tested SHA:
  git tag v${next} "$CANDIDATE_SHA"
  git push origin refs/tags/v${next}

That tag push starts the publishing pipeline. Release gates determine whether
the artifacts can be published; a partial platform set remains a draft.
`);
