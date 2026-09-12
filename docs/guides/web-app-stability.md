# Web app stability and agent handoff

Owner directive, 12 September 2026: preserve the working web app and its approved
layout. Fix verified defects in small slices. An audit is not permission to
replace navigation, defaults, branding or the entire interface again.

## First read for every agent

1. Read this guide, `AGENTS.md`, and the newest entry at the end of
   `docs/plans/glm-handoff-2026-09-10.md`. Historical plans are context; the newest
   owner instruction and recorded implementation state take precedence.
2. Read `git status --short --untracked-files=all` before pulling or editing.
   Preserve pending work with a path/hash receipt. Never reset, clean, overwrite,
   or include inherited changes in another slice. Work on `main`; coordinate
   non-overlapping file ownership before using subagents.
3. State the defect, expected behavior and smallest touched surface. Reproduce it
   before changing implementation. A source hypothesis is not a proven live cause.
4. Use an owned fixture, explicit free ports and isolated data. Record the child
   PID, origin and cleanup receipt. Never stop an app merely because its port is
   wanted. Port 8845 and every existing user application/session stay untouched.

## Preserve the user's surface

| Surface | Contract |
| --- | --- |
| `https://muster.orazen.online/app` | Canonical public workspace. Production checks are GET only. |
| `https://muster.orazen.online/os` | Separate existing OS shell; do not redirect users between shells as a repair. |
| Local Vite development | Editable source preview; real UI edits intentionally hot-update. Never present it as the deployed app. |
| Local built preview | Build once, serve the resulting snapshot; use for a review that should not follow source edits. |
| Installed desktop/companions | Independent installed versions and data; building web files does not update them. |

Retain the current mascot, responsive layout, theme choice, selected conversation,
login and drafts unless the actual requested feature requires a reviewed change.
Do not clear cookies, storage, sessions or workspace data to hide a reproducible
problem. Separate test browser contexts and hostnames are preferable: different
ports isolate localStorage but **do not isolate hostname cookies**.

## Predictable local previews

Vite requires an explicit `OMB_PORT` (or legacy `OGB_PORT`) for its API backend.
`OMB_UI_PORT` selects the development frontend port. Pass an explicit port to the
built preview too. Do not assume 8799 is Muster: on 12 September this Mac had
OpenMausBot listening there. Port ownership must be rechecked each session.

Before forwarding API requests, the preview checks the configured loopback
backend's Muster identity and pins its process identity. A missing/wrong/replaced
backend fails visibly instead of receiving login data or mutations. Restart only
the owned preview deliberately when switching its backend. This diagnostic check
is not a security boundary against hostile local processes.

Use the existing owned browser/server harnesses for automated work. For manual
development, set the same explicit backend port on the harness and preview, and
set `OMB_DATA_DIR` to the intended owned data directory before starting the harness.
Do not inherit provider credentials into disposable tests. Never silently choose
a different UI port; an occupied port is an error to resolve through ownership.

Scratch snapshots, test reports and generated build outputs must not trigger Vite
reloads. Keep source HMR enabled for deliberate edits. A stable built preview uses
`npm run build` followed by `npm run preview` with the explicit backend and frontend
ports; it changes only when deliberately rebuilt. Do not rebuild that review
artifact while the user is testing it.

## Publication is a separate boundary

A pushed commit, successful health GET and desktop package version do not prove
the running web revision. Record the verified source commit, actual asset URLs and
bytes, and the final GET results. Never report an unreleased native version as
installed or describe an unverified deployment as successful.

### Deployment wiring discrepancy — verified 12 September 2026

Repository push hook **669688357** delivered product commit **e1cfcb9** at
19:26:43 UTC and received **HTTP404**. Four preceding push deliveries also
returned 404. Actions CI/autodeploy meanwhile recorded four billing-rejected jobs,
one skipped job and zero executed steps. The registered repository hook's origin
is `https://dokploy.ramagiritharun.in`; its full destination is intentionally not
published here. The control panel is reachable but signed out in the available
browser; no Dokploy environment credential or project `.env` is available.

At 19:30 UTC, the missing-asset fix was observed live despite that failed hook:
missing scripts/styles returned text 404/no-store, while the served app shell and
JavaScript/CSS bytes remained unchanged from the baseline. Another delivery path
therefore appears to work; its configuration is not established by the hook data.
The live asset entries differ from this Mac's build, so exact artifact/source
identity remains unverified. Do not call an unchanged filename an old deployment
without an attestation or equivalent evidence.

The owner has been asked to sign in to the opened panel to repair the failed
registered hook and inspect the actual deployment path. Do not ask for a password
in chat or invent a replacement webhook URL. With authenticated access, identify
the current Muster application, confirm its repository/branch and read its actual
deployment endpoint. Repair the existing hook only from that verified setting;
preserve unrelated events, TLS and secret configuration. Promote one verified
revision and check delivery acknowledgement plus actual GET asset/error behavior.
Do not delete/recreate workspace data or repeatedly resend a failed webhook.
A private GitHub App delivery path has not been independently inspected here;
the observed live fix must not be described as blocked merely because this hook failed.

Known deployment debt, not repaired by preview/static-serving fixes:

- `autodeploy.yml` currently runs independently of CI, checks out floating main,
  pushes a trigger commit and also calls a webhook. Live Dokploy trigger settings
  are unverified. One verified-revision promotion path is still required.
- `scripts/deploy-prod.sh` pulls/builds host files, stops the default Compose app,
  then starts production without an image rebuild. Do not use it as a verification
  command or an automatic recovery step. Replace it in a separately tested slice.
- `Dockerfile.cloud` and production Compose have build/user/healthcheck defects
  recorded in the ledger; do not claim those container paths are validated.
- Old asset retention across rollouts, exact build identity, and any historical
  service-worker state require separate acceptance. A missing asset must return
  404, not HTML disguised as a successful script/style response.

Do not bump `.deploy-trigger`, restart production or change hosted configuration
merely to make a test pass. For an owner-authorized web repair, one trigger update
may ship in the same fully verified product commit; record the candidate and GET
acceptance. This uses the existing repository-to-Dokploy path and is not proof
that the live webhook accepted it. Never create a trigger retry loop. Billing
remains an account-level gate for Actions. Use the
[local verification guide](verification-without-actions.md); it does not turn
blocked GitHub checks green. Keep the existing automation paused.

## Handoff before stopping

Record the exact commit, changed behavior, real focused/full test counts, retained
failures, production result, remaining gates and next smallest slice in the ledger
and CEO log. Restore inherited files byte-for-byte and leave an explicit manifest.
An agent must be able to distinguish shipped, locally verified, proposed and
blocked work without rereading the entire conversation. Never claim permanent
availability or that all features pass from one narrow test suite.
