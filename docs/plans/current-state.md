# Current Muster state — read before editing

Updated 16 September 2026. This snapshot takes precedence over historical roadmap
status; the latest owner request takes precedence over this file.

**Owner priority:** keep the existing web layout, Flower mascot, /app and /os
shells, choices and sessions stable. Read [the stability contract](../guides/web-app-stability.md).

**Loop98 (16 September), working tree at `1c1eaef` plus this slice:** the
remote-access **client role** now holds pairing links to the strict fragment
rule and stops treating a desktop-companion code as a workspace.
`planWorkspaceConnect()` (`src/lib/pairing-link.ts`) is the single decision point
and `src/components/ConnectedWorkspacesSection.tsx` renders its verdict:
self-hosted pairing links connect and carry the code; a query-string
code is refused whether or not the paste still carries a scheme; a **6-digit
companion code** (and the desktop app's own `muster://pair` deep link) produces an
explicit `role="status"` notice instead of a silent workspace switch; a `/pair`
address with no code yet still connects; and the bare-fragment form `/pair#CODE`
that Muster's own `switchTarget()` emits parses **on a `/pair` path only**, so a
Muster-produced link round-trips while `https://host/#pricing` remains an ordinary
anchor.

**Loop98 correction (same day, 16 September):** the slice's first commit
(`5a6950c`) shipped two real regressions that an independent read-only review
caught before any release — every https URL containing a `#` was routed into the
strict parser, so ordinary anchors became hard errors, and the accepted code
shapes were the competitor's grouped 12-character form, which refused **every code
Muster itself issues** (`server/pairing.ts`, `server/claim.ts` issue 8 characters
of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`). Both are fixed in the follow-up commit, which
also applies the rules to scheme-less pastes, and all four cases are now pinned in
`src/lib/pairing-link.test.ts`. Treat the counts below as re-measured on the
**corrected** tree.

Full **282 files / 4230 passed / 8 skipped / 0 failed** (393.68s, exit 0) on the
corrected tree with the carried-code slice (`9db2794`) and the working-tree
pairing-link/teach-replay revisions — against the newest *recorded* baseline of
281 / 4218 / 8 (the first Loop98 run) that is **+1 file / +12 tests, no decrease,
0 failures**. Focused: `pairing-link.test.ts` 26, `pair-fragment.test.ts` 7,
`workspaces.test.ts` 7, `teach-replay.test.ts` 20 — 4 files / 60 passed. Both
typechecks exit 0, **`npx oxlint .` is 0 warnings / 0 errors** (the 6 anti-slop
type-assertion errors a parallel writer left in `pair-fragment.test.ts` are
cleared), and `npx vite build` ✓ 14.43s.

**Not proven:** no browser/Playwright run for this slice; the browser displays a
followed pairing code (`PairPage.tsx` renders the fragment code, per Loop99) but
still does not *redeem* it, so pairing scopes, keep-awake and a `/pair`
email/domain allowlist stay open. No live remote pairing, no deployment claim,
no security claim.

**Committed after the Loop98 correction (17 September, this loop):** the
working-tree revisions of `src/lib/pairing-link.ts` + test +
`ConnectedWorkspacesSection.tsx` (https-only, scheme-less pastes, code shapes
widened to Muster's own issuers, `/pair`-path-only bare fragments, `muster://pair`
handoff), the `src/state/teach-replay.ts` verdict-contract fix (+2 tests, its
author's slice, now committed separately), and the lint/tidy of
`pair-fragment.test.ts` + `PairPage.tsx`. The inherited `docs/research/glm/*` and
`www/templates.html` remain **uncommitted and byte-preserved** as recorded below.

**Inherited, preserved and deliberately NOT committed** (hashes byte-identical to
`.omb-scratch/verification/loop80-stop-recovery/inherited-preservation.json`):
`docs/research/glm/{01..05,README}.md` and `www/templates.html`
(`aa2ba679…2f09c60`), plus the uncommitted **M** `src/state/teach-replay.ts` +
`.test.ts` from a later session, whose focused suite passes **20/20** but which
belongs to its author's slice. `git add` was scoped rather than `-A` for this
reason. **Treat `docs/research/glm/` as a dated snapshot, not as status** — an
independent audit this loop found several of its claims stale (see the CEO log
Loop98 entry).

**Published source: b3786bb.** Loop80 adds cleanup-only Stop recovery, separate from the
six-second error banner. Receipts bind the original owner/bot/dispatch generation;
retry never interrupts providers. Later starts invalidate old receipts. Normal
layout is unchanged; the notice appears only after an uncertain/failed Stop.
**Loop98 (16 September 2026):** the web **client role** for remote access now
decides what a pasted pairing link means before it connects anywhere.
`src/lib/pairing-link.ts` owns `planWorkspaceConnect()`: a self-hosted
`#code=XXXX-XXXX-XXXX` link connects and carries its code; a bare address (or a
`/pair` page with no code yet) connects without one; and a **6-digit companion
code is reported as a desktop-app handoff instead of silently switching the
workspace**. Query-string codes (`?code=...`) are refused on the link path, and
the bare-fragment form `/pair#CODE` that `switchTarget()` itself emits is now
accepted — it was rejected before, so Muster could not parse a link Muster had
produced. Settings → Connected workspaces is the only UI that changed; the
channel integration added one `role="status"` notice and one clarifying
sentence, with no layout, route, mascot or saved-choice change.

Focused `src/lib/pairing-link.test.ts` + `src/lib/workspaces.test.ts`: **2 files
/ 28 passed / 0 failed**. Full suite **281 files / 4218 passed / 8 skipped /
0 failed** (386.13s, zero FAIL/✗/unhandled lines in the log) against the newest
previously recorded **261 / 3944 / 8 / 0** — an increase, but that delta spans
the intervening commits and inherited uncommitted work, not this slice alone.
`tsc -p tsconfig.json` and `tsc -p tsconfig.server.json` exit 0; `npx oxlint .`
now reports **0 warnings and 0 errors** (the `unicorn/no-useless-spread` warning
recorded below was cleared by `1c1eaef`, so the "exits 0 with one warning" line
is historical); `vite build` succeeds in 14.42s with the same pre-existing
>500 kB chunk notice. Production was read only and unchanged by this slice:
GET `/app` 200 and GET `/api/health` 200.

**Not shipped and not claimed by Loop98:** the browser still does not *consume* a
code it follows — `PairPage.tsx` renders a server-issued cloud code, and **no
`location.hash` read exists anywhere in `src/`** — so the client role validates
and routes a pairing code but does not redeem one. Also absent: pairing scopes
(full vs chat-and-approvals), paired-device list changes, keep-awake changes, a
`/pair` email/domain allowlist, and any browser (Playwright) acceptance for this
slice. See the parity plan's slice-1 status section for the exact boundary.



**Loop90, uncommitted:** a failed Stop is now durable. The receipt is written to the same
SQLite database as the transcript before the 503 is answered, and the next boot settles
it before the handoff drain — only the captured queue IDs are removed, the row is consumed
exactly once, the stopped work is not resumed, and the bot's thread says the Stop outcome
is uncertain. A retry carrying a token the new process never issued still answers 409
`STOP_CLEANUP_STALE`, now with `durableCleanup: {state, failedAt}` and a truthful message
instead of silence. In-memory recovery for the *web client's* own ledger still does not
survive a page reload, so a reloaded user sees the thread note, not the recovery notice:
no UI change was made and none is claimed. Also unproven: no crash-during-write or
power-loss acceptance on a real installation — the restart evidence re-initialises real
module state (fresh `Store`, reopened database handle, reloaded queue file) inside Vitest,
not a spawned server process.

Full **261 files / 3944 passed / 8 skipped / 0 failed** (Loop90, working tree at `4335326`
plus that uncommitted slice, 13 September 2026; exit 0, counts reproduced across three runs,
the last at 395.71s), against a committed baseline of 260 / 3936 / 8 / 0 — **+1 file /
+8 tests, no decrease**. `npx oxlint .` exits 0 with the one
pre-existing `unicorn/no-useless-spread` warning (`server/index.ts:3467`), and
`npx tsc --noEmit -p tsconfig.server.json` exits 0. The spawned-server
`peer-capabilities-harness` (18/18) was re-run and covers the real route. Not re-run in this
pass: the browser 3/3, broker, updater, packaged-server and hash-freeze figures below, which
stay Loop80/Loop89 evidence.

Full **258 files / 3899 passed / 8 skipped / 0 failed**, re-measured at revision
`22a7011` plus the uncommitted build-identity slice (13 September 2026); broker 2/2,
updater 14/14 and packaged server 9/9 under Node, not Electron, were last measured in
Loop80 and were not re-run in this pass. Focused42 server + 30 UI; browser 3/3
covers actual503/retry, same-bot two-tab stale409, sign-out, draft and 320px notice.
All 970 input hashes match. Types/lint/web build pass. Cleanup: 6 servers + 4 providers
exited, 12 ports closed, 3 temporary roots removed. The latest ledger retains initial
failures, test details and limits. Production acceptance is recorded below.

**Latest observed production, Loop80 19:58 UTC:** https://muster.orazen.online/app serves
CSwfumo9/C6Cegjsm, with the new recovery UI; missing scripts/styles return genuine404. Downloads remain
1.12.0/e241968. This slice does not claim a native release, exact backend source
identity, actual Google consent or authenticated production recovery acceptance.

**Deployment wiring:** registered push hook 669688357 returned 404 in Loop79 and
Actions were billing-rejected, yet the prior static repair reached production.
Authenticated Dokploy configuration remains unavailable; the formerly opened
in-app tab is gone. Do not invent URLs, resend triggers repeatedly or equate one
failed path with proof of no rollout. One verified trigger accompanies Loop80.

**Preserved local work:** five iOS/Watch source/test files, six docs/research/glm
files and www/templates.html stay outside this slice. Check the 12 exact hashes
and stash ownership in `.omb-scratch/verification/loop81-identity-handoff/`
`inherited-preservation.json` / `inherited-restoration.json`; Loop80 is the original
hash baseline. All12 must be restored before stopping. Restore exactly;
never sweep them into cleanup commits. Retain the original preexisting stash.

**Next:** verified deployment wiring when Dokploy access is available. The
[exact web/server build identity](web-release-identity-next-slice.md) slice is
implemented and locally tested (observer plus producer contracts, 27 tests), but it
is not deployed and its production identity is unverified. The
[portable backup v2 prototype](audit-2026-09-13-backup-v2-and-release-identity.md)
also landed as an inert module with its own tests: passphrase-only export, a dry-run
plan and a staged, all-or-nothing restore whose rollback is asserted byte-for-byte.
That is a module with tests, not a shipped feature — **no route wiring, no UI and no
production acceptance** — and no security claim. Finish the remaining peer/crash acceptance in
the [peer plan](peer-capability-next-slice-2026-09-12.md),
durable Stop recovery across reload, native signing/runtime, actual Google consent,
full sync/backup, VM and Mimosa. Two Android Metro/image-size high alerts remain
open: no published version is unaffected, and **no local dependency wiring closes
them** — the `file:` override dangles under `node_modules/metro/` on npm 10.9.8, and
`npm audit` still reports the advisories (`range: "*"`) even though the workspace
link makes Metro load the local copy. The replacement parser with no ICNS/JXL/HEIF
parser is **now wired in** at `android-companion/vendor/image-size/` (npm workspace
link; lockfile `12 insertions(+), 22 deletions(-)`; `npm ci` verified), so the
vulnerable implementations and `queue` are out of the tree — but whether Dependabot
closes the alerts on a `"link": true` entry has **not been observed from this
machine** and must be checked after the next scan. If they stay open: dismiss with a
documented reason, or take Metro ≥ 0.87.1 via the Expo/RN upgrade. Keep existing
mitigations and automation PAUSED.

**Handoff:** update this snapshot, the [ledger](glm-handoff-2026-09-10.md) and
[CEO log](ceo-log.md) with real counts, deployed evidence and remaining scope.
Never relabel fixture tests as native/production acceptance or resume broad
redesigns. Read live account usage before applying the owner's 2% handoff threshold.

**Loop81 handoff:** the parallel read-only packaging/runtime audit expanded the
[next slice](web-release-identity-next-slice.md) into concrete integration points
and real-fixture acceptance; Loop81 shipped none of it. That slice is now
implemented in the working tree, uncommitted on the revision stamped above.
All970 tested source input hashes still match Loop80; this documentation-only
continuation ran0 new runtime tests. Current layout and user services were not
changed.

**Allowance snapshot:** final live check reached **2% remaining**, the owner’s handoff reserve; reset19 September2026 at16:43 Europe/Rome. No reset consumed. The handoff is ready; no further implementation was started after this threshold. The wider goal remains open for the next agent.

**Final publication check, 19:58 UTC:** product b3786bb is pushed. Production
GET10/10 availability/auth-boundary checks pass. Served JavaScript changed to
index-CSwfumo9.js and contains the new recovery UI; CSS remains C6Cegjsm. Earlier
probes saw the old bundle. Exact backend/source identity and authenticated
production recovery remain unverified; native metadata remains1.12.0/e241968.
CI34715571217/autodeploy34715571179:4billing failures,1skip,0steps; registeredhook404.
Another path nevertheless delivered frontend code. No hosted settings or sessions
changed. Full254/3862/8 and browser 3/3 acceptance remain local fixture evidence.


**Loop86 (13 September):** installation Drive success timestamps and duplicate Telegram stamp corrected. Its full-suite run was256 files/3872 passed/8 skipped, superseded by the **258 files / 3899 passed / 8 skipped** baseline stamped above at revision `22a7011` plus the uncommitted build-identity slice; final affected suites2 files/141 passed and server typecheck pass. See the latest ledger entry for review timing and limits. muster.today sign-in rendered; GET availability3/3. Backend rollout, native release and actual Google consent remain unverified. Existing layout and paused automation preserved.

## Structure note — server route-table pattern (17 September, branch refactor/server-route-table)

The workspace/v2 + account-Drive backup family no longer lives inline in server/index.ts. It is extracted to server/workspace-backup-routes.ts behind an ordered route table: each entry has a match(method, path, ctx) predicate and a handle(req, res, ctx) handler; handlers receive a BackupRequestContext (requestUserId, live config, appVersion, dataDir) and index.ts owns session resolution and per-request state. Shared HTTP plumbing (json, isText, readBody) moved to server/http-helpers.ts — route modules import the one definition.

The registration point is order-sensitive and documented in the module header: inside the session gate, above the multi-tenant guard, with capability advertisement ahead of the hosted installation wall inside the table. First match wins; the handler returns false when the family does not claim the request, and index.ts proceeds unchanged.

Extracting the next family is mechanical: write the module with its own ordered table, register it at its exact current position with the same one-call pattern, run the gate. Committed as b61c771 on refactor/server-route-table; main untouched so the delivery pass can open the PR.
