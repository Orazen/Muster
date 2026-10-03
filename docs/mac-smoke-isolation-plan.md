# macOS smoke-test isolation plan (prepared, not executed)

**Agent signature:** `AGENT-4 / native-Mac-release-docs-lane` · 2026-10-03
**Companion to:** [`mac-smoke-checklist.md`](./mac-smoke-checklist.md) — the 37 tests that remain **NOT RUN**
**Reviewed SHA:** `origin/main` @ `30670099582476ce31099038c852e022b5685fa9`

## Why this document exists

The checklist's 37 behavioural tests are all blocked on one question: **how do we run the app without touching the user's real data?** This answers it with a plan. It executes nothing.

## The hard constraint

The user's working installation at `/Applications/Muster.app` **must not be uninstalled, replaced, or launched**, and real user data **must not be read or written**. Two candidate shortcuts are therefore ruled out on principle, not preference:

| Shortcut | Why it is not isolation |
|---|---|
| Run the extracted app in place | Uses the user's login Keychain and `~/Library`. Directly violates the constraint. |
| Run with `HOME=<temp>` | `HOME` redirects *neither* the login Keychain (per-login-session, not per-`HOME`) *nor* TCC grants (stored per-user under `/Library/Application Support/com.apple.TCC`). It would appear isolated while still writing real state. **This is the dangerous one, because it looks safe.** |

## Probed facts about this machine (read-only)

| Fact | Value |
|---|---|
| Architecture | `arm64` |
| Console user | `ramagiritharun` (also the current user) |
| Existing non-system accounts | `ramagiritharun` only — **no test account exists** |
| `Virtualization.framework` | **present** |
| Cached macOS runtime image | **none present** |
| `tart` | not installed |

## Option A — separate macOS user account (recommended first)

**Why it is sufficient for most tests.** macOS isolates the three things that actually matter:

| Concern | Isolated by a separate account? |
|---|---|
| Login Keychain | ✅ per-login-session |
| TCC privacy grants (mic, screen, accessibility, speech) | ✅ per-user |
| `~/Library/Application Support` | ✅ per-user |

A separate account therefore gives **genuinely fresh TCC prompts**, which is exactly what permission tests (A3.1–A3.6) need and cannot get any other way.

**Setup (requires explicit authorisation — creates a real system account):**

1. Create a local account, e.g. `muster-smoke`, with a known password. Record it in the coordination thread, **not** in a repo file.
2. Do **not** grant it admin rights; non-admin is enough to install into `/Applications` only if already present, so plan to test from a mounted DMG or a copy the account can read.
3. Log in as that account once so its Keychain and TCC store initialise.
4. Run the suite from the standard checklist as that user.
5. Afterwards: delete the account and its home directory.

**Unblocks:** A2 (install), A3 (all permissions — with genuinely fresh prompts), A4 (login), A5 (persistence), A8 (uninstall/reinstall), A9 (credential protection).
**Does not unblock:** A6.5–A6.6 (failed/destructive upgrade recovery) — see Option B.
**Cost:** low. **Risk:** low, but it is a real system change and therefore needs authorisation.
**Not executed.** No account was created.

## Option B — disposable macOS VM (needed for destructive tests)

**Required for A6.5, A6.6 and A7.4/A7.5** — the tests that must be able to destroy state and start over. Neither a second account nor the host can do that safely.

`Virtualization.framework` is present, but **no runtime image is cached and `tart` is not installed.** Obtaining an image is a download and an install, which is **outside the authorisation for this documentation task** and is not something I will do unprompted.

**Proposed path once authorised, cheapest first:**
1. Install a VM runner (`tart`, or Xcode's own tooling).
2. Fetch a macOS runtime image matching the host major version.
3. Create one disposable VM; snapshot it **after** first boot and after the test user is provisioned.
4. Run the destructive tests, destroy the VM, restore the snapshot for the next test.

**Unblocks:** everything in Option A **plus** A6.5, A6.6, A7.4, A7.5, A7.6.
**Cost:** high — image download, setup time, several hours.
**Not executed.** Nothing downloaded or installed.

## Option C — the one test that needs neither

**A6.1–A6.4 (in-place auto-update) does not require deleting or reinstalling anything.** `v1.23.2` and `v1.23.3` are both published, so an arm64 install can be updated through the real updater.

It **does** modify the working installation, so it still needs authorisation — but it is a single reversible step rather than a destructive test, and it is the highest-value-per-risk item in the whole checklist because it exercises the real update channel end to end.

**Recommended sequence:** C (with authorisation) → A → B.

## What I need from the owner

| # | Decision | Why it blocks |
|---|---|---|
| 1 | Authorise a **separate macOS account** (`muster-smoke`) for permission/login/persistence tests? | Unblocks ~26 of the 37 tests |
| 2 | Authorise **A6.1–A6.4** on the working installation? | Highest value per unit of risk; needs a reversible in-place update |
| 3 | Authorise a **VM + runtime image download**? | Only route to the 5 destructive tests |

## Invariants for whoever executes this

- The user's `/Applications/Muster.app` is **never** removed or replaced without an explicit, itemised instruction.
- Real user data is **never** read, copied, moved, or written.
- No secret for the test account is ever committed to the repository.
- Every executed test records: operator, date, machine, artifact version and architecture, steps, expected, **actual**, and evidence.
- Anything not executed stays marked **NOT RUN**. A checklist that reads as fully green because someone filled in assumptions is worse than one that honestly shows 37 gaps.
