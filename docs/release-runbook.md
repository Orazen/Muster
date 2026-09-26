# Muster release runbook

Everything below is proven by the v1.20.0 and v1.21.0 runs (see
`GATES.md` Loops 206–210). Follow it top to bottom; each step names the
gate that proves it.

## 0. What a release carries

Cut a release only when `main` is green (CI + autodeploy) and the tree
you tag is exactly what you tested. The tag — not a branch — starts the
publishing pipeline.

## 1. Bump the version

```bash
node scripts/bump-version.mjs minor   # 1.20.0 → 1.21.0 (semver-minor)
```

- `minor` here really is semver-minor (1.19→1.20, 1.20→1.21). The
  Loop206 incident was operator error, not the script — **read the
  script's output**: it prints `Bumping X → Y` and the exact tag to cut.
- The script also updates `www/download.html`'s badge. If it warns the
  badge was not found, fix the stale `<span id="dl-version">` fallback
  by hand (v1.21.0 needed this: it still said v1.12.1). The page
  fetches the live version at runtime; the static text is only the
  no-JS fallback, but it should not lie.
- `package.json` is the only version source. Commit it on main:

```bash
git add package.json www/download.html
git commit -m "Bump version to 1.21.0" -- package.json www/download.html
git push origin main
```

- Commit with `git commit -m ... -- <paths>` — in this shared checkout a
  bare `git commit` sweeps other agents' staged files into your release.

## 2. Wait for CI on the bump commit

```bash
gh run list --branch main --workflow CI --limit 1 --json headSha,status,conclusion
```

Expect `completed/success` on your exact HEAD sha (~10 minutes). The
workflow runs `tsc -b` + a stricter server tsconfig — stricter than a
local `tsc --noEmit` (noUnusedParameters bit Loop205's push).

## 3. Tag the tested sha

```bash
git tag v1.21.0 <full-sha-of-bump-commit>
git push origin refs/tags/v1.21.0
```

The `release-policy.mjs pin` gate hard-fails when the tag and
package.json disagree. Its error (improved in Loop207) names both
values and the fix. There is no v1.20.0→"next minor is 1.21" guessing:
the tag must equal `v` + the committed package.json version, exactly.

## 4. Watch the Release workflow (7 jobs)

```bash
gh run list --branch v1.21.0 --workflow Release --limit 1
```

Order: Pin → macOS x64 (Intel) ∥ macOS arm64 (sign, notarize, staple)
∥ Windows NSIS ∥ Linux (deb+AppImage) → Verify feeds and publish →
Deploy downloads to VPS. ~25–35 minutes total; the VPS upload of ~1 GB
of installers is the long tail. All 7 must be success.

Known one-off: the **first prepare step can fail** with "Draft creation
did not produce a confirmed matching draft" — GitHub listing cache lag
right after `gh release create`. The script re-verifies and reuses the
draft on re-run (that path exists for exactly this). Since Loop207 the
script also retries within a bounded settle window (3 attempts, 2s
apart), so a plain re-run of failed jobs should be rare. Re-run with
`gh run rerun <run-id> --failed`.

## 5. Verify the release (do not skip)

```bash
gh release view v1.21.0 --json isDraft,isPrerelease,name   # draft=false, prerelease=false
curl -s https://muster.orazen.online/downloads/latest-mac.yml | head -2
curl -sI https://muster.orazen.online/downloads/Muster-1.21.0-arm64.zip | head -1   # HTTP/2 200
```

Full installer smoke (proven in Loop208): download the dmg + zip,
compare sha512 against `latest-mac.yml`, mount, `codesign --verify
--deep --strict`, `spctl -a -t execute` (expect "Notarized Developer
ID"), `stapler validate` **on the DMG** — the staple lives on the DMG
by design (`scripts/notarize-mac.sh`); the updater zip's .app is
deliberately unstapled because restapling would invalidate the feed
hash.

## 6. Ledger

Append the release to `GATES.md` (and `docs/plans/ceo-log.md` if free):
the run id, 7/7 jobs, the mirror receipt, and any incident + its
resolution. Push. CI green on the docs push closes the loop.

## Quick reference — gotchas that already cost time

| Gotcha | Fact |
| --- | --- |
| Port env var | The server takes `OMB_PORT` (not `PORT`); default 8799. |
| Draft race | Draft-confirmation may fail once on cache lag; rerun failed jobs. |
| Tag rule | Tag = `v` + package.json version, on the CI-green bump commit. |
| Staple location | DMG only; never restaple the updater zip's app. |
| Static badge | `www/download.html` no-JS fallback needs a hand-edit if the regex misses. |
| Shared tree | Scope commits to paths; other agents' staged files are invisible until you commit. |
