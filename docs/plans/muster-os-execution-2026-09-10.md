# Muster OS: research, product direction and release gates

Owner: GPT-6 Astra. Board: the owner. Research date: 2026-09-10.
Status: execution plan; individual slices require their own verification in
`ceo-log.md`. The standing CEO mandate and existing win plan remain in force.
This document extends `glm-handoff-2026-09-10.md`; it does not replace its
completed work or erase unresolved release evidence.

## Decision

Build a workspace that helps a person manage a persistent AI team through
decisions and observable results. The main surface should answer three
questions: what needs my judgment, what work is happening, and what arrived
for me to inspect? A worker's mascot, conversation, execution computer,
approvals and receipts belong to the same identifiable worker.

“OS” is the interface and coordination layer, not a claim of general
intelligence or a replacement kernel. Model choice alone cannot establish
AGI. Success means demonstrably useful tasks, recoverable mistakes,
understandable setup and repeat use. No current evidence establishes
competitor superiority, broad security, revenue lift or viral growth.

## What the references establish

| Reference | Observed or documented | Useful implication | Evidence limit |
| --- | --- | --- | --- |
| Today login | Sparse centered form, Google/Microsoft/email options, quiet gradient, one entry task | Keep account entry focused and preserve the user's intended task | Public browser inspection; no Today account created or authenticated |
| Today product | Contextual start, scheduled briefings, project cards and editable memory categories; its article promises confirmation before external actions | Start with useful context and expose memory as editable information | Landing examples and vendor statements, not executed workflows |
| Warmwind landing/login | Worker/computer imagery, clear job-oriented introduction, compact navigation; email/password and Google entry | Make the worker's execution environment visible without forcing infrastructure choices before a first task | Public browser inspection only |
| Warmwind rollout | August 26, 2026 announcement describes cloud workers, visual software use, schedules and parallel jobs | Explain persistent execution separately from the client interface | Vendor claim; older closed-beta positioning is superseded |
| Warmwind technical article | July 2025 description of Linux execution with a streamed browser interface | Label actual execution, live view and page preview distinctly | Dated description; no current authenticated/runtime verification |

Sources: Today login and product [1–3]; Warmwind current landing, rollout
and technical explanation [4–6]. Warmwind's homepage had no extractable
body in the web tool; its visual design and public login were inspected
with CUA. Guessed documentation paths and an advertised SDK repository
were unavailable; they are not evidence of implementation. Today's article
and download page differ in mobile distribution language, so neither is
proof of an installed mobile app test. [7]

The distinction cannot be “we have approvals”: Today explicitly describes
them too. The proposed distinction is the quality of the path from task
intent through proposed action, rehearsal, human decision and retained
result, across multiple persistent workers. This is a hypothesis to test,
not a comparative result.

## Source audit: current gaps that affect trust

1. **Hosted backup crossed the account boundary.** `workspace-bundle.ts`
   exported all visible bots, groups and shared memory. An account-specific
   Google token scoped the destination, not the exported records. Restore
   and Telegram configuration were also installation-wide. Loop 22 blocks
   the entire hosted route family before body parsing; local same-install
   backup remains available. Full tests: 200 files / 2121 passed / 8 skipped.
2. **The old backup was not portable.** Key derivation includes the
   deployment secret as well as the passphrase. Fresh-install recovery
   cannot depend on the old machine surviving. Threads/messages are absent
   from the v1 bundle; raw bot metadata is not a complete history backup.
3. **Restoring a portable format needs a new boundary.** Validate all
   records and references before writing; reject traversal and arbitrary
   file names; map IDs and owner identity to the destination. Never import
   source ownership, running processes, provider grants or runtime paths
   as trusted destination state. Do not simply remove the secret from v1
   encryption and reuse its permissive restore function.
4. **Google identity is not a storage connection.** Desktop pairing
   transfers identity, not the web account's Google tokens. A successful
   sign-in is not proof of Drive scope, offline consent or a usable refresh
   token. Current Drive listing also collapses failures into empty results.
5. **OS work navigation was misleading.** AgentWindow's Open chat ignored
   its bot. AccountStore remounts between `/os` and `/app`; dispatching
   selection immediately before navigation can be lost. A validated route
   target must wait for actual roster hydration. SSE open alone is not that
   proof. Repeated show intents must focus a window instead of minimizing
   or duplicating it.
6. **Work state needs precise labels.** Busy can coexist with a pending
   question. A seed greeting is not completed user work. Unread text is a
   new reply, not evidence of successful execution. A disconnected client
   must not animate stale state as live work. Profile-selected expressions
   cannot override operational truth.
7. **Companion continuity needs native verification.** iOS/Watch have
   pairing and replay paths, but were not executed on a device in this
   audit. Android's initial pairing/reconnect path needs fleet hydration;
   stream connection is currently optimistic. Native brand catalog exports
   do not prove application behavior.
8. **Onboarding still has a durable acceptance gap.** Loop 21 preserves
   drafts and acknowledged requests within a mounted wizard. Lost responses,
   reloads and concurrent thread changes require a server-owned idempotency
   receipt and atomic expected-thread check. Skip must not send a filled
   draft. These remain separate acceptance gates.

## Interface contract

The first OS slice keeps the existing dock, Rooms and agent windows. Home
contains three sections: Needs your decision, In progress, Ready to read.
Only actual account-visible active-branch work qualifies. Empty sections
explain what appears there; they do not fabricate examples. Teammates remain
available below the work overview, including idle or disconnected workers.

Home waits for roster hydration. It explicitly distinguishes connection
loss from an empty roster. Summary clicks hand off to the exact existing
conversation and its existing approval controls. No summary-card action
grants permission, sends a task, or declares an outcome automatically.
Returning to the app uses a direct route, not browser history.

The orange canonical mascot remains the identity throughout the workspace.
Expressions carry a text equivalent: curious for a pending decision,
working for an observed active turn, notifying for a new settled reply,
neutral when idle or disconnected. A wave is a cosmetic response to a user
gesture. Reduced-motion preferences remove ambient motion; an animation
never substitutes for an execution receipt.

Desktop can keep multiple contained windows. Phones use one visible window
at a time, a single vertical overview scroll surface and reachable window
controls. Test at 320, 390, 768 and 1440 pixels, with long names, populated
requests, empty state, connection loss, all windows minimized and keyboard
navigation. Platform-specific capabilities must be labeled rather than
imitated with disabled decorative windows.

Later slices can add inline rehearsal/history and routine result receipts
once their existing authoritative data is integrated. A computer tile must
state browser-only, local VM, this computer or configured cloud/VPS runtime,
along with observed readiness. “Preview” stays explicit when no execution
session exists. Teach-by-demonstration is a future capability, not a relabel
of today's chat history.

## Backup, recovery and synchronization architecture

Start with a versioned, account-scoped **backup**, then add synchronization
as a separate protocol. A transport is not synchronization. Two clients
connected to one server can share that server's state; two independent
installations need conflict handling, identity mapping, deletion semantics
and replay ordering before “all synced” becomes a truthful status.

The portable format should declare schema version, creation time, source
workspace identity, included categories, sizes/checksums and KDF parameters.
Recovery must work on a fresh authorized destination without its predecessor's
deployment secret. Decide and document whether the server sees plaintext;
the current architecture does. Do not label it browser-only or end-to-end
encryption. Validate and stage the entire import, show a dry-run report,
then apply atomically or with a resumable journal and verified rollback.

Test two real accounts on one server and a separate fresh installation.
Cover wrong passphrase, modified envelope, invalid/oversized schema,
traversal, duplicate IDs, foreign ownership, missing references, interrupted
write, no-change preview and complete post-restore readback. Preserve a
known-good backup until a restored workspace has been verified. Never use
real customer data for these fixtures.

**Drive:** appDataFolder is hidden from the Drive UI and other applications,
but is not a retention guarantee. The user can delete it, and uninstalling
the Drive application removes it. Provide a visible in-product backup
catalogue and explicit deletion/restore controls. [8] Google recommends
multipart for small uploads and resumable transfers for larger/unreliable
ones. Use encoded sizes, bounded retries and successful-response checks;
an HTTP failure is not “no backup.” [9]

**Google consent:** inspect actual scopes and refresh-token availability.
Preserve an existing refresh token when subsequent responses omit it.
For native OAuth, use the system browser, PKCE and an appropriate Desktop
client/loopback flow; a packaged secret is not confidential. Testing-mode
OAuth projects requesting Drive can have seven-day refresh tokens. Make
expiry/revocation recoverable without losing the user's local workspace.
[10–12]

**Telegram:** the standard Bot API upload limit and download limit differ:
documents can upload to 50 MB while `getFile` downloads are limited to
20 MB. Bound the entire encrypted envelope conservatively below the
download limit, including encoding overhead. Incoming updates expire after
24 hours and do not form a catalogue. Bind the exact bot, chat and account;
never infer the owner from whichever chat is most recent. [13–15] Store a
recoverable file manifest and provide a way to reselect/forward a backup
after local state is lost. Telegram describes file IDs as persistent, but
that is not an archive guarantee. [16]

## Ranked execution queue and acceptance

| Order | Bounded slice | Required evidence before release |
| --- | --- | --- |
| 1 | Hosted v1 containment | Loop 22: 35 new real HTTP tests, full 2121/8, browser denial; verify deployed guard |
| 2 | OS work overview and exact chat navigation | State-selector/navigation tests; real fixture browser tasks and decisions; responsive window containment and reduced motion |
| 3 | Durable first-task acceptance and explicit skip | Lost-response/reload/concurrent-thread fixture; exactly one accepted request by receipt; skipped draft never sends |
| 4 | Validated portable account schema and local recovery | Two accounts plus fresh-install roundtrip; preflight/rollback/size/path/owner cases |
| 5 | Drive grant lifecycle and backup catalogue | Mocked expiry/revocation/errors; authorized real upload/readback/delete of synthetic fixture after configuration is available |
| 6 | Telegram exact destination and recoverable manifest | Wrong-chat/bot/account and encoded size cases; authorized synthetic transfer/recovery |
| 7 | Guided computer setup | Capability detection, install/runtime startup, observed session readiness and first real task in isolated VM |
| 8 | Native continuity and release candidate | Desktop app launch/OAuth, Android initial/reconnect hydration, iOS/Watch pairing/approvals, disconnect/restart/replay cases |
| 9 | Routine receipts and outcome review | Real authoritative success/failure/blocked states, evidence survives refresh and cross-client handoff |
| 10 | Account-scoped sync protocol | Conflict/tombstone/replay/offline merge matrix across independent installations; no silent data loss |

Follow the mission brief's benchmark with fixed tasks, model/runtime
configuration and repeatable fixtures. Publish measured task counts and
failure categories internally before comparing competitors. Every slice
logs its exact test totals, limitations, commit and observed deployment;
push is not deployment. Continue down this queue when an external native
credential or billing prerequisite blocks another item.

## Commercial loop

Initial product hypothesis: small teams and independent operators with
repeatable research, triage and preparation tasks benefit from persistent
workers whose consequential actions wait for review. Validate that wedge
before expanding a marketplace or promising universal computer control.

Measure the funnel using coarse product events: entry, completed sign-in,
preserved draft, first accepted task, first inspected result, second useful
task and an explicitly configured routine. Do not send prompts, approvals,
conversation content or credentials in analytics. Audit event semantics
before interpreting conversion. Seed greetings and fixture activity do not
count as activation.

Use reliability as the first monetization experiment: does a user return
for a second verified task and knowingly choose a repeat schedule? Then
evaluate whether existing paid-tier capacity solves a demonstrated limit.
Compute cost and support burden must be measured per real completed job;
no new price, billing integration, paid campaign or spending is authorized
by this plan alone. The board's escalation list still controls these acts.

Possible distribution experiments, pending launch approval: an honest
short recording of one complete workflow; an opt-in shareable result with
customer content excluded by default; and a task template that opens an
editable draft without sending it. No fabricated testimonials, benchmark
wins, unsupported platform badges or “first in the world” claims.

## Current evidence and release blockers

One real Google web sign-in returned to production `/app` and `/os` using
an existing account and grant. This proves that observed web path only.
Today and Warmwind were inspected publicly; zero competitor authenticated
flows, downloads or executable tests were performed.

Loop 22 full suite: **200 files / 2121 passed / 8 skipped**. Local hosted
backup checks passed at 320 and 1440 pixels. No production backup/provider
job was run. Native Google login, simulator/device execution, actual VM
work and the complete Mimosa scan remain unverified. No callable Mimosa MCP
was available; zero scans were run.

Source changes through Loop 21 were absent from the older production bundle
at the last documented check. Loop 22 requests Dokploy through the existing
trigger mechanism; recheck actual serving assets and the hosted GET guard.
GitHub Actions had failed before starting jobs because of account payment/
spending restrictions. The Codex subscription upgrade does not change
GitHub billing. Desktop updater metadata last reported 1.10.4; no new
installer is implied by source commits. A normal native release needs
actual packaged builds, installer launch, signing/notarization and updater
validation, plus available release infrastructure. Keep the demo on 8845
untouched. The active goal and hourly heartbeat continue under Astra.

Loop 23 update: production's `index-D-RsCfsG.js` now contains Loop 21/22
onboarding and backup UI markers; the authenticated GET was blocked by the
browser, so direct API verification remains open. OS local full suite
passed **203 files / 2178 tests / 8 skipped**, with 12 synthetic browser
scenarios in the CEO log. Its own source still needs a post-push marker
check. Swift CompanionCore passed **91 tests in 8 suites**, zero failures
or skips; no simulator UI or native release follows from that result.
The continuation changed Node/runtime tooling and removed temporary logs;
fresh verification is retained in `.omb-scratch/verification`. Browser
control is currently unavailable. Native build gates can still proceed
after prerequisites are revalidated. Fresh Node 22.22.3 verification passed
**203 files / 2178 tests / 8 skipped in 214.13s** plus frontend typecheck.
Unsigned iOS/Watch simulator builds passed in **52.15s / 23.71s**, zero
compiler errors or signing steps. Electron 43.4.0 arm64 was restored and
CLI-verified. These build/runtime checks do not establish native UI,
Google login, signing or installer release.

## Sources

All checked 2026-09-10. Product descriptions remain vendor claims unless
explicitly labeled browser-observed above.

1. [Today login](https://today.ai/login)
2. [Today homepage](https://today.ai/)
3. [What is Today? — August 3, 2026](https://today.ai/articles/blog/what-is-today)
4. [Warmwind homepage](https://warmwind.com/)
5. [Warmwind international rollout — August 26, 2026](https://about.warmwind.com/warmwind-launches-international-rollout-of-autonomous-ai-workers/)
6. [Warmwind technical OS explanation — July 2025](https://about.warmwind.com/we-built-an-operating-system-for-ai-but-is-it-really-one/)
7. [Today downloads](https://today.ai/downloads)
8. [Google Drive application data](https://developers.google.com/workspace/drive/api/guides/appdata)
9. [Google Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
10. [Google OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
11. [Google native application OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
12. [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
13. [Telegram sending files](https://core.telegram.org/bots/api#sending-files)
14. [Telegram getFile](https://core.telegram.org/bots/api#getfile)
15. [Telegram incoming updates](https://core.telegram.org/bots/api#getting-updates)
16. [Telegram file ID persistence](https://core.telegram.org/bots/faq#can-i-count-on-file-ids-to-be-persistent)
