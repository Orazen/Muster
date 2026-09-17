# Competitive refresh — Vellum + OpenMausBot (2026-09-17)

Dated snapshot of public GitHub activity, gathered 2026-09-17 via the
authenticated GitHub API from this checkout. **Method: public source and
release notes only — 0 competitor runtime checks, 0 competitor tests run.**
This extends, and does not replace, the pinned source audit in
[competitive-landscape.md](../plans/competitive-landscape.md) (OMB
`67336fb`, 2026-09-10). No security claim anywhere.

## OpenMausBot — v0.1.83, ~3,004 stars

13 releases in the seven days to 2026-09-16 (v0.1.70 → v0.1.83) plus
android-v1.3.0. HEAD `53dd47fc` pushed 2026-09-17 05:45 UTC. Themes from
release notes, newest first:

- **Coordination ergonomics** (v0.1.83): naming a teammate reaches the bot;
  roster lines carry ids — `coordinate_bots` failure modes got explicit
  fixes. Cheap-feeling polish on the multi-bot story.
- **Routines** (v0.1.82): busy-target deferral is surfaced on queued runs.
- **Org identity** (v0.1.82): organization logos and shared bot icons on
  desktop.
- **Unattended runs on a VPS** (v0.1.81): the app shares SSH connections and
  starts the VPS for unattended runs. This is the "leave it running
  elsewhere" leg Muster covers with pairing + desktop; OMB is converging on
  remote-ops too.
- **Threads on Android** (android-v1.3.0): the phone understands multi-thread
  bots — roster → threads → folders, with a version-negotiation message for
  older clients.
- **Inbox hygiene** (v0.1.80): reversible archive with "attention resurface".
- Release cadence: multiple PRs/day from several contributors. The moat is
  shipping speed, not any single feature.

## Vellum — vellum-ai/vellum-assistant, ~1,275 stars

TypeScript, HEAD `61d51c87` pushed 2026-09-17 06:28 UTC — commits landed the
same morning this note was written. PR numbering around #42910 indicates a
very large internal stream; the public default branch moves daily. Recent
themes:

- **Integrations inline** (2026-09-17): connect-integrations-from-tile, a
  connect modal, and a gear action on integration cards. Setup is being
  pulled into the main surface — the same "guided first run" pressure the
  Muster landscape doc flags as open work.
- **Memory v3** (2026-09-17): opt-in capture of the selector's input beside
  the pool audit; retrospective forks replay the source's delegation-section
  state. Memory quality is an active, measured engineering focus.
- **Desktop perf discipline**: per-frame feature checks and config reads
  removed; wallpaper rendering moved off the assistant event loop. They are
  treating desktop frame-time as a product surface.
- **Gateway durability**: an inbound file over the cap is announced, not
  silently dropped.

## What this means for Muster (no unverified claims)

1. **The account-linked Drive slice shipped today (`318ddaa`) is a genuine
   differentiator today**: neither competitor's recent public notes
   advertise encrypted whole-install backup through the *user's own* Google
   account with ciphertext-only transport. Vellum has integrations plumbing;
   OMB has phone pairing. "Your fleet's memory rides in your Drive, you hold
   the passphrase" is Muster's to keep — but only if the connect flow gets
   browser acceptance before someone else ships their own version.
2. **Cadence is the competitive fact.** OMB shipped 13 releases in a week.
   Muster's honest counter is verified slices with receipts, not matching
   their release count — but the backlog (channels in /app, Engines
   add-account, guided first run, tour pacing) is where they are visibly
   investing, so those slices stay the priority order.
3. **Watch the same three gaps the pinned audit listed** — they are still
   the ones the user feels first: guided setup-to-first-result, engine
   access breadth, and comparative probes (still unrun; comparative claims
   remain unverified).
4. **Unverified, do not repeat as fact**: whether OMB's VPS unattended work
   includes per-user isolation, and whether Vellum's integration tiles
   persist tokens server-side. Both need a source dive before any claim.

## Re-verification pointers

- OMB releases: `gh api repos/milind-soni/OpenMausBot/releases?per_page=6`
- Vellum stream: `gh api repos/vellum-ai/vellum-assistant/commits?per_page=8`
- Repo metadata: `gh api repos/<owner>/<repo> --jq '{pushed: .pushed_at,
  stars: .stargazers_count}'`
