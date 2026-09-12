# Current Muster state — read before editing

Updated 12 September 2026. This short snapshot takes precedence over historical
roadmap status; the latest owner request always takes precedence over this file.

**Owner priority:** preserve the working web app. Repair reproduced defects and
keep the existing layout, Flower mascot, /app and /os shells, saved choices and
sessions intact. Read [the stability contract](../guides/web-app-stability.md).

**Locally verified slice:** Loop79 stabilizes Vite backend selection, ports and
scratch watching, and fixes missing JS/CSS responses. Full suite **250 files /
3808 passed / 8 skipped / 0 failed**; broker2/2, updater14/14, packaged server9/9.
Focused66/66, minimal browser2/2, actual Muster onboarding7/7. Types/lint/web build
pass;962 source inputs match. Publication and live GET acceptance are still to be
recorded below; local success is not deployment evidence.

**Production:** canonical workspace is https://muster.orazen.online/app. Last
baseline GET still served index-DCAkTz04.js and returned HTML200 for missing assets.
One repository deployment trigger is included in the verified candidate. GitHub
Actions billing remains blocked; a successful push alone is not a rollout receipt.
Desktop download metadata remains 1.12.0/e241968. No new native release is claimed.

**Preserved local work:** five iOS/Watch source/test files, six docs/research/glm
files, and www/templates.html remain outside this slice. All 12 exact hashes and
stash ownership are recorded in `.omb-scratch/verification/loop79-web-stability/`
under `inherited-preservation.json` / `inherited-restoration.json`. Check actual
status and the receipt before touching them; never sweep them into a cleanup
commit. Retain the original preexisting stash.

**Next work:** first verify the live rollout. Then implement the original-generation
Stop cleanup retry described in the [peer capability plan](peer-capability-next-slice-2026-09-12.md).
Do not replay generic interrupt for an old failure: it can stop newer work.
Deployment hardening debt is listed in the stability guide. Native signing/runtime,
real Google consent, complete portable sync, VM execution, Mimosa and two high
dependency alerts remain open. Existing automation stays PAUSED.

**Handoff rule:** update this snapshot, the [ledger](glm-handoff-2026-09-10.md) and
[CEO log](ceo-log.md) with real test counts, observed deployment evidence and next
scope. Report failures and limitations. Do not resume broad redesigns or relabel
local fixture acceptance as production/native acceptance. Latest account allowance
was 11% remaining; read current usage rather than treating that snapshot as live.
