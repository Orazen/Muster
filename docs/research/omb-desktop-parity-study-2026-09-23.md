# OpenMausBot parity study — desktop app, all features, design, UX, settings

_Author: Buffy. Date: 2026-09-23. Sources: OMB `main` HEAD (2026-09-23),
release notes v0.1.81→0.1.85, `src/locales/en.json` (the complete shipped
string surface, 164 KB), `docs/screenshots/*` (12 fetched and reviewed in
`.omb-media-study/view.html` on the Preview tab), and the **installed Mac app
itself** (`/Applications/OpenMausBot.app`, v0.1.85 — asar extracted, the
built renderer bundle grepped for the exact feature strings that ship)._

## What OMB is at 0.1.85 (3,404 stars, shipping multiple times a day)

OMB's moat is shipping speed. v0.1.81→0.1.85 in five days added: cross-bot
attention inbox on mobile, LLM-generated thread titles, queued sends from
client queue state, customizable provider icons, attach-to-running-Chrome
(CDP), inbox archive with attention resurface, org logos and shared bot icons,
VPS SSH sharing for unattended runs, Chief-of-Staff retry of broken runs,
reversible archive, threads with folders on Android.

## Settings surfaces, side by side

| OMB App Settings section | Muster equivalent | State |
|---|---|---|
| General (profile, analytics, updates, threads, parallel, concurrency, cleanup, event log) | General | Partial — Muster has updates + turn cap + diagnostics export; **no thread cleanup/concurrency** |
| Connected workspaces | Connected workspaces | Present (server routes + UI) |
| Organisation (sign-in, managed, company models, disconnect) | Organisation | Partial — Muster has members/policy; **no company models gateway, no org branding** |
| Appearance (skin, theme, tool calls, threads show/hide) | Appearance | Partial — skin picker + theme exist; **no tool-call chips toggle, no thread show/hide** |
| Experimental (skill authoring, browser) | Experimental | Present (Muster has its own flags incl. skill authoring + browser) |
| Connections (keys, API, composio, box, xai, VPS alias) | Connections | Present |
| Engines and accounts | Engines | Present — Ready/Needs-setup split, per-engine paths |
| Remote access (companion) — HTTPS/Tailscale/Wi-Fi pairing, paired devices, keep-awake, secure account, connection details, client mode, custom domain, sign-in access | Remote access | Mostly present — Muster has pairing, device list, Tailscale, allowlist, keep-awake; **no client mode, no custom-domain flow, no pairing-scope choice** |
| Local VM (setup wizard: runtime → prepare Cua → per-bot VM) | Local VM | Present (auto-setup chain + install leg landed) |
| Usage (tokens/cost per bot) | Usage | Present (per-bot + caps) |
| People (invites, roles, spend) | (invite + members in Organisation) | Present, different grouping |
| Activity (who changed what) | Audit + Why | Present |
| Workspaces (server tenants) | — | **Missing** (server-tenant admin surface) |
| Backups (export/import full backup) | Vault + Portable backup | Present (different shape) |

Per-bot settings (OMB "bot folder" / agent profile): Overview, Identity,
Access, Permissions, Skills, Routines, Memory, History, Usage, Voice, Soul,
Visibility, Model, Files, Connections, Threads. Muster's SettingsPanel covers
identity/soul/model/memory/usage/voice/permissions/computer/connected-apps in
one panel; **no Skills tab, no Visibility tab, no per-bot Threads tab**.

## The ranked remaining-gap list (evidence-backed, own-code verified)

1. **Threads done properly** — multiple conversations per bot with folders,
   LLM short titles, show/hide setting, per-bot parallel concurrency, and a
   cross-bot attention inbox ("what needs me") in the sidebar. OMB's biggest
   recent investment (5 releases); Muster has rooms but no per-bot thread
   folder. **Highest value.**
2. **Reply/quote + raw-markdown toggle + transcript export** in chat — three
   small composer/chat affordances OMB has; Muster's MessageBody has none of
   the three. Cheap, daily-use value.
3. **Routine results destination** — "post results to a dedicated thread" with
   dated runs; Muster routines post to chat only.
4. **Pairing scope choice** (Full access vs "chat and approvals only") on the
   server pairing card — real security UX Muster lacks.
5. **Custom domain + Cloudflare Tunnel guidance** in Remote access (OMB has a
   34-string DNS walkthrough card).
6. **Remote CLIENT mode** — "Connect to another computer" (companion 6-digit
   code or self-hosted `/pair#code=` link). Biggest single build; depends on
   server-side support for client-mode sessions.
7. **Computer sharing settings** — let another person watch/control a bot's
   computer with explicit grants.
8. **Org identity** — organization logo + shared bot icons on desktop.
9. **Linux local control (beta)** — Xorg-only Cua local control; matters only
   for Linux self-hosters.
10. **Two-desktop canvas** — watch two Local VM desktops side by side.

Not ported (deliberately): client-workspace server tenants (Muster's model is
one workspace per deployment), license banners (no enterprise licensing),
usage-analytics toggle (Muster ships none — keep it that way), OMB's
`npx openmausbot` onboarding line (Muster's CLI story differs).

## Method note

- The parity matrix was compiled by grepping **Muster's own tree** for each
  OMB feature's implementation (42 of 66 verified present), then re-checking
  each "missing" against Muster's rooms/threads reality to kill false
  negatives (e.g. Muster's sidebar already nests room-threads under bots with
  attention sorting — the genuine gap is folders + titles + show/hide +
  concurrency + the cross-bot inbox, not the nesting itself).
- Screenshots fetched from `docs/screenshots/` are assembled into
  `.omb-media-study/view.html` (base64-inlined) for side-by-side reference.
- The installed app's `ui/assets/index-*.js` (3.5 MB build) was string-scanned
  to confirm the 0.1.85 settings sections and bot-tab labels match the repo.
