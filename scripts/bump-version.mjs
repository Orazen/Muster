#!/usr/bin/env node

/**
 * Bump the version in package.json and electron-builder.yml.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch     → 0.1.27 → 0.1.28
 *   node scripts/bump-version.mjs minor     → 0.1.27 → 0.2.0
 *   node scripts/bump-version.mjs major     → 0.1.27 → 1.0.0
 *   node scripts/bump-version.mjs 0.2.0     → explicit version
 *
 * Commits the change, tags it, and optionally pushes:
 *   node scripts/bump-version.mjs patch --push
 *   node scripts/bump-version.mjs patch --no-push
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const push = args.includes("--push");
const noPush = args.includes("--no-push");
const bumpArg = args.find((a) => !a.startsWith("--"));

if (!bumpArg) {
  console.error("Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z> [--push|--no-push]");
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

// Update electron-builder.yml (version field)
const yml = readFileSync("electron-builder.yml", "utf-8");
const updated = yml.replace(
  /^version:\s*.*/m,
  `version: ${next}`
);
writeFileSync("electron-builder.yml", updated);

console.log(`Updated package.json and electron-builder.yml to ${next}`);

// Git commit and tag
execSync("git add package.json electron-builder.yml", { stdio: "inherit" });
execSync(`git commit -m "release: v${next}"`, { stdio: "inherit" });
execSync(`git tag v${next}`, { stdio: "inherit" });

console.log(`\nCreated commit and tag v${next}`);

if (push) {
  execSync("git push && git push --tags", { stdio: "inherit" });
  console.log("Pushed to origin. Release workflow will trigger automatically.");
} else if (!noPush) {
  console.log(`\nTo trigger the release, push the tag:`);
  console.log(`  git push && git push --tags`);
}
