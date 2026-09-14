# Landing redesign spec — copy the benchmark's marketing DNA (14 September 2026)

Produced by a read-only study of the benchmark repo (`/tmp/omb-study`, the product is never named
in repo docs per owner rule) against `www/index.html`, `www/download.html`, `www/docs/`.
Three implementable slices; tone rules and token deltas are concrete enough to code from.

## Tone rules extracted (evidence)

Name the thing, say what it does, no intensifiers, admit limits, state who you are not:
- "Every bot in the sidebar is a real agent … Talk to them like contacts. Watch them work.
  Approve what matters." (`README.md:11-13`)
- "Each bot … runs on your own machine, with its own model, memory, and personality." (`en.json:813`)
- "Allow or deny. Nothing risky runs without you." (`en.json:807`)
- "Optional, and only ever used when you ask for the feature." (permission framing, `en.json:780`)
- "Local-first does not mean risk-free." (`docs/content/docs/security/index.mdx:5`)
- "Changes merged into main after a release are not listed as shipped." (`changelog/index.mdx:9`)
Scene titles are short declaratives: "Every chat is a real agent" / "They have hands" /
"Set it and forget it" / "Put bots in a room" (`en.json:809-823`).

## Blueprint (section order)

1. **Hero, download-first**: kicker `Local-first agent workforce`; keep H1; lead =
   "Every bot you hire is a real agent on your machine — running on the model you already pay
   for, with its own name, memory, and a Linux desktop it drives. Talk to them like contacts.
   Watch them work. Approve what matters."; primary CTA = detected-OS
   `Download for macOS (Apple silicon) — v<live from /downloads/latest.json>` (port the
   detection + fetch from `download.html:313-379`), other platforms as a link line, ghost
   `Open the web app`; 3-tile trust strip (`Runs on your machine` / `Your own models` /
   `Self-host free`); real screenshot in a `.shot-frame` with factual caption; the six flowers
   move to a small labeled team strip above the shot.
2. **Scenes gallery** (absorbs #features + #ecosystem): six scenes, one real screenshot each —
   real agent / hands / connected apps / rooms / routines / terminal (copy in §Tone above;
   reuse the existing `muster up` term block). Keep the 8 "real jobs" cards as a compact
   secondary strip `Real jobs, on a schedule`.
3. **How the pieces fit** — two tables, zero adjectives: (Piece | What it does | Where you set
   it up: Bot, Engine, Computer, Approvals, Routines) + (Choose your path → deep-links into the
   existing www/docs pages).
4. **Trust, one section**: `What runs where` boundaries (loopback harness; configured-or-not
   flags, keys stay in ~/.muster; approval cards; Privacy Shield deterministic masking +
   counts-only receipt; default-deny device allowlist) + `Your responsibility` duties. Keep the
   interactive approval simulator; relabel with "Allow or deny. Nothing risky runs without you."
   Honesty callout: "This page describes shipped releases."
5. **Pricing**: keep; copy deltas — "Bots are free and unlimited on every plan. The metered
   unit is the cloud computer."; footnote adds "no trial to cancel, no seat license, export
   anytime".
6. **Releases band**: newest-first rows `vX — date — N changes — .dmg .exe — checksums` from a
   `/downloads/releases.json` (same consumption pattern as latest.json). Replaces the abstract
   stats band.
7. **FAQ**: keep six; add "Do you train on my data or sell it?" (No … masked transcript only,
   on your keys) and "Does the unsigned build phone home?" (No license keys; update check is a
   static latest.json fetch; macOS right-click→Open steps on the download page).
8. **CTA band** `Meet your first bot` + footer restructure (Docs · Changelog · [Download]
   primary · Security & license · Privacy · Terms · Teams).

## Visual token deltas (rewrite `:root` on all three pages)

- Ladder: `--app:#0a0a0a --panel:#131314 --inset:#18181a --card:#1e1e21 --raised:#2a2a2e
  --raised-hover:#343438`; ink `#f6f6f7`, secondary = ink@60%; `--hairline:#4a4a4e` painted at
  40% alpha (`--hairline-paint`) — borders never lift, they brighten on hover.
- Accent stays brand `#f0460e` (+ `--accent-border:#ff7a45`, `--accent-wash`); verify
  white-on-accent AA at 16px/600 — darken fill to `#c93a0b` if it fails. Marketing accent may
  differ from app accent (precedent: the benchmark's green docs vs blue app).
- Radii: rows/inputs/buttons 8px; cards 12px; frames 20px; pills 999px.
- Type: real Inter (self-hosted woff2), body `-0.012em`, h2 `-0.035em`, lede 17-18px/1.6 cap
  46rem, kicker 11.5px/700/.12em uppercase.
- Motion: one curve `cubic-bezier(0.22,1,0.36,1)`; 120-240ms; entrance "never from zero"
  (10px rise + fade, 40ms sibling stagger); per-class reduced-motion opt-outs replace the
  blanket `*` rule; delete every `translateY` hover lift and glow shadow; framed shots get
  `0 1px 1px ink/5%, 0 22px 60px ink/10%`.
- Section rhythm 96px desktop / 64-72 mobile; card gaps 16; inner padding 24;
  `::selection` accent@24%; one top radial accent wash ≤8% (promote the docs treatment).

## Slices

- **L1 Foundation**: tokens + Inter + control styling on index/download/docs.css; border/radius/
  shadow/hover sweeps (line lists in the study: index `:152,170,180,192,200-223,290,309,313-337,
  350,357,383,423,447-450,459,470,514-517,1438`; download `:10-27,83,94-108,128,140,153,161`;
  docs.css `:4-22,65,105-125,167-171,189,232,254,283,288-292,309,314,324,332,358`).
  Exit: renders clean, zero layout shift, no translateY in hovers.
- **L2 Hero + trust strip + download band**: hero restructure per §1, stat-row, shot-frame,
  detected-OS primary with live version. Exit: first viewport communicates download+version+
  your-machine without scrolling.
- **L3 Sections**: scenes gallery, two tables, merged trust section, releases band, FAQ adds,
  footer; move `#compare` to `switch.html`; docs hub gets kicker+stats+screenshot. Exit: DOM
  order matches blueprint; screenshot set is a closed JS list so a missing PNG fails loudly.
