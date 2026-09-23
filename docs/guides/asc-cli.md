# asc — App Store Connect CLI (agent guide)

**Status:** verified working 2026-09-23 (auth, apps, Xcode Cloud, TestFlight —
real outputs recorded below). This doc is the map so a future agent never has
to re-derive Apple-side access.

`asc` is a third-party App Store Connect CLI (single Go binary, upstream:
github.com/rorkai/App-Store-Connect-CLI, site https://asccli.sh). The owner
installed it at `/opt/homebrew/bin/asc` (v5.4.0, `brew install asc` or
`curl -fsSL https://asccli.sh/install | bash`).

## 1. Authentication (already set up — do not recreate)

- Profile **`default`** is stored in the **macOS system keychain** (asc's
  default storage; encrypted key material, not plaintext). `asc auth doctor`
  → *"[OK] default - valid private key stored in keychain / No issues found"*
  as of 2026-09-23.
- How it was registered (for a future machine, values come from env/secrets
  or the owner — **never from this file**):

  ```bash
  asc auth login --name default \
    --key-id <KEY_ID> --issuer-id <ISSUER_UUID> \
    --private-key "$HOME/Downloads/AuthKey_<KEY_ID>.p8" --fix-permissions
  ```

- **Where the values live:** App Store Connect → Users and Access →
  Integrations → App Store Connect API → *Issuer ID* (page also lists Team/
  Individual keys). The `.p8` private key was provided by the owner in
  `~/Downloads` (file mode forced to 0600 by `--fix-permissions`).
- **Key facts:** the active Team key (name `muster-full`, Admin access) was
  created 2026-09-20. The **previous key was revoked 2026-09-20** — if auth
  suddenly fails with 401/403, suspect a revoked/rotated key before anything
  else and ask the owner; never mint a new key yourself (see §5).
- If auth breaks: `asc auth doctor` first, then `asc auth login` again with
  fresh values from the owner. Config fallback would be `~/.asc/config.json`
  (0600) — do not commit it; do not `--local` (that would put credentials in
  the repo).

## 2. What we verified (real commands, real outputs)

```bash
asc apps list
# 6812594576  MusterCompanion  com.muster.companion
# 6812538000  MusterWatch      com.muster.companion.watchkitapp

asc xcode-cloud workflows --app 6812594576
# ONE workflow: "Default"  ID ED2EC268-1D5F-46F0-AB1C-FB7191F8849F (enabled)
# (MusterWatch: "no Xcode Cloud product" — expected, Xcode Cloud is enabled
#  only for the companion app.)

asc xcode-cloud actions --run-id <latest>
# ONE action: "Archive - iOS" (type ARCHIVE)
```

- **Start behavior:** `GIT_REF_CHANGE` builds fire on every `main` push.
- **Auto-cancel is ON** (Apple workflow start-condition setting): a newer run
  cancels the in-flight one. Observed 2026-09-23: build 287 CANCELED 8s after
  288 started; 289 CANCELED by 290 — **each successor SUCCEEDED** (286, 288,
  290 green). Canceled ⇒ superseded, not broken. The setting lives in App
  Store Connect → Xcode Cloud → Default → start condition (owner-side; API
  cannot change it). Fix = uncheck Auto-cancel Builds or narrow the start
  condition to tags/release branch.
- **On-demand archive (verified end-to-end):**

  ```bash
  asc xcode-cloud run --workflow-id ED2EC268-1D5F-46F0-AB1C-FB7191F8849F \
    --branch main --wait --doctor --poll-interval 15s --timeout 7m
  # Build 291, MANUAL → SUCCEEDED in 1m37s; exports produced:
  # app-store.zip, ad-hoc.zip, development.zip, .xcarchive, .xcresult
  ```

- **TestFlight state (2026-09-23):** `asc builds list --app 6812594576` →
  **9 builds**, version 1.0.0, all `VALID`, newest build 9 (2026-09-21),
  encryption `exempt`, none expired. The Xcode Cloud workflow does **not**
  upload to TestFlight (successful runs 285–291 created no new TF build) —
  distribution is a separate, owner-gated act.

## 3. Agent skills pack (installed)

`asc install-skills` checked out reviewed commit `f52c4f04323bb2dfb21ca8be82e6494e9cd0b4d8`
(no installer executed) and installed **25 skills** into the global agent
skills directory (`~/.claude/skills`, mirrored to `~/.agents/skills`). They
are auto-discovered by agents. Most relevant here:

| Skill | Use |
|---|---|
| `asc-cli-usage` | flags, output formats, pagination, auth, discovery |
| `asc-xcode-build` | archive/export/upload build numbers |
| `asc-testflight-orchestration` | TF groups/testers/What-to-Test |
| `asc-build-lifecycle` | processing, latest builds, cleanup |
| `asc-release-flow` / `asc-submission-health` | staging → publish → submit / diagnose blockers |
| `asc-crash-triage` | TF crashes, beta feedback, hangs |

Upgrades are explicit (the pin lives in asc's source), never automatic.

## 4. Recipes (copy-paste, all verified)

```bash
asc auth doctor                                  # auth health
asc apps list                                    # app IDs
asc status --app 6812594576                      # one-screen release overview
asc xcode-cloud build-runs --workflow-id ED2EC268-1D5F-46F0-AB1C-FB7191F8849F \
  --sort "-number" --limit 6 --output table      # latest runs first
asc xcode-cloud run --workflow-id ED2EC268-... --branch main --wait --doctor
asc builds list --app 6812594576 --limit 5 --output table
asc builds info --app 6812594576 --latest
```

Notes: `build-runs` lists **oldest first** by default — always
`--sort "-number"`. Page output vs JSON: `--output table|json`. Refs returned
by any list are single-use identifiers.

## 5. Owner gates — never do these without explicit owner approval

- **App Store submission** (publish/submit/cancel/retry), pricing, agreements,
  app record creation, metadata publication.
- **TestFlight external distribution** (adding groups/testers, `--submit`).
  Inspecting builds/groups is fine; distributing is not.
- **Creating, revoking, or expiring API keys or signing certificates.**
- **Expiring builds** (`asc builds expire*`) — destructive.
- Anything touching Apple Ads spend.
- Credentials: no `.p8`, no issuer/key literals, no `~/.asc/config.json`, no
  keychain export ever enters the repo or a log. Values come from env/secrets
  or the owner, on demand.
- No security claims anywhere (the scanner re-run is still outstanding).

## 6. One-line summary for agents

Auth is already in the keychain — start with `asc auth doctor`, browse with
the §4 recipes, use the installed `asc-*` skills for anything multi-step, and
stop at §5: builds and inspection are yours, distribution and submission are
the owner's.
