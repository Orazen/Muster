# Muster — corrected agent handoff

Prepared 19 September 2026 after the owner's strategy interview and review of
the pasted handoff. This replaces that attachment's unsupported cleanup advice.
It is a working-tree handoff, not a deployment or test receipt.

## Start here

1. Read `AGENTS.md`, `docs/AGENT-ORIENTATION.md`, and
   `docs/guides/web-app-stability.md`.
2. Read [the owner's latest decisions](personal-assistant-beta-decisions-2026-09-19.md).
   These supersede conflicting historical strategy, including BYOK-only access,
   permanent pricing commitments, and public-social roadmap items.
3. Read `current-state.md` and the latest entries of `ceo-log.md`. Current-state
   still contains older implementation snapshots; Loop128 has newer test counts.
4. Inspect status, branch and remote before editing. Preserve unrelated work.

## Verified checkout and ownership

- Checkout: `/Users/ramagiritharun/muster-audit`; branch **main**; local HEAD
  **3bd732e** at preparation. Earlier remote inspection found **6cd280e**, one
  additional autodeploy-trigger commit touching only `.deploy-trigger`.
- The local modifications to `ceo-log.md`, `current-state.md`, and
  `cloud-relay-strategy-2026-09-18.md` are Astra's strategy-interview additions.
  `personal-assistant-beta-decisions-2026-09-19.md` and this handoff are new
  local documents. They are not yet committed or pushed.
- Preserve unrelated `.freebuff/`, `.zcode/`, `marketing-video/`,
  `docs/research/glm/` snapshots and `www/templates.html`. Do not infer that
  untracked means disposable or ready to commit. The orientation explicitly
  says to preserve these snapshots uncommitted.
- The Watch union commit `2ea4082` changes native files and the CEO log, not
  `www/templates.html`. There is no verified connection between that conflict
  resolution and the template snapshot.
- The loop ledger is **docs/plans/ceo-log.md**; there is no `docs/log` directory.
- Follow the stability contract: preserve layout, mascot, choices and sessions;
  reproduce before fixing. Never restart existing services or touch demo 8845.
  Keep automation paused. Production audit requests remain GET-only.
- Staging guidance conflicts between AGENTS and orientation. Regardless of the
  staging mechanism, never include inherited snapshots in a strategy commit;
  inspect the entire staged diff and resolve that boundary before committing.

## What the previous agent completed

Loop126: onboarding chat reads its completion flag and waits for connection;
the browser fixture waits for asynchronously mounted first-run surfaces.
Loop127: seed bots select a signed-in engine, leaked AGENT copy is corrected,
Watch composer integration/conflicts are resolved, and test isolation is fixed.
Loop128: conservative provider-error parsing shows readable error sentences
while retaining raw bytes for copying; the provider's actual failure is preserved.

Recorded evidence, **not rerun during this handoff review**:

| Surface | Receipt and scope |
|---|---|
| Unit suite | Loop128: 296 files / 4,341 passed / 8 skipped / 0 failed |
| Browser | Loop128: 26/26 on a fresh build |
| Types/lint | Loop128: both typechecks exit 0; oxlint 0 warnings / 0 errors |
| Electron | Loop128 syntax checks pass; not installed-app Google acceptance |
| Swift | Loop127: 356/356; native app/Watch builds recorded. Widget build is reported in the supplied handoff and earlier native loops; do not describe it as freshly rebuilt here. |

The supplied preview addresses are UI 127.0.0.1:5199 and API 8802. They were
not re-probed during this document review. Identify current process ownership
before using them; do not reuse or restart a service based only on this text.

Production GET `/api/build-identity` during the preceding review reported
backend/web version 1.12.3, null source revisions and `attestation:false`.
Backend startup was 2026-09-18T14:08:17.447Z. This does not establish rollout of
Loop128. Pushes and deployment-trigger commits are not deployment receipts.

## Owner interview outcome

Build a personal assistant for everyone, organizing everyday work across web,
Mac, Windows, Linux, iPhone, Android and Watch. Start with 5–10 testers across
those platforms. The demonstration is a Watch call; perfect **Plan my day**:
calendar overview, three priorities and suggested time blocks.

Users choose memory permissions and autonomy. Default to plans/drafts and
approval before actions. Route work to a capable paired device; otherwise queue
visibly. Google Drive is the first storage destination, Telegram storage later
after recovery verification. Explain user-held key loss honestly.

Offer all six optional productivity categories: calendar, email, files,
Telegram, browser, tasks/notes. BYOK plus capped included AI; on exhaustion pause
by default, with automatic BYOK fallback only after opt-in. Keep the beta free;
revenue comes up after real usage. EUR 50–200/month is a planning envelope, not
permission to spend. Allowance amounts/reset/accounting still need costing.

Sharing: optional reviewed result cards and templates without personal data;
no implied public agent feed. Wider launch requires every core flow passing
and **at least five testers completing daily planning on three separate days
each**. Automated tests do not replace those 15 person-day completions.

## Next work, in beta order

1. Build an evidence matrix for auth/onboarding, connection permissions, daily
   planning, Watch calling, approvals, offline routing, allowance exhaustion,
   Drive restore/sync and update delivery on the supported platforms. Mark
   source-tested, fixture-tested, device-tested and deployed separately.
2. Fix reproduced first-use and release-delivery failures. **Pairing audit correction:** `/claim#CODE` already redeems owner claim
   codes via ClaimPage/ClaimFlow. `/pair#CODE` carries a distinct pairing code;
   do not wire it to `/api/pair/claim`. Browser acceptance of the existing claim
   flow is the first slice; code shape alone cannot identify its issuer.
3. Verify calendar-backed Plan my day and Watch calling end to end, with
   honest missing-connection/offline states and approval behavior.
4. Verify portable Drive recovery and multi-device consistency, including
   interruption/conflict behavior; an upload is not proof of full sync.
5. Cost and implement allowance limits, global budget protection and opt-in
   BYOK fallback, then gather real beta acceptance evidence.

Supporting work remains: benchmark baseline/trend storage and CI wiring
(`bench:roles` exists; no scheduled benchmark workflow found); memory history
and rollback UI before automated memory changes; skills creation; engine
add-account; channels; tour acceptance. Most of these remain inherited backlog
claims requiring a source check before implementation. Broad GAIA redesign and
public-social S5–S10 do not override the new beta or stability contract.
Do not activate a schedule while the automation-pause instruction stands.

## External acceptance and release prerequisites

The supplied handoff lists CI billing, VPS access/mirror promotion, Apple
signing and review, real installed-app Google consent, hardware voice tests,
and the full security scanner re-run. Check actual availability before calling
any gate permanently blocked. Prepare concrete artifacts and instructions for
the owner; never request secrets in chat. A Droid subscription failure blocks
that provider, not every supported engine. A completed scanner alone does not
establish comprehensive security. Do not promise security, virality or AGI/ASI.

## Validation of this document

Read-only git/source/log checks and the earlier production GET support the
corrections above. No product code changed; **0 test suites rerun**. This file
does not claim the beta gate passed or that any new release was published.

## Loop129 verification update

The first beta execution slice subsequently ran the full gate: unit 296 files /
4341 passed / 8 skipped; browser 29/29 (three new claim cases); focused unit
66/66; server/project/e2e types, lint and fresh build pass. See CEO log Loop129
and the acceptance matrix. Earlier not-rerun statements describe the document
review phase. These documents are included in the verified slice commit; the
working-tree-only status above is historical at preparation, not a perpetual
constraint. No native or real-Google acceptance was added.
