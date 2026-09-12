# Current Muster state — read before editing

Updated 12 September 2026. This snapshot takes precedence over historical roadmap
status; the latest owner request takes precedence over this file.

**Owner priority:** keep the existing web layout, Flower mascot, /app and /os
shells, choices and sessions stable. Read [the stability contract](../guides/web-app-stability.md).

**Published source: b3786bb.** Loop80 adds cleanup-only Stop recovery, separate from the
six-second error banner. Receipts bind the original owner/bot/dispatch generation;
retry never interrupts providers. Later starts invalidate old receipts. Normal
layout is unchanged; the notice appears only after an uncertain/failed Stop.
In-memory recovery does not survive reload/restart; durable failure/restart
recovery remains open.

Full **254 files / 3862 passed / 8 skipped / 0 failed**; broker 2/2, updater 14/14,
packaged server 9/9 under Node, not Electron. Focused42 server + 30 UI; browser 3/3
covers actual503/retry, same-bot two-tab stale409, sign-out, draft and 320px notice.
All 970 input hashes match. Types/lint/web build pass. Cleanup: 6 servers + 4 providers
exited, 12 ports closed, 3 temporary roots removed. The latest ledger retains initial
failures, test details and limits. Production acceptance is recorded below.

**Production baseline:** https://muster.orazen.online/app serves
DCAkTz04/C6Cegjsm; missing scripts/styles return genuine404. Downloads remain
1.12.0/e241968. This slice does not claim a native release, exact backend source
identity, actual Google consent or authenticated production recovery acceptance.

**Deployment wiring:** registered push hook 669688357 returned 404 in Loop79 and
Actions were billing-rejected, yet the prior static repair reached production.
Authenticated Dokploy configuration remains unavailable; the formerly opened
in-app tab is gone. Do not invent URLs, resend triggers repeatedly or equate one
failed path with proof of no rollout. One verified trigger accompanies Loop80.

**Preserved local work:** five iOS/Watch source/test files, six docs/research/glm
files and www/templates.html stay outside this slice. Check the 12 exact hashes
and stash ownership in `.omb-scratch/verification/loop80-stop-recovery/`
`inherited-preservation.json` / `inherited-restoration.json`. Restore exactly;
never sweep them into cleanup commits. Retain the original preexisting stash.

**Next:** [exact web/server build identity](web-release-identity-next-slice.md), then verified deployment wiring when
Dokploy access is available. Finish the remaining peer/crash acceptance in the
[peer plan](peer-capability-next-slice-2026-09-12.md), durable Stop recovery across
reload, native signing/runtime, actual Google consent, full sync/backup, VM and
Mimosa. Two Android Metro/image-size high alerts remain open; the read-only audit
found no fixed published upgrade. Keep existing mitigations and automation PAUSED.

**Handoff:** update this snapshot, the [ledger](glm-handoff-2026-09-10.md) and
[CEO log](ceo-log.md) with real counts, deployed evidence and remaining scope.
Never relabel fixture tests as native/production acceptance or resume broad
redesigns. Read live account usage before applying the owner's 2% handoff threshold.

**Allowance snapshot:** 4% remaining at the Loop80 acceptance check; reset19 September2026 at16:43 Europe/Rome. No reset consumed. Re-read usage before the owner’s2%handoff threshold.

**Final publication check, 19:58 UTC:** product b3786bb is pushed. Production
GET10/10 availability/auth-boundary checks pass. Served JavaScript changed to
index-CSwfumo9.js and contains the new recovery UI; CSS remains C6Cegjsm. Earlier
probes saw the old bundle. Exact backend/source identity and authenticated
production recovery remain unverified; native metadata remains1.12.0/e241968.
CI34715571217/autodeploy34715571179:4billing failures,1skip,0steps; registeredhook404.
Another path nevertheless delivered frontend code. No hosted settings or sessions
changed. Full254/3862/8 and browser 3/3 acceptance remain local fixture evidence.
