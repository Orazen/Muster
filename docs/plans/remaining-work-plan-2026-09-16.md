# Remaining work — consolidated plan (2026-09-16)

Written after studying `current-state.md`, `ceo-log.md`, `astra-ceo-mandate.md`,
`astra-gpt6-mvp-brief.md`, `engine-parity-vibe.md`, `obscura-browser-engine.md`,
`openmausbot-design-study.md`, `self-host.md`, `release-mirror.md`, and
`teach-replay-and-ios-folds-2026-09-16.md`, plus direct inspection of the
working tree. This is a plan, not a claim of work done. Every "already exists"
line below was verified by reading the file.

## 1. Shipped and verified this session

**Companion startup failure — fixed.** The live failure was a stale
`Muster Helper` process (pid 15186, launched from a mounted DMG copy of
1.12.1) squatting port 8811. Two separate defects were behind the message:

- The squatter itself: freed by killing the stale process and unmounting the
  two AppTranslocation volumes left by the public-user tests.
- The *reporting* defect, which is the real bug: `electron/companion.mjs`'s
  start loop only knew `the companion could not start — check the log` when the
  child exited before answering. That is a dead end for a user, because the
  panel then offers no action. Added `probeControlOwner()`, which asks the
  control port directly who owns it; the exited branch now reports
  `port 8811 is already serving another companion (pid N) — stop it and try
  again`, which is the actionable message `stopForeignCompanion()` already
  implemented but was never reachable. 628/628 electron tests pass,
  `node --check` clean.

**CI signing defect — fixed in the working tree (uncommitted).** The published
`Muster.dmg` and `Muster-1.12.1-arm64.zip` are signed `Apple Development:
ramagiritharun@gmail.com (ZY5WT3XRJS)`, not Developer ID — verified by
downloading both from the live mirror and inspecting the app inside. Gatekeeper
rejects that on every other Mac. Root cause: the `macos` job set
`CSC_IDENTITY_AUTO_DISCOVERY=true` and never pinned an identity, so
electron-builder's keychain auto-discovery picked whatever the
`APPLE_CERTIFICATE` secret held. Three edits to
`.github/workflows/release.yml`: export `APPLE_SIGNING_IDENTITY`; pass
`MAC_SIGNING_IDENTITY` into the build step (this also makes
`after-pack-mac.mjs:40` write the `trusted-mac-updates` marker, which unlocks
in-place Squirrel.Mac updates); and rewrite the pre-notarization gate to assert
`Authority=Developer ID Application` **and** `flags=0x10000(runtime)`. The old
gate only ran `codesign --verify`, which an Apple Development signature passes
cleanly — that is why nothing caught it.

**Notarization — done.** Submission `d95da729-00c0-48a8-84a6-d6f1674290dc`
was Accepted and stapled. `release/Muster-1.12.1.dmg`, 171,616,521 bytes,
sha256 `c8ea576c1116679f7a5ae61d3ba62c172f32068423b31ed4ac1b2b87536d2d5b`.
Verified the way a stranger hits it: `spctl --assess --type open` →
`accepted source=Notarized Developer ID`; a copy carrying a real
`com.apple.quarantine` attribute launches.

## 2. Blockers that only the owner can clear

These are hard stops, not tasks.

1. **GitHub Actions billing.** Run `34887118494` failed in 3 s with zero steps
   recorded (`"steps":[]`) and a `BlobNotFound` on its log — GitHub refusing to
   start jobs. No Windows or Linux leg can build until this is paid.
2. **`APPLE_CERTIFICATE` secret holds the wrong certificate.** It must be
   replaced with a Developer ID `.p12` export, and a new
   `APPLE_SIGNING_IDENTITY` secret set to the full
   `Developer ID Application: THARUN RAMAGIRI (7375K23WFU)` string.
3. **SSH to `173.249.38.101` is refused for every key on this machine.** The
   mirror promotion step needs working access plus the `VPS_SSH_KEY` secret.
   Read-only probing was stopped rather than guessed at.
4. **Apple Beta App Review.** Build 1 sits at `WAITING_FOR_BETA_REVIEW`; the
   public TestFlight link cannot serve until Apple approves it, and a second
   submission is rejected `ANOTHER_BUILD_IN_REVIEW`. Nothing to fix locally.

## 3. Remote access and Engines — the honest gap

The owner asked to port OpenMausBot's Remote-access and Engines surfaces "in
Muster's own layout and design". The load-bearing finding is that **both
surfaces already exist in Muster** — this is parity and polish work, not new
construction:

- `src/components/RemoteAccessSection.tsx` (18,017 bytes, wired at
  `SettingsModal.tsx:807`) already renders Secure HTTPS pairing, Tailscale
  pairing, Direct Wi-Fi pairing, Create pairing code, the Full access /
  Chat-and-approvals-only scope split, Keep this computer awake, Paired
  devices, and an Advanced & troubleshooting group.
- `src/components/EnginesSettings.tsx` (374 lines) already does the
  Ready / Needs setup split (`isReady()` at line 28), per-engine mark, account
  line, version, `Set up`, and `Check again`, fed by `GET /api/instances`
  (`server/index.ts:7370`). `EngineSetup.tsx` (181 lines) is the per-engine
  setup flow.

What OMB has that Muster does not, from the OMB bundle study:

**Remote access — missing pieces:**
- **Client mode** ("Connect to another computer"): using this desktop as a
  client for a remote Muster/OMB server, with two sub-modes — a 6-digit
  desktop-companion code, and a self-hosted-server link
  (`https://host/pair#code=XXXX-XXXX-XXXX`, 12 characters, query-string codes
  explicitly rejected).
- **"Connect your domain"** — custom-domain wiring for a self-hosted server.
- **Secure remote-access account** — email one-time-code sign-in before
  pairing, plus an email/domain allowlist for `/pair`.
- **Connection details** — reveal/copy a reachable address for manual pairing.

**Engines — missing pieces:**
- **"Add Claude account"** — the account-add flow (subscription OAuth vs API
  key vs Bedrock/Vertex). Muster's Engines row can point at a CLI path
  (`PATCH /api/instances/:id {cli}`) but has no account-add flow.
- Engine count: the plan doc `engine-parity-vibe.md` claims eleven registered
  CLI/ACP engines including Mistral Vibe. Treat that as a documentation claim
  to re-verify against `server/drivers/` (28 non-test driver files present)
  before repeating the number.

Note the Muster `Remote access` labels the owner pasted are a mix: the
"could not start — check the log" line was Muster's own (now fixed), while
"Connect to another computer" / "Self-hosted server" / "Server pairing link"
are OMB's and are genuinely absent here.

## 4. Release and distribution

The notarized 1.12.1 DMG **cannot replace the broken one in place**. The mirror
contract (`docs/release-mirror.md`) refuses same-version byte replacement and
refuses to drop a previously published platform. Shipping the signing fix
therefore needs a **1.12.2** build that includes:

- macOS arm64 DMG + zip (Developer ID signed, notarized, stapled)
- macOS Intel DMG + zip — mandatory, since Intel is currently published
- Windows NSIS exe + zip — **none exist for any 1.12.x**; the live Windows feed
  is stranded at 1.10.4
- Linux AppImage + deb — **none exist for any 1.12.x**
- CLI bundle (`muster-cli.mjs` + `Muster-1.12.2-cli.mjs` + checksums)
- the three feeds, plus the four `SHA256SUMS-*` files

The Windows and Linux legs cannot be built on this macOS machine; they need CI
(blocked on billing) or a Linux/Windows host. The macOS legs can be built here
and are the part that actually fixes the Gatekeeper defect.

## 5. Recommended order

1. **Commit the two verified fixes** (companion probe; CI signing gate) so they
   are not lost. Both are tested; neither is committed yet.
2. **Owner clears the three external blockers** (Actions billing, the two
   secrets, VPS SSH). Nothing in §4 moves without at least the first two.
3. **Build 1.12.2 macOS legs locally**, notarize and staple, then run the
   payload producer in `validate` mode against the staged directory to surface
   every missing file before anyone touches the mirror.
4. **Remote access client mode + secure account** — the genuinely missing OMB
   surface, and the one with real user value (pairing a desktop to a remote
   server). Design in Muster's components, not OMB's.
5. **Engines "Add Claude account"** — the second real gap.
6. **Windows/Linux 1.12.2 legs** once CI is unblocked, then one complete
   multi-platform promotion.
7. **TestFlight** — nothing to do but wait for Apple; re-run
   `~/.appstoreconnect/advance-beta.cjs` periodically.

## 6. Explicitly not verified

- No live 1.12.2 build exists; the version has not been bumped.
- No mirror promotion was attempted; the VPS was unreachable.
- The eleven-engine count is a documentation claim, not re-verified here.
- The OMB parity list comes from reading OMB's shipped bundle strings, not from
  exercising OMB's pairing or account-add flows end to end.
- No security claim: the last full Mimosa scan did not complete cleanly.
---

## Addendum (same day) — status correction and OMB study intake

### Correction: the two fixes are already committed

The body of this plan says the companion startup fix and the CI signing
gate are "tested, uncommitted". That is wrong. Both landed in commit
`3d79c49` ("feat(settings): Remote access section, OMB-style engine list,
organisation + experimental"), which:

- added `probeControlOwner()` and the actionable
  "port 8811 is already serving another companion (pid ...) — stop it and
  try again" state in `electron/companion.mjs`;
- added the Developer ID authority + hardened-runtime gate and the
  `APPLE_SIGNING_IDENTITY` env wiring in `.github/workflows/release.yml`;
- bumped the version 1.12.1 -> 1.12.2.

`package.json` now reads `1.12.3` at both HEAD and on disk. So the
"commit the fixes" step is done; only the plan doc itself was ever
untracked. `main` is 2 commits ahead of `origin/main`
(`a1ec945`, `0b9b1a0`) and neither is pushed.

### OMB remote access + engines surface (from reading the shipped bundle)

The OMB UI is a single ~3.46 MB minified bundle
(`ui/assets/index-BLLsDK2F.js`) with 11 concatenated locale tables
(English, German, Spanish, French, Hindi, Japanese, Portuguese,
Simplified Chinese, Traditional Chinese, Ukrainian). Namespaces present:
`engines.*`, `remote.*`, `phone.*`, `companion.*`.

Pairing surface to match:

- Three server-side pairing methods: **Secure HTTPS pairing** (marked
  Recommended), **Tailscale pairing**, **Direct Wi-Fi pairing**.
- A **client role** — "Connect to another computer" — with two modes:
  Desktop companion (6-digit code) and Self-hosted server (12-char code
  embedded as `https://host/pair#code=XXXX-XXXX-XXXX`; query-string
  codes are explicitly rejected).
- One-time pairing codes with a 5-minute expiry, and two scopes:
  **Full access** (`scope.admin`) vs **Chat and approvals only**
  (`scope.client`). Chat-scoped devices cannot create codes.
- Paired-device list, secure remote-access account (email one-time code),
  reveal/copy address for manual pairing, keep-awake, local-only, and an
  email/domain allowlist for `/pair`.

Engines surface to match: grouped by readiness (Ready / Needs setup) with
counts and a "Check again" action, per-engine account + version lines, a
"Set up" button on not-ready engines, a CLI path override
(`engines.setCli`, `engines.manualPath`), and **Add / reuse a Claude
account** (`engines.account.*`, including reusing an existing config
directory). Provider brands present: OpenCode, Antigravity,
OpenAI-compatible, Moonshot, Factory, plus a "Bring your own model" entry.

Two anomalies worth not copying: several i18n keys store *another key
name* as their value (e.g. `remote.serverPairing.creating` =
`remote.serverPairing.create`) and only resolve if the lookup is
recursive; and the Ukrainian table still leaks English
(`remote.serverPairing.chatOnly`) and is missing `remote.signInAccess.*`.

### Caveats

This addendum reflects reading OMB's shipped strings and the Muster tree,
not exercising OMB's pairing or account-add flows end to end, and not a
re-verification of the "eleven engines" documentation claim.
