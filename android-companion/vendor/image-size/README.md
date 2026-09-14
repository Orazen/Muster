# image-size (vendored, wired in)

This directory **is** the `image-size` that Metro loads in `android-companion`.
It replaces the npm package of the same name, which is affected by two open
advisories in every published release.

## Why it exists

| Advisory | Affected range | Issue |
| --- | --- | --- |
| [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) (CVE-2025-71330) | `<=2.0.2` | ICNS parser allows denial of service through an infinite loop |
| [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) (CVE-2025-71329) | `<=2.0.2` | JXL and HEIF parsers allow denial of service through infinite loops |

`2.0.2` is both the top of the affected range and the newest release on npm, so
**no published version is unaffected** and no `overrides` entry pointing at the
registry can fix this. The upstream fix exists only on a Metro upgrade:
`metro@0.87.1` no longer depends on `image-size` at all. That is why `npm audit`
offers `react-native@0.87.1` — but this app is Expo SDK 52 /
`react-native@0.76.7` / `metro@0.81.5`, so taking that Metro is a **framework
migration, not a dependency bump**.

Metro uses the package in exactly one place, `node_modules/metro/src/Assets.js`,
which requires it as a bare module (`const getImageSize = require("image-size")`)
and calls it as `getImageSize(content)` reading only `{ width, height }` — once
with a `Buffer` and once with a file path. That is the entire surface this
directory reproduces.

## How it is wired in

`android-companion/package.json` declares this directory as a workspace:

```json
"workspaces": ["vendor/image-size"]
```

npm links it into `node_modules` under the package's own name, so
`node_modules/image-size -> ../vendor/image-size` and Metro's `require("image-size")`
lands here. It satisfies Metro's declared `image-size: ^1.0.2` without any
registry copy being installed, and `vendor/image-size` has no dependencies, so
the registry package's own dependency (`queue@6.0.2`) leaves the tree with it.

This is a **workspace**, not an `overrides` entry, deliberately — see the history
below. Two things keep the wiring honest rather than merely present:

- `scripts/metro-image-policy.cjs` resolves `image-size` the way Metro does and
  throws unless the realpath is under `vendor/image-size` **and** the version is
  the reviewed `1.2.1`. If the link ever disappears, Metro either fails to start
  or would pick up a copy from outside the repository; both now stop the build
  instead of silently bundling unpatched parsers. Removing the link trips the
  policy — verified with a fixture in both directions.
- `scripts/verify-metro-assets.mjs` asserts the resolved source and Metro's
  behaviour on renamed advisory inputs, with and without the policy loaded.

`1.2.1` in `package.json` is the **upstream API level this replacement was
reviewed against**, not a publish of ours; the policy keys on it so that a real
version change to the dependency stack still stops Metro for review.

## History: the override that does not resolve

Kept because it is the reason the wiring looks like this, and because the
obvious approach fails in a way that damages the tree.

**`overrides: {"image-size": "file:./vendor/image-size"}` does not work on npm
10.9.8.** npm resolved the path against the *dependent* package (metro) rather
than the project root and produced:

```
node_modules/metro/node_modules/image-size -> ../vendor/image-size   (dangling)
node_modules/metro/vendor/image-size                                 (does not exist)
```

The consequences were worse than doing nothing: `npm ls image-size` failed with
`ELSPROBLEMS`/`invalid`; Node then resolved `require("image-size")` **past the
project root** to `/Users/<user>/node_modules/image-size@1.2.1`, an upstream copy
outside the repository; and the two junk entries npm wrote into the lockfile made
every subsequent `npm install` abort with `npm error Invalid Version:`. `"$image-size"`
(npm's documented way to point an override at a direct dependency) fails the same
way. The lockfile was restored to its original bytes and the wiring reverted.
A stale dangling `.bin/image-size` link under `node_modules/metro/` was left
behind by that attempt and removed when the workspace wiring landed; fresh
installs do not recreate it.

## What it supports

`png`, `jpg`, `gif`, `bmp`, `webp` — real header parsing, byte-for-byte the
field layout upstream reads, so the dimensions Metro records do not change
because of the swap.

```js
const imageSize = require("image-size"); // through the workspace link
imageSize(buffer);       // { width, height, type }   (synchronous)
imageSize("a.png");      // { width, height, type }   (only image extensions)
imageSize.disableTypes(["icns"]);
```

## What it deliberately does not

There is **no ICNS, JXL, HEIF/HEIC, JP2/J2C, AVIF, PSD, TIFF, KTX, ICO/CUR,
DDS, TGA, PNM or SVG parser in this directory.** Those parsers are exactly what
the advisories describe, so they were not ported, not stubbed and not reachable.
The signatures are still recognised far enough to be named, so an error reads
`unsupported file type: icns` rather than `unsupported file type: undefined`,
but nothing behind them parses anything.

Every loop in `index.js` advances by at least one byte or returns, and every
multi-byte read is bounds-checked first, so the denial-of-service shape from the
advisories (an ICNS entry whose declared length is zero) is a prompt throw
instead of a hang. That is measured in-process *and* in a child process under a
hard timeout, so a reintroduced loop fails the test rather than hanging the
suite. The Metro-level checks assert the same property with no policy loaded at
all, so the parser is safe on its own and `disableTypes` is a second gate rather
than the only one.

## Deliberate differences from upstream

Recorded because this is a drop-in replacement and the differences should be
visible, not discovered:

1. **The path-taking form only opens known image extensions** (`png`, `jpg`,
   `jpeg`, `gif`, `bmp`, `webp`) and only regular files. Upstream will read any
   path it is given. Metro only ever passes a path from its own asset registry,
   so this costs bundling nothing — but it is a narrowing.
2. **Formats upstream parses and this does not** (SVG, PSD, TIFF, AVIF, ICO,
   KTX, …) throw instead of returning dimensions. This project has no such
   asset, and Metro fails loudly at build time if one is added, but an SVG asset
   would need a parser added here first.
3. **No `bin` entry.** Upstream ships `bin/image-size.js`; this package has no
   CLI, so no `node_modules/.bin/image-size` is created. Nothing in the build
   shells out to it.
4. **A zero-length input throws `Empty file`** instead of upstream's
   `unsupported file type: undefined`. Metro rejects empty assets before it
   calls this package, so no caller sees the difference.
5. **EXIF orientation is not extracted** from JPEGs. Metro reads only `width`
   and `height`, which are unaffected.

## Residual risk

**We own this parser now.** A bug here corrupts asset metadata in an Android
bundle; it is fixed by editing this directory, not by a version bump, and no
upstream release will send us a patch. The compensating controls are the test
suite, the Metro-level verification, and the policy gate that refuses to run
against anything but this source.

What is *not* covered: no Android device, emulator or native build was involved
— the evidence is Metro's own asset APIs and a real `expo export`. The parser
reads headers only; it does not validate image bodies. `sips`/`ffprobe`-verified
fixtures are the ground truth for dimensions, not this parser.

The durable fix is still the Expo / react-native upgrade that ships
`metro@0.87.1`, after which the dependency disappears entirely. That is the
moment to delete this directory rather than port it. It is tracked as the
follow-up; **no Expo/RN upgrade was attempted here.**

## Advisories: what is and is not proven

Removing this implementation from the tree is **not** the same as clearing the
alerts, and neither is claimed here.

`npm audit --json` on the wired tree still exits 1 and still reports both
advisories, now as:

```json
"image-size": { "severity": "high", "range": "*",
                "nodes": ["node_modules/image-size", "vendor/image-size"],
                "via": [{"range": "<=2.0.2"}, {"range": "<=2.0.2"}] }
```

The range renders as `*` because npm cannot compare the version of a
non-registry package; the alerts key on the package **name** and on Metro's
declared `image-size: ^1.0.2`. Raising the version above `<=2.0.2` does not help
either — it stops satisfying Metro's range, so npm would install the registry
copy alongside it.

**Dependabot closure is not proven from this machine.** Dependabot is a
different scanner: it resolves versions from `package-lock.json` registry
entries, and this package's entry is now `{ "resolved": "vendor/image-size",
"link": true }`, which carries no version for an advisory range to match. That
may close the alerts, but it was **not observed** — there is no GitHub access
from this session, and no scan has run since the change. The next scheduled scan
is the first real evidence. Until then the alerts stay open and this file does
not claim otherwise.

If they do not close, the fallbacks in order are:

1. **Dismiss with a documented reason** — the vulnerable implementations are
   absent from the tree, the path is a dev/build tool that parses local project
   assets, and the replacement is policy-gated and tested.
2. **The Expo SDK upgrade** shipping `metro@0.87.1`, which drops the dependency
   and the alerts with it.

## Tests

```bash
node --test vendor/image-size/test.mjs   # or: npm run test:image-size
```

10 tests, exit 0. Fixtures are embedded as base64 so the test needs no encoder
and no network. The 2×4 fixture dimensions were confirmed independently with
`sips -g pixelWidth -g pixelHeight` (PNG, GIF, BMP, JPEG) and `ffprobe` (the
three WebP variants), and the app's own `assets/*.png` dimensions with the same
`sips` read — not with this parser.

Metro-level evidence lives in `scripts/verify-metro-assets.mjs` (29/29), and
`scripts/metro-image-policy.cjs` asserts this source is the one Metro resolved.
