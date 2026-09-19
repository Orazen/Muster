# Personal-assistant beta — owner decisions, 19 September 2026

Owner answers from the Astra strategy interview. This record supersedes
conflicting September 18 strategy and historical monetization/social plans.
These are requirements, not implementation or release receipts.

## Accepted direction

| Area | Owner decision |
|---|---|
| Audience | Everyone equally; a personal assistant organizing everyday work. |
| Platforms | Web, Mac, Windows, Linux, iPhone, Android, Apple Watch together in a small beta. Owner selected all six device platforms for testing; actual hardware/version coverage must still be recorded. |
| Launch demonstration | Calling the bot from Watch. Planning, delegation and conversation are intended; perfect daily planning first. |
| First result | Calendar overview, three priorities, suggested time blocks. Calendar writes are not implied. |
| Current problems | All matter: login/onboarding, design/usability, task completion, sync/backup, updates reaching live and installed apps. Preserve stable layout and mascot while fixing reproduced problems. |
| Memory | Explicit preferences, suggested memories, and learning from connected apps, with adjustable permissions. |
| Autonomy | User-selectable; default to drafts/plans and approval before action. App connection is not blanket action consent. |
| Execution | Use a capable paired device; otherwise visibly queue. Do not assume phones or Watches can execute arbitrary desktop work. |
| Storage | Google Drive first; Telegram storage after reliable recovery is verified. Telegram messaging is a separate connection category. |
| Recovery | User-held recovery key. Explain that losing every device and the key makes encrypted data unrecoverable; verify implementation before promising this property. |
| Connections | Offer Calendar, Email, Files, Telegram, Browser, Tasks/Notes; each productivity connection optional. This does not silently remove the separately recorded storage gate. |
| AI access | BYOK plus a small capped included allowance per user. |
| Exhaustion | Default: pause new AI work, preserve data, guide to BYOK. Also offer automatic BYOK fallback only after explicit opt-in. |
| Revenue | Free during beta; decide revenue after real usage. Supersedes BYOK-only/no-pooled-inference and permanent monetization statements. |
| Budget | EUR 50–200/month planning envelope for hosting and included AI; not spending authorization. |
| Sharing | Optional user-reviewed result cards plus reusable bot/team templates without personal data. Explicit consent before publishing. Private fleet connections remain default; no public feed requested. |
| Testers | Owner expects to recruit 5–10 people. |
| Public launch gate | Every core flow passes AND at least five testers complete daily planning on three separate days each. |

## Acceptance and remaining decisions

The launch gate requires at least 15 person-day completions, not 15 automated
tests or repeated sessions on one day. Record build/version, device/OS, scenario,
outcome and evidence for sign-in/onboarding, connection permissions, planning,
Watch calling, approvals, offline routing/queue recovery, allowance exhaustion,
Drive restore/sync, and live/installed update delivery. Platform capability
differences must be explicit. Automated tests do not replace tester evidence.

Per-user allowance amount, reset period, supported included models, global cap,
accounting/reservation and abuse controls need a costed proposal. No numerical
quota or spending was authorized by this interview. Recovery key custody,
personal-storage gate, and relay persistence require verified implementation;
the direction does not establish that they already work.

## Recommended build sequence

1. Map existing implementation and evidence to the platform/flow acceptance matrix.
2. Close reproduced auth/onboarding and release-delivery defects.
3. Verify calendar-backed Plan my day, then Watch calling and routing/approvals.
4. Prove Drive recovery and multi-device consistency before full-sync claims.
5. Cost and implement included usage caps and explicit fallback preferences.
6. Run the beta and collect the five-person, three-day launch evidence.

## Evidence boundary

Documentation-only interview record: no product changes, tests, deployment,
spending, invitations or publication performed here. Latest observed preceding
CEO-log receipt: 296 test files / 4,341 passed / 8 skipped / 0 failed; browser
26/26. Not rerun for this document; not evidence that the beta gate has passed.
No virality, security, AGI or ASI capability is claimed.

## Loop128 handoff reconciliation (19 September)

Read-only checks confirmed local HEAD `3bd732e` and the Loop128 record. Remote
main is now `6cd280e`, one additional autodeploy-trigger commit changing only
`.deploy-trigger`; the handoff commit is present upstream. The strategy files
from this interview are still local/uncommitted, alongside preserved unrelated
untracked snapshots. No claim that all current work is pushed.

Source confirms `PairPage.tsx` displays carried codes without redeeming them,
and `bench:roles` runs the existing role-eval harness. No scheduled benchmark
workflow was found in the current workflow files. Other backlog items remain
inherited findings until their specific source/acceptance audit.

A production GET to `/api/build-identity` returned version 1.12.3 for backend
and web, backend startup 2026-09-18T14:08:17.447Z, null source revisions and
`attestation:false`. It does not establish deployment of Loop128. Backend
buildId: 7632065f-88c9-4614-8faa-42adb590f61b; web buildId:
453b2f23-e6ce-4963-ad5b-c5d09ac598a6. No production mutation performed.

Re-rank the inherited backlog around the accepted beta: first auth/pairing and
release visibility; calendar daily planning + Watch calling; Drive recovery and
multi-device behavior; allowance controls; tester acceptance. Benchmark trending
supports reliability but does not outrank a broken first-use journey. Memory
history/rollback remains a prerequisite for automated memory changes. Skills
creation is later work. Public-social S5–S10 and broad GAIA redesign are not
blanket-authorized by this interview and must not override private sharing or
surface stability.

Owner gates need fresh evidence before being called permanent blockers:
Droid subscription blocks that provider, not all engines; a scanner re-run is an
execution/access gate, not itself proof of security. Google installed-app consent,
native release signing, CI billing, mirror promotion and hardware acceptance
remain open according to the supplied handoff. Prepare reproducible artifacts
and checks for each; do not spend, deploy or change accounts based on this record.

Validation for this reconciliation: source/git inspection and one production
GET; **0 test suites rerun**. The Loop128 4341/8 and browser 26/26 counts remain
inherited evidence.

### First execution audit correction

The initial inherited pairing backlog conflated code namespaces. Source review
confirmed ClaimPage/ClaimFlow already redeems `/claim#CODE` into an owner session;
`/pair#CODE` carries a separate pairing code. The existing claim route must not
be used as a generic pairing-code redemption endpoint. First active slice: add
owned browser acceptance for claim success, single-use replay, malformed links,
and rejection of cloud pairing codes without consuming their actual namespace.
