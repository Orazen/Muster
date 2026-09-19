# Drive consent isolation — Loop144

## Reproduced defect

The previous account Drive callback parsed access/refresh/expiry only, then
updated the existing Google sign-in row. An isolated SQLite reproduction
returned `loginAccessPreserved:false` and `oldRefreshMixedWithNewAccess:true`:
a new synthetic access token was paired with the previous login refresh token
and unchanged Google subject. A basic login refresh token also counted as a
Drive connection; timestamp-only signed state was reusable during its lifetime.

## Change

Separate Drive grants store verified Google subject, exact appdata scope,
offline tokens and consent generation. Nothing copies or modifies login or
Calendar credentials. Existing legacy credentials require explicit Drive
reconnection because their identity/scope cannot be inferred safely. Sign-in
sessions and workspace contents remain untouched.

Consent uses opaque single-use state bound to user and session, S256 PKCE and
nonce. Exchange verifies a signed Google ID token with issuer/audience/expiry/
nonce checks and exact granted Drive scope. A linked Google login must match
the verified subject; email-only users can establish an independent Drive grant.
The login row, session and generation are rechecked before persistence. Refresh
and transport retain per-caller session/grant checks, including between listing
and uploading. Redirects cannot forward Drive request credentials elsewhere.

Google's documented subject, nonce and PKCE semantics informed this change:
https://developers.google.com/identity/openid-connect/reference

Hosted setup copy now states the actual boundary: connecting Drive does not
start automatic backup or cross-device sync, and web workspace data still lives
on the server. The existing layout remains. Local portable backup/restore is
still available; hosted account-scoped backup remains unimplemented.

## Verification

Pre-fix synthetic SQLite reproduction above. New store/access21/21 and OAuth
50/50 focused tests passed; account adapter9/9. Signed RS256 fake-provider
roundtrip13/13 and hosted storage-gate2/2 passed. No live Google account used.
A held restore after sign-out preserves distinct staged sentinel bytes; late
consent after revocation is rejected. Fixture outbound networking is blocked.

Initial consumer run failed four assertions: two assumed login tokens implied
Drive access; the old storage test expected a Drive-only scope and cascaded
without a created bot. Updated acceptance seeds explicit grants or performs
real local consent. The OAuth fixture initially omitted Bearer token_type on
refresh; its corrected explicit-consent mode passed. These failures are retained,
not counted as passing evidence. Final transport+adapter+roundtrip97/97 and
transport+workspace-auth212/212 passed. Full/browser gates pending below.

## Remaining work

The audit also reproduced stale-device backup overwrite: v2 transport updates
one named remote file without revision checks. Preserve immutable recovery
snapshots and let users select a restore next; this consent fix does not repair
that loss scenario or establish cross-device sync. User-visible Drive disconnect
and account-managed recovery remain follow-up work. Real Google consent,
physical devices, production rollout and beta tester evidence are unverified.
No whole-codebase security claim; release work belongs to the other agent and
automation remains paused.

Independent final code review found no blocking consent issue. Final lint initially
rejected module mocking in the adapter test and raw header type narrowing. The
test now uses an explicit provider interface; the header is parsed at the input
boundary. Focused adapter9/9 and full lint then passed. Build includes both
project and server TypeScript checks; final transport changes also passed the
server check. Native sources are unchanged; no new native-device acceptance
is claimed for this server/consent slice.

GitHub read-only audit during this slice: Dependabot0 open and secret-scanning0
open. CI for7a9ea2d remained in progress when checked. Its autodeploy35469518670
failed at Bump .deploy-trigger; newer842861c autodeploy35469696149 succeeded.
These are trigger receipts, not deployment evidence. The independent release
agent's policy/trigger changes are preserved and excluded from this slice.

Browser terminal:40 passed/1 failed,6.0m. New consent test timed out because
the screenshot helper looked for Backup while the actual storage dialog was
visible. Helper corrected to accept that dialog; focused1/1 passed6.2s with
320/1440 screenshots and owned process/ports/data cleanup verified. First full
unit run remains non-green due the old shared fixture loaded before repair;
repaired five consumers68/68 passed. Owner requested handoff mid-verification;
see docs/plans/astra-handoff-2026-09-19.md for live handle and next exact steps.

Visual review of the passing320px artifact found underlying app text showing
through the consent modal and colliding with its copy. Geometry passed but
readability is not accepted. Fix the modal surface opacity/theme token without
redesign, rebuild and inspect both widths before committing. Exact screenshot
and next step are in the handoff's final visual finding.

### Final visual/browser correction

The modal used undefined bg-surface/glass-shell classes. Existing opaque bg-card
and text-ink tokens now preserve the same layout without underlying text bleed.
Fresh browser **41/41 passed**,4.4m, zero failures. Both320px and1440px images
were visually inspected; the test asserts an opaque computed surface and
visible/uncovered controls within viewport bounds. Owned fixtures cleaned up.
Durable images: [mobile](assets/drive-consent-2026-09-19/320.png),
[desktop](assets/drive-consent-2026-09-19/1440.png).
Final build15.00s, project/server/e2e types and full lint passed.

### Final gate

Full final unit **321 files /4821 passed /8 skipped /0 failed**,508.86s;
+4files/+87passing versus Loop143. Log `/tmp/muster-loop144-full-final.log`.
First run was5failedfiles/316passed,12failedtests/4761passed/56skipped,439.41s;
it is superseded by the repaired shared-fixture final run, not hidden. Browser
41/41 and packaged-server14/14 passed. No root verification process remains
running. No source edits followed these final gates; documentation/images only.


### Owner stop / superseding Loop144 handoff — 19 September 2026

Goal PAUSED at owner's request. Loop144 remains UNCOMMITTED; no product push or
deployment is claimed. Latest HEAD `e5b62dd` includes another agent's plugin-react
5.2.0 and Vaultgram lockfile changes. The 321-file/4821-pass/8-skip unit gate,
41/41 browser and14/14 packaged results above predate this dependency merge.
Merged full unit session44632 and lint90558 have no collected terminal result;
build16180 log reports14.12s but exit is not collected. Frozen install passed.
Full details, exact logs, ownership and remaining beta work are in
`docs/plans/astra-handoff-2026-09-19.md`, whose opening STOP section supersedes
older ready-to-commit statements. No new tests or product edits after the stop.

Successor FIRST priority: coordinate with release agent and diagnose GitHub
Autodeploy35469518670 failure at “Bump .deploy-trigger”, inspect newer CI and
merged-dependency checks, fix forward without bypassing gates. Other observed
CI runs succeeded; do not claim every build failed. Release workflows remain
the other agent's responsibility. Automation stays paused; production receipt,
real Google/hardware, hosted recovery/sync and15 tester-days remain outstanding.
