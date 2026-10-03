# Handoff — incorrect OAuth scope comment in `server/auth.ts`

Date: 2026-10-03
From: Buffy (Freebuff lane)
To: **owner of `server/auth.ts`** (not me — `server/**` is outside my claim)
Reviewed SHA: `origin/main` = `3067009`
Related: PR #39

## Scope of this handoff

**One comment block. One file. No behaviour change.**

This is deliberately **separate** from the storage-direction work
(`docs/plans/2026-10-03-drive-visible-folder-migration-proposal.md`). They are
independent: the comment is **factually wrong today** regardless of which
storage direction is chosen, so it should be corrected whichever way the owner
decides. Bundling it with a storage change would make a documentation-accuracy fix
look like a behaviour change, and would couple it to a decision that has not been
made.

## The defect — TWO sites, not one

### Site 1 — `server/auth.ts`, lines ~410-419

In the Google sign-in provider setup:

```ts
// Sign-in stays basic-scope on purpose (GOOGLE_SIGNIN_SCOPES in
// server/google-auth.ts is the one home for that list): drive.appdata
// is a RESTRICTED scope, and requesting it at login makes Google show
// every new user the "Google hasn't verified this app" interstitial
// (scope verification is separate from branding — restricted scopes
// need a security assessment). Accounts that granted Drive earlier
// keep their stored refresh token, so workspace Drive backup still
// works for them; a separate opt-in Drive connect is the follow-up
// for everyone else.
```

## Why it is wrong

**Claim 1 — "`drive.appdata` is a RESTRICTED scope."** False.

Google's scope reference lists `drive.appdata` under **Non-sensitive scopes**:
"View and manage the app's own configuration data in your Google Drive."
Non-sensitive scopes "provide the smallest scope of authorization and only
require basic OAuth App Verification." `drive.appdata` is grouped with
`drive.appfolder`, `drive.install` and `drive.file` — not with the restricted
list (`drive`, `drive.readonly`, `drive.metadata`, …).

Source: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>

**Claim 2 — "requesting it at login makes Google show every new user the
unverified-app interstitial."** Not supported for this scope.

The unverified-app screen displays when "your app uses **sensitive or restricted**
scopes and you haven't configured them in your OAuth consent screen configuration
page and requested verification." `drive.appdata` is neither, so it does not
trigger that screen on its own.

Source: <https://support.google.com/cloud/answer/7454865>

### Site 2 — `server/google-auth.ts`, lines ~12-16

The doc comment on `GOOGLE_SIGNIN_SCOPES`:

```ts
/**
 * Basic identity scopes for SIGN-IN only. A Drive scope must never appear
 * here: drive.* is RESTRICTED at Google, and requesting it at login shows
 * every new user the "Google hasn't verified this app" interstitial. The
 * separate Drive connect consent lives in server/drive-oauth.ts and asks
 * for `openid drive.appdata` on its own.
 */
```

This one is **more wrong than site 1**, in a way that cuts the opposite
direction: the blanket claim **`drive.*` is RESTRICTED** is false.
`drive.appdata`, `drive.appfolder`, `drive.install` and `drive.file` are all
**non-sensitive**. Only `drive`, `drive.readonly`, `drive.metadata`,
`drive.activity`, … are restricted.

Left uncorrected, site 2 argues *against* the recommended migration: it implies
the visible-folder option (`drive.file`) would drag Muster into restricted-scope
verification, when `drive.file` is explicitly non-sensitive. So this comment
would block the very change the owner prefers.

**Nuance, so the fix is not itself wrong:** `GOOGLE_DRIVE_SCOPE` in
`server/google-auth.ts:20` is `https://www.googleapis.com/auth/drive` — the
genuinely restricted full-Drive scope. It is used as a namespace prefix for a
`isDriveScope()`-style predicate that matches `drive.*` and deliberately rejects
lookalikes outside that namespace. **That predicate is correct and must not
change.** Only the surrounding prose about sensitivity is wrong. The two
concerns — "is this string a Drive scope?" and "is this scope restricted?" —
are different questions that the comment conflates.

## What is NOT wrong

- `GOOGLE_SIGNIN_SCOPES = ["openid", "email", "profile"]` is a sound default.
- Keeping Drive as a **separate opt-in connect** rather than folding it into
  sign-in is a reasonable onboarding decision.
- Accounts that granted Drive earlier keeping their stored refresh token is a
  deliberate, correct migration-friendly behaviour.

**Only the stated justification is wrong. Do not change the scope list or the
opt-in flow on the strength of this handoff.**

## Suggested replacement for site 1 (owner to judge)

```ts
// Sign-in stays on basic scopes (GOOGLE_SIGNIN_SCOPES in
// server/google-auth.ts is the one home for that list). Drive is a
// separate opt-in connect so a user can see and decline it
// deliberately rather than being bundled into first-run sign-in.
//
// Note: drive.appdata is a NON-SENSITIVE scope per Google's scope
// reference, not a restricted one, so it does not by itself trigger the
// unverified-app screen:
// https://developers.google.com/workspace/drive/api/guides/api-specific-auth
// Accounts that granted Drive earlier keep their stored refresh token,
// so workspace Drive backup still works for them.
```

## Suggested verification

1. A test asserting the documented sign-in scope list stays
   `["openid","email","profile"]` and that no Drive scope is present at sign-in.
   `server/google-auth.test.ts` and `server/desktop-auth-route.test.ts` already
   exercise scope separation — extend rather than duplicate.
2. Grep for other places repeating the claim, so the correction is not partial.
   This command was run; at `3067009` it returns exactly two relevant hits plus
   two unrelated ones (`opencode-go.ts` region-restriction error codes, and a
   `tts.test.ts` "RESTRICTED key" fixture):
   ```bash
   git grep -n "RESTRICTED\|restricted scope" -- server/ src/
   ```
   The two to fix are `server/auth.ts:415,417` and `server/google-auth.ts:13`.
3. No behaviour change: the full server suite must be unchanged in count and
   outcome.

### Suggested replacement for site 2

```ts
/**
 * Basic identity scopes for SIGN-IN only. A Drive scope must never appear
 * here: Drive connect is a separate, deliberate consent step so a user can
 * see and decline it, rather than being bundled into first-run sign-in.
 *
 * Scope sensitivity is not uniform across drive.*: drive.appdata,
 * drive.appfolder, drive.install and drive.file are NON-SENSITIVE, while
 * auth/drive, drive.readonly and drive.metadata are restricted. The
 * separate Drive connect consent lives in server/drive-oauth.ts and asks
 * for `openid drive.appdata` on its own.
 * https://developers.google.com/workspace/drive/api/guides/api-specific-auth
 */
```

## Why this matters beyond tidiness

A wrong security-rationale comment is load-bearing for future decisions. An agent
reasoning from "drive.appdata is restricted" could wrongly conclude the storage
choice is forced by Google policy, when in fact it is a product decision — which
is precisely the decision the owner is being asked to make. The comment would
quietly pre-empt it.