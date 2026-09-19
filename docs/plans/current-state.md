# Current Muster state — read before editing

**Latest owner direction (19 September, strategy interview):**
[Personal-assistant beta decisions](personal-assistant-beta-decisions-2026-09-19.md)
supersedes conflicting older strategy: everyone, all-platform small beta,
Watch calling and Plan my day, Drive-first recovery, capped included AI plus
BYOK, free beta. Public expansion requires passing core flows and five testers
completing daily planning on three separate days each. This is a decision record,
not a new implementation or verification claim.

Updated 19 September 2026 (Loop135). This snapshot takes precedence over historical roadmap
status; the latest owner request takes precedence over this file.

**Loop135:** selected-calendar planning now gathers one to three commitments
and durations, re-reads the complete day, computes deterministic available blocks
and appends a readable unsent proposal to the chosen bot. Mounted composers now
receive draft updates while preserving existing text and attachments. No task is
sent before explicit Send; no calendar events are written. Stale responses,
all-busy days, DST/work boundaries, exact time precision and 320px layout are
covered. Full unit **306 files / 4505 passed / 8 skipped / 0 failed** (435.55s),
+1 file/+35 passing tests over Loop134; full browser **36/36** (3.7m),
packaged-server **14/14**, focused recovery **52/52**. Project/server/e2e
typechecks, production build, native source import and lint passed.

A Node-only panel test needed its browser auth import mocked; the failed full run
and interrupted earlier run are preserved in ceo-log.md. Real provider, installed
device and production acceptance remain open. Next bounded correction: existing
automatic cross-provider fallback lacks the owner's explicit opt-in requirement;
see the acceptance matrix before implementing. No allowance spending enabled.

**Loop135 deployment audit:** GitHub CI run 35458357189 passed and automatic
deploy run 35459042896 succeeded (19 September, 17:45 UTC). Dokploy returned
“Application deployed successfully”; webhook 669688357 is active with last
HTTP 200. These supersede historical billing/404 explanations for the hosted
web rollout. GET at 17:52 UTC still returned backend 7632065f-88c9-4614-8faa-42adb590f61b
(started 18 September 14:08 UTC) and web 453b2f23-e6ce-4963-ad5b-c5d09ac598a6,
with null revisions and no attestation. The unresolved boundary is accepted
trigger → running service/artifact replacement. Inspect authenticated Dokploy
build/rollout logs and domain-to-application/build-context mapping next. This
CI receipt does not establish Windows/Linux release acceptance.

**Loop134:** connected users can explicitly choose a calendar/date/timezone
and read the complete agenda in the existing panel. Separate Calendar credentials
refresh with session/generation checks; old responses are discarded after
revocation or selection changes. Pagination/collection checks fail closed;
recurrence, all-day intervals and DST boundaries are handled without event writes.
Full **305 files / 4470 passed / 8 skipped / 0 failed**, browser **35/35**,
packaged-server **14/14**, focused **98/98**, build/types/lint pass. Gates caught
and fixed native Node strip-only syntax plus a browser fixture locator issue.
No real-provider or production acceptance claim. Next: explicit unsent planning
draft with user commitments and deterministic time blocks; verify current-bot
draft notifications/preservation first (source audit in acceptance matrix).

**Loop133:** account-owned Google Calendar consent now has separate token
storage, signed provider identity checks, PKCE, one-use session-bound state and
revocation-generation guards. The existing Connected apps panel offers explicit
read-only consent/local disconnect and reopens on callback, including at 320px.
Drive/login token rows are preserved; local disconnect does not revoke Google's
combined grant. Full **303 files / 4427 passed / 8 skipped / 0 failed**,
browser **34/34**, packaged-server **14/14**, focused backend **65/65**;
build/types/lint pass. Real Google consent and installed-device acceptance remain
open. Next: token refresh and complete selected-calendar day reads, then an
explicit planning draft; consent alone is not working daily planning.

**Loop132:** installation connections now require the hosted primary owner;
connector credentials are scoped to the active bot/thread/turn and revalidated
across async work. Opt-out and Stop revoke credentials and queued continuations.
Unavailable connections show their actual reason in the existing panel.
Full **300 files / 4371 passed / 8 skipped / 0 failed** (449.92s), browser
**31/31**, packaged-server **14/14**, focused **72/72**, build/types/lint pass.
Compared with Loop131: +2 unit files, +24 passing tests, +1 browser test.
The first browser gate exposed a backup fixture request-count race; corrected
fixture boundaries retain stale-result and zero-write assertions. No backup
product change. Real Calendar consent/day reading is next; provider, native,
production and whole-codebase security acceptance are not established here.

**Loop131:** added the Daylight personal-assistant template and an explicit
Plan my day first-task draft. Reproduced and fixed Agent Hub clipping off-screen
at 320px by portalling the dialog outside the translated sidebar. Owned browser
coverage verifies one hire, preserved unsent draft after reload, no auto-approval
grant, and one explicit send. Full **298 files / 4347 passed / 8 skipped**,
browser **30/30**, focused **61/61**, build/types/lint pass. Initial full run had
four process/startup failures under heavy host load; unchanged focused rerun
**49/49** and full rerun passed. See CEO log for all receipts. No real-calendar,
Watch calling, native release or production rollout claim. Next: reproduce and
close hosted connector ownership gaps before account-scoped Calendar reads;
[acceptance matrix](beta-acceptance-matrix-2026-09-19.md) records the source audit.

**Loop130:** fixed OpenConnector-only bot dispatch and connection cards that
incorrectly required Composio. Shared backend selection now mounts tools and
routes card creation, authorization and status to the configured runtime;
Composio fallback and bot opt-out remain. Reproduced before fix on an owned
server. Full **298 files / 4347 passed / 8 skipped**, browser **29/29**,
packaged-server smoke **14/14**, focused connector **20/20**, types/lint pass.
This verifies the connector prerequisite, not real Calendar consent or Plan my
day completion. No native release or production rollout claimed.

**Loop129:** beta decision record and [acceptance matrix](beta-acceptance-matrix-2026-09-19.md)
added. Owner-claim browser coverage verifies identity, fragment removal, single
submission/replay rejection, malformed input, and cloud-code namespace separation.
`/claim#CODE` already works; `/pair#CODE` must not be wired to its claim endpoint.
Full unit **296 files / 4341 passed / 8 skipped / 0 failed**; browser **29/29**;
focused unit **66/66**; all three typechecks, lint and fresh build pass. Native
and real-provider/device acceptance remain open. See the corrected
[handoff](handoff-next-agent.md); this is not a deployment receipt.

**Owner priority:** keep the existing web layout, Flower mascot, /app and /os
shells, choices and sessions stable. Read [the stability contract](../guides/web-app-stability.md).

**Loop126 (19 September 2026):** the parked verification finished; a real chat re-greet bug found behind a flaky-looking e2e. Resuming the interrupted run, workspace-backup e2e showed 2 failures in signIn's first-run dismissal; trace extraction proved no Escape ever ran — the helper sampled each first-run surface once and the async wizard mounted during the closing assertion (the late-decision delay is correct product behavior). The settle helper now waits up to 2.5s per round for a surface before acting. That exposed two real OnboardingChat defects: (1) it wrote `muster.onboarding-chat.done` but never read it, so any empty-roster account re-greeted on every load — now the persisted gate is read via `onboardingChatDone()`; (2) no connect guard, so the chat flashed during the pre-SSE boot window when every account reads as empty — now `shown` requires `state.connected` (same rule the classic wizard applies). Receipts: e2e **26/26**, onboarding-draft **7/7**, unit **294 files / 4327 passed / 0 failed**, both typechecks 0, oxlint **0/0** (827 files), fresh build ✓.

**Loop118 (18 September 2026):** speed + systematic docs. **Bundle split (measured):** the app shipped one eager 1,882KB main bundle — route/overlay code-splitting did not exist. The conditional surfaces (SettingsPanel, PluginsPanel, ComputerPanel, BrowserPanel, InspectorPanel, SettingsModal, RoutinesPage, SocialView, Onboarding) are now lazy chunks with per-overlay Suspense boundaries, plus route-level lazy for /sign-up, /pair, /claim, /forgot-password, /reset-password and /os; the boot surface (Sidebar, ChatView, GroupView, auth, /app shell) stays eager so /app paints identically. Result: **main 1,882KB → 1,509KB (−373KB, −20% raw; gzip ~0.50 → ~0.40MB)**, 9 new on-demand chunks; first-open of a panel costs one local fetch. **Bench on demand:** `pnpm bench:roles` runs the per-role benchmark capture + grade pipeline. **Agent orientation hub:** `docs/AGENT-ORIENTATION.md` — the 5-minute systematic map (read-order, ranked list + status vocabulary, plan-doc index, non-negotiable rules, verification gate with baselines, parallel-agent etiquette with file-ownership claiming, owner-gate table, one-command slices); AGENTS.md's read-first section now points there. Production note: HEAD still 404s on muster.today — the autodeploy trigger commit has not deployed the Loop116 server fix yet (owner action). Gate: unit **292 files / 4320 passed / 8 skipped / 0 failed**, e2e **26/26**, both typechecks exit 0, oxlint **0/0** (822 files), `pnpm bench:roles` green.

**Loop117 (18 September 2026):** two owner-reported field bugs fixed. **Podman setup failed while podman was healthy:** the runtime-start verifier probed `podman info` once (20s) immediately after machine start — a cold API forwarder loses that race — so a running podman read as "not answering yet"; the probe is now a bounded retry window (10×1.5s), and the setup card's copy-paste command is idempotent (`init 2>/dev/null; start; info`). **Desktop Google sign-in never landed:** the flow opened in the system browser, so `/oauth/finish` set the session cookie in Safari's jar while the app polled its own — now the cloud sign-in opens in a sandboxed in-app window sharing the app's session (`openAuthHandoff` IPC, cloud-host allowlist), the cookie lands where the existing get-session poll sees it, and the window self-closes; web builds unchanged. Acceptance-only: one real Google sign-in on an installed app.

**Loop116 (18 September 2026):** muster.today production checkout (GET-only, no credentials) + two fixes. **Production truth:** health `200 {app:muster, static:true, messageSendVersion:1, approvalActionVersion:1}`; all public pages 200 (`/`, `/sign-in`, `/app`, `/os`, `/docs`, `/marketplace`, `/sitemap.xml`, `/robots.txt`, `/privacy-policy`, `/terms-of-service`); TLS terminates on the VPS (Let's Encrypt CN=muster.today, valid to 2026-12-10); the served bundle contains the mascot character system (poke/annoyed/dizzy/calm code verified in the live JS) — Loop113–115 web work **is deployed**. **Defect found in production:** every HEAD request 404'd (curl -I /, /docs/install.html, /robots.txt → 404) because all static branches gate on `method === "GET"` — monitors/CDNs/updater probes broke. Fixed at the single derivation point (`server/index.ts:4049`): HEAD normalizes to GET; Node strips the body; no unsafe route widens (verified `req.method` referenced nowhere else outside tests). Regression test added to server/index.test.ts (HEAD 200 + body suppressed on /, /app, /assets; HEAD 404 preserved on missing assets). **Deployed desktop is 1.12.1** (Sep 14 mirror; `latest-mac.yml` + all three assets serve, GET-verified) while GitHub Releases v1.12.3 carries the full signed/notarized payload (14 assets, published Sep 16) — the mirror is stale because the Actions `deploy-downloads` leg never ran; promotion needs VPS SSH (owner-gated). Also verified on the mirror: stable aliases (`Muster.dmg`, `Muster-intel.dmg`, `Muster-setup.exe`, `Muster.deb`, `Muster.AppImage`, `latest.json`, `muster-cli.mjs`) all GET-200. **Ranked item #1 closed:** the per-role benchmark capture harness now exists — `server/role-eval-harness.test.ts` boots an owned server (two fake-ACP instances: `auto` fullAuto for working scenarios, `ask` manual so escalation exercises the real card → respond → audit path), runs all six required benchmarks as real settled turns, records captures in the role-eval schema and grades them with the shipped grader to a passing scorecard; deterministic across three consecutive runs (4.3–4.8s). "Router metrics error handling: NaN in 0/0 division" could not be reproduced — the only metrics code (server/computer-observation.ts) is pure counters with no division; recorded as unverifiable rather than invented. Full gate: unit **292 files / 4319 passed / 8 skipped / 0 failed**, e2e **26/26**, both typechecks exit 0, oxlint **0/0** (820 files).

**Loop115 (18 September 2026):** mascot character system completed across all four surfaces. **Slice D — desktop tray companion:** the mascot lives in Electron as a small always-on-top companion window (`tray.html` + `src/tray-main.ts`, a 3KB second Vite entry, not the app bundle), showing one bot in focus (the one that needs you, precedence in pure `src/lib/mascot/tray-state.ts` — tested in sync with the web reducer) and the rest as face+line, polled from the same local `/api/bots` feed while visible, paused when hidden; toggled from the View menu (⌘⇧M) or `window.ogb.trayToggle()`; verified live on the dev stack (tray.html 200 + real feed through the owned proxy). **Slice E — iOS widget:** `MusterFleetWidget` extension (small + medium) renders the fleet from `FleetSnapshot` (new CompanionCore module: app publishes to the `group.com.muster.companion` app group after each state change, content-throttled; widget renders the same vector flower from CompanionCore's artwork; stale >15min reads as offline, not a lying "Working"). **Slice F — Watch haptics:** fleet state transitions now fire haptics (`needsYou` → notification, `working` → start) on the mascot-first root that already shipped. **Slice G — share card:** `src/lib/mascot/share-card.ts` builds the LaoA-style 1080×1440 card data (name, real face, narrated line, resolved hexes) with a tested layout contract. Verified: iOS app + widget extension + Watch targets all **BUILD SUCCEEDED** on the generated project; core **352 tests / 0 failures** (incl. new snapshot tests); web full suite **291 files / 4317 passed / 0 failed**; e2e **26/26**; both typechecks exit 0; oxlint **0/0**. App Store/Live-Activity-on-lock-screen acceptance remains device-gated (physical device + Apple approval) per the release plan.

**Loop113 (18 September 2026):** owner-directed mascot character system planned from the Novra GrokBot case study and 18 supplied references (study with per-source adopt/leave calls: `docs/research/mascot-character-study-2026-09-18.md`). Owner decisions binding: upgrade the existing Flower (no ported/copied engine), four surfaces in v1 (web, desktop tray/notch, iOS Live Activity/widget, Watch), full playful interactions with a calm-mode off switch, two-layer state model (status × expression). Execution plan with slices A–G, a file-ownership map for parallel agents and per-slice acceptance gates: `docs/plans/mascot-character-system-plan-2026-09-18.md`; agent skill `skills/mascot/SKILL.md`; ranked-plan §7 notes the new owner-priority item. **Web slices A+B+C shipped same day (see Loop114).** Slices D (Electron tray), E (iOS Live Activity/widget), F (Watch), G (delight/docs) remain open for parallel agents.

**Loop112 (18 September 2026):** the iOS "build failed" report reproduced, root-caused and closed. The GitHub Actions red was the documented billing rejection (zero steps executed on every push — no code involved). Locally everything native passed: core **352 tests / 0 failures**, iOS app + embedded Watch target, Release archive, UI-test scheme. The real defect was the owned acceptance rig: (1) ad-hoc signing (`CODE_SIGNING_ALLOWED=NO`) leaves no application-identifier entitlement, so the simulator keychain refuses `SecItemAdd` (-34018) *after* the server redeemed the token — pairing appears to fail at the last step; fixed by building with default signing. (2) `server/config.ts` reads `config.json` only from `OMB_DATA_DIR`, so harness instances written to `$HOME/.muster` never loaded and every bot showed "Not logged in"; fixed in the rig. (3) Xcode 26.6 UI-test snapshot starvation (predicate/indexed queries hang while the app renders) — fixed with stable app-side identifiers (`chat-header-capsule`, `walkie-answer-quote`, `walkie-answer-headline` in ChatView/WalkieView) queried via `descendants(matching: .any)` with fresh-query retries, TTS off during the live turn, and pairing-window pre-install (pre-boot + pre-install before the invite is minted). New owned rig `scripts/owned-ios-acceptance.mjs` drives pair → identity tour → Walkie turn end to end: real harness + sidecar on probed free ports, throwaway `HOME`/`OMB_DATA_DIR`, fake ACP engine, disposable simulator etiquette, cleanup receipts. **Two consecutive all-green runs** (pair ✅ identity ✅ walkie ✅, exit 0). Desktop package verified locally: `Muster.app 1.12.3` → `release/Muster-1.12.3.dmg` + `-arm64.zip` (163M each, ad-hoc, publish never). Web gate holds at tip: both typechecks exit 0, oxlint **0/0** (808 files); unit/e2e baselines unchanged from Loop111 (no web code touched). Actions/Windows/Linux/TestFlight legs remain owner-gated (billing, APPLE_CERTIFICATE, VPS SSH).

**Loop111 (17 September 2026):** continuation audit — the inherited Drive-connect slice (GET-shaped connect in PortableBackupCard, consent-redirect e2e with an owned Google consent stub, plan §7, DESIGN §41) verified through the full gate and committed; e2e is now **23/23** (new consent-redirect acceptance). README rewritten around the real `docs/screenshots/` captures (was embedding zero images; `iphone-roster.png` added as a copy of the iOS App Store roster shot) and its backup-boundary row corrected to the shipped account-Drive truth. The drive-by priority list was corrected in remaining-work-plan §7: the per-role benchmark grader (`server/role-eval.ts`) and `muster bench` CLI ship today — the missing piece is the automated capture harness and product/CI wiring, not the whole benchmark.

Receipts: unit **287 files / 4287 passed / 8 skipped / 0 failed**; e2e **23/23**; both typechecks exit 0; oxlint **0/0** (806 files).

**Loop110 (17 September 2026):** brain-backed dispatch — the Jev-style recommend_team engine now uses the workspace brain's institutional memory to bias ranking. server/jev-dispatch.ts accepts owner-filtered brain facts and awards a capped +2 per fact (max +4) when a fact's source names a candidate and its text overlaps the task. server/index.ts queries brain facts in the same peer-lease scope as the roster. server/brain-dispatch-harness.test.ts proves the full chain over a real booted server: the same candidate is out-ranked by memory evidence, and the cap prevents a prolific bot from buying the top slot.

Receipts: unit **287 files / 4287 passed / 8 skipped / 0 failed**; focused brain slice 19/19; both typechecks exit 0; oxlint **0 warnings / 0 errors**.

**Loop109 (17 September 2026):** the Muster workspace brain shipped — gbrain's load-bearing ideas (explicit facts with provenance, withdrawal, zero-LLM entity edges, gap-aware retrieval), none of its operational weight. Harness routes /api/brain* owner-scoped; Fleet MCP gains brain_write + brain_query (8 to 10 tools). Live harness test caught cross-account fact leakage on local installs — fixed through the read-only session seam.

Receipts at merged tip (3a49b05): unit 287 files / 4282 passed / 8 skipped / 0 failed; e2e 22/22; both typechecks exit 0; oxlint 0/0. PR #13 merged with checks platform-refused per PR-#8 policy.

**Loop108 (17 September 2026):** Jev-style recommend_team — the Chief of Staff ranks the roster before delegating. Pure engine: weighted overlap (title x3, name x2, description x1), busy tie-break, complexity read, model-fit ADVISORY only. MCP tool recommend_team in agents-proxy under peer-lease auth. Fake-acp-cli recommend-peer mode proves the chain over real server.

Receipts at merged tip (903cfe8): unit 285 files / 4273 passed / 8 skipped / 0 failed; e2e 22/22; both typechecks exit 0; oxlint 0/0. PR #12 merged with checks platform-refused per policy.

**Loop107 (17 September 2026):** the Muster Connector — own-branded connected apps via OpenConnector (oomol-lab/open-connector). server/openconnector.ts implements the runtime contract (Bearer token, {success,data} envelope, /v1/providers, /v1/apps/authenticated, /v1/connections/{service}/connect, /v1/actions/{id}, /mcp with session forwarding). Wins backend priority when configured; Composio paths remain untouched fallbacks. Settings gains write-only runtime URL/token; PluginsPanel names backend honestly.

Receipts: live probe 5/5 (catalog mode, branded cards, batched status, authorize link, config no token echo). Full gates: unit 283 files / 4250 passed / 0 failed; e2e 22/22; both typechecks; oxlint 0/0. PR #11 merged per policy.

**Loop106 (17 September 2026):** blue selection fix — global ::selection replaced bright accent 45% with raised-hover surface tone (skin-correct), html declares color-scheme: dark, mobile tap-flash transparent. Verified in live preview: computed style rgb(61,61,61)/80%, zero blue, console clean. PR #9 merged (119001a) per policy.

**Loop105 (17 September 2026):** account-Drive happy path pinned — three real fixes: (1) session resolved on local installs (was only under SELF_HOSTED, where family is 403-walled); (2) refreshed tokens now persist (every operation was paying fresh grant); (3) fixture exchange check fixed from 4 to 5 params. Plus 15 anti-slop lint errors from PR #8 extraction healed. Suite: server/account-drive-roundtrip.test.ts 8/8 over real booted server.

Receipts: unit 283 files / 4250 passed / 0 failed; e2e 22/22; both typechecks; oxlint 0/0. PR #10 merged per policy.

**Loop104 (17 September 2026):** the e2e suite runs on this machine for the first time and is green (22/22). Playwright's Chromium had never been downloaded here. Fixed: PortableBackupCard hosted 403 + POST-shaped status read; FleetOrb idle pill deliberately unmounted 2026-09-15; pairing carried-code browser acceptance added (/pair#CODE survives bounce, displays, still redeemable). Bisected: all inherited red pre-dated recent commits.

Receipts: e2e 22/22; unit 281 files / 4235 passed / 0 failed; both typechecks; oxlint 0/0. Pushed to origin/main.

**Loop98 (16 September 2026):** remote-access client role for pairing links. src/lib/pairing-link.ts owns planWorkspaceConnect(): self-hosted #code=XXXX-XXXX-XXXX connects and carries code; bare /pair connects; 6-digit companion code produces status notice; query-string codes refused; bare-fragment /pair#CODE accepted. Settings → Connected workspaces only UI change.

Receipts: focused pairing-link + workspaces tests 28/28; full 281 files / 4218 passed / 8 skipped / 0 failed; both typechecks; oxlint 0/0; vite build ✓.

**Inherited, preserved and deliberately NOT committed** (hashes byte-identical to preservation receipts):
`docs/research/glm/{01..05,README}.md` and `www/templates.html` (`aa2ba679…2f09c60`), plus the uncommitted **M** `src/state/teach-replay.ts` + `.test.ts` from a later session (focused suite 20/20). Treat `docs/research/glm/` as a dated snapshot, not as status.

**Published source:** the Loop112 commit on main. Loop112 closes the iOS acceptance report (owned rig all-green ×2, desktop DMG verified locally); Loop111 adds the README screenshot gallery, the corrected continuation plan (§7) and the committed Drive-connect acceptance; Loop110 brain-backed dispatch; Loop109 the workspace brain; Loop108 Jev recommend_team; Loop107 Muster Connector; Loop106 selection fix; Loop105 account-Drive round trip; Loop104 e2e green; Loop98 client-role pairing.

**Deployment wiring:** registered push hook 669688357 returned 404; Actions billing-rejected. Another path delivered static fixes to production. Do not invent URLs or equate failed hook with no rollout. Authenticated Dokploy access remains owner-blocked. Keep existing automation paused.

**Next:** scheduled/CI wiring for the benchmark harness (the capture + grade pipeline now exists in `server/role-eval-harness.test.ts`), mirror promotion of desktop 1.12.3 (VPS SSH owner-blocked), redeploy the HEAD fix so monitors see 200s, memory history + rollback UI (prereq for any self-proposal touching memory), skills-creation API (largest server gap), browser-side pairing redeem on the existing `/api/pair/claim` route, voice W4 barge-in (needs real-device testing), OpenMausBot parity items (channels in /app, Engines Add-account, tour pacing), Windows/Linux legs (CI billing), TestFlight review, full Mimosa re-run before any security claim.

## Structure note — server route-table pattern

The workspace/v2 + account-Drive backup family no longer lives inline in server/index.ts. It is extracted to server/workspace-backup-routes.ts behind an ordered route table: each entry has a match(method, path, ctx) predicate and a handle(req, res, ctx) handler; handlers receive a BackupRequestContext (requestUserId, live config, appVersion, dataDir) and index.ts owns session resolution and per-request state. Shared HTTP plumbing (json, isText, readBody) moved to server/http-helpers.ts — route modules import the one definition.

The registration point is order-sensitive and documented in the module header: inside the session gate, above the multi-tenant guard, with capability advertisement ahead of the hosted installation wall inside the table. First match wins; the handler returns false when the family does not claim the request, and index.ts proceeds unchanged.

Extracting the next family is mechanical: write the module with its own ordered table, register it at its exact current position with the same one-call pattern, run the gate. Committed as b61c771 on refactor/server-route-table; merged via PR #8.
