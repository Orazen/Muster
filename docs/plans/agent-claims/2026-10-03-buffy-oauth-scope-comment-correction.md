# AGENT CLAIM — OAuth scope comment correction (comment-only)

Date: 2026-10-03
Agent: Buffy (Freebuff lane, backend/auth)
Assigned by: **Astra**, PR #39 comment ("Astra integration review — claim and
coordination checkpoint")
Base: `origin/main` = `3067009`
Branch: `task/oauth-scope-comment`

```txt
AGENT CLAIM

Agent: Buffy (backend/auth lane)
Task: Correct an inaccurate OAuth scope classification in comments only.

Goal: Two comments state that `drive.appdata` is a "RESTRICTED" Google scope and
      that it triggers the unverified-app interstitial. Google classifies
      `drive.appdata` as NON-SENSITIVE. Leaving this uncorrected misleads future
      agents and, at `server/google-auth.ts`, actively argues against the
      owner's preferred storage direction. No behaviour changes.

Files I plan to touch:
- server/auth.ts                (comment block only, ~lines 412-421)
- server/google-auth.ts         (doc comment only, ~lines 12-16)

Files I will not touch:
- Any scope value, function body, import, or export.
- GOOGLE_DRIVE_SCOPE and the drive-scope predicate at google-auth.ts:20+ —
  that predicate is CORRECT and must keep working.
- server/drive-oauth.ts, server/workspace-bundle-v2.ts
- All storage / migration code — explicitly excluded by Astra.
- docs/AGENT_COMMUNICATION.md, docs/plans/agent-claims/INDEX.md
  (Astra owns the claims register; do not touch)
- PR #39's four paths — reserved to me on that branch, untouched here.

Expected output:
- Two corrected comment blocks, each citing the official Google source.
- No change to any runtime value.

Verification planned:
- git diff shows ONLY comment lines changed (no executable lines).
- Prove scope values are byte-identical before/after:
    git show <base>:server/auth.ts | grep -n "scope:"
- Run the affected tests: server/google-auth.test.ts server/auth.test.ts
  server/desktop-auth.test.ts server/drive-oauth.test.ts
  and confirm identical pass counts to baseline.
- npx tsc --noEmit -p tsconfig.server.json
- npm run lint

Status:
Claimed
```

## Why this is comment-only and separate

Astra's instruction: *"comment-only classification/onboarding rationale, no
scope or runtime change"*, and *"This correction does not depend on choosing a
storage migration."*

That separation is the point. The comment is wrong **today**, regardless of which
storage direction is chosen, so it is corrected independently. Bundling it with a
storage change would disguise a documentation fix as a behaviour change and
couple it to a decision that has not been made.

## Ownership check before editing

Per Astra's condition *"conditional on your current claim/ownership check"*:

- `server/auth.ts` and `server/google-auth.ts` — **no other open PR touches
  them.** Verified: #32 (Cue, restore process-restart), #37 (Charm hardware
  docs), #38 (Astra, claims register), #39 (mine) — file lists checked, no
  overlap.
- Local `main` has 5 unpushed commits touching `macos/Sources/…` and docs, not
  `server/**`.
- No other agent has claimed these paths in the emerging
  `docs/plans/agent-claims/` directory.

**No conflict. Claim is clean.**

## The two defects

**Site 1 — `server/auth.ts:412-421`.** Claims `drive.appdata` "is a RESTRICTED
scope, and requesting it at login makes Google show every new user the 'Google
hasn't verified this app' interstitial".

- Google lists `drive.appdata` under **non-sensitive** scopes, requiring only
  basic OAuth App Verification:
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- The unverified-app screen applies to **sensitive or restricted** scopes:
  <https://support.google.com/cloud/answer/7454865>

**Site 2 — `server/google-auth.ts:12-16`.** Claims **"`drive.*` is RESTRICTED"**.
This is broader and false: `drive.appdata`, `drive.appfolder`, `drive.install`
and `drive.file` are all non-sensitive; only `drive`, `drive.readonly`,
`drive.metadata`, `drive.activity`, … are restricted.

This site is the more damaging one, because it implies `drive.file` would pull
Muster into restricted-scope verification — which would **block the owner's
preferred visible-folder migration**.

**Critical nuance, to avoid over-correcting:** `GOOGLE_DRIVE_SCOPE` at
`google-auth.ts:20` is genuinely the restricted `auth/drive`, used as a
namespace prefix for the drive-scope predicate that must keep matching
`drive.*` and rejecting lookalikes. **The predicate stays. Only the prose about
sensitivity changes.** "Is this string a Drive scope?" and "is this scope
restricted?" are different questions that the comment conflates.

## What will NOT change

- `GOOGLE_SIGNIN_SCOPES = ["openid", "email", "profile"]` stays.
- Drive remains a separate opt-in connect; no scope is added or removed.
- The drive-scope predicate and its tests are untouched.

Backing these to a real decision is out of scope: the current behaviour is
reasonable, and only the stated justification is wrong.