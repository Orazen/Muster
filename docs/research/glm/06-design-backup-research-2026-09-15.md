# Design & backup research — 2026-09-15 (subagent reports, condensed)

Own research notes (docs/research/glm/ family). Sources: benchmark app repo
study, astryx.atmeta.com, ui.heygaia.io. Polsia.com study did NOT complete
(fetches returned little; site likely JS-heavy) — re-run if the landing
redesign needs it.

## 1. Benchmark app backup/restore (repo study, cited in-session)

Three mechanisms, all local-file artifacts the user moves themselves:

**Workspace backup** (`server/workspace-bundle-v2.ts` era equivalent — their
`workspace-backup.ts`, 1376 lines): full DATA_DIR tree minus an EXCLUDED
name set; `messages.db` captured via sqlite `backup()` so WAL folds in;
`config.json` filtered to a PORTABLE ALLOWLIST (profile/language/budgets/
rooms/threads/localVm/features/browserProfiles) — connection/API-key
sections NEVER enter the archive; webhooks.json loses `secretHash`; client
localStorage prefs ride as an exact-key allowlist ≤2 MB. Container:
MAGIC header + salt + IV || AES-256-GCM(gzip+tar) || tag; scrypt N=131072;
password-only key, no escrow; 10 GB / 100k entry limits; 0700/0600, symlinks
rejected, external-file-changed aborts.

**Restore = full replace, staged, boot-apply, crash-atomic**: upload →
preview (`stageWorkspaceBackup`: DECRYPT-AUTHENTICATE WHOLE FILE before any
parse; gzip rejected post-auth to defuse decompression bombs; tar header
validation: no `\`, no `..`, device names, case-fold dups; triple
cross-validation archive↔manifest↔staged↔counts; newer-version refused by
semver) → restore requires literal "REPLACE" → `pending-restore.json` under
exclusive lock → APPLIED AT BOOT before config/store load with path-rebase
of cwd fields, connection config kept from destination, routines force-
disabled, webhooks disabled + secrets rotated, calendar nextRunAt nulled,
delegations emptied, followups interrupted → rename-only swap with
restore-journal phases; rollback never deletes; `last-restore.json` receipt
feeds a post-restart client-state pickup.

**Team backup** = plain JSON, additive import with fresh IDs, memory
scrubbed via redactSecretsInText on export, whole-graph validation before
any write, synchronous rollback deletes only this import's records.

**Checkpoints** = per-bot shadow git under DATA_DIR/checkpoints (Cline
pattern), massive excludes, refuses home/Desktop/Documents, best-effort
(never throws into a turn).

### Patterns we ADOPTED in Loop 98 (Muster v2 wiring)
1. Boot-time apply before Store construction (Muster: `applyPendingRestore`
   in server/index.ts before `new Store`) — the live process never races
   the swap. ✔ shipped
2. De-weaponize on restore: routines disabled + nextRunAt nulled, goals
   stopped. ✔ shipped (server/restore-apply.ts)
3. Skipped-file honesty in the manifest (their EXCLUSION_NOTES) — v2 already
   records `skipped[]`; our UI shows counts + the list travels in the export
   response. ✔
4. Credential policy = path denylist + portable allowlist, never secret-
   scanning. ✔ (v2 subset roots: bots/groups/memory + routines/goals/
   decisions/social; keys/config/auth.db excluded)
5. WAL discipline: their sqlite `backup()` capture (v2 export already uses
   VACUUM INTO snapshot) + our boot-side `wal_checkpoint(TRUNCATE)` of the
   DESTINATION before the swap (found live in E2E: stale sidecars from a
   killed process made commit refuse — now checkpointed, refusal reported
   honestly via receipt.blocked). ✔

### Patterns deliberately SKIPPED
- Password-only key with no recovery kit (their flaw; ours is the same by
  design for now — flag: a recovery-code slice would beat them).
- Two-phase pending + restart (we adopted the boot-apply but kept staging
  outside DATA_DIR per our v2 guard).
- Attachment-path rewriting in transcripts (complexity), uncompressed tar,
  in-memory session artifact maps, case-fold hard rejection.

## 2. Astryx (Meta design system, MIT, v0.6.x) — chat UI rules worth keeping

- Surfaces: body → surface → card → popover; elevation encodes stacking
  ONLY (exactly one level per floating surface; flat otherwise); composer
  is the one raised-by-default surface, and flattening it must keep
  input-grade rest/hover/focus borders.
- Focus/selection via INSET shadows (`--shadow-inset-hover/-selected/...`)
  — survives rounded glass where outline rings break. (Muster follow-up.)
- Radii: element 12 / container 16 / page 32 / **chat 28**; concentric rule
  inner = max(0, outer − padding).
- Spacing 4px scale with 2/4/6 internal steps; type 14px × 1.2 geometric;
  metadata at xs/sm secondary color; rows+dividers for lists, Card only
  for widgets; Badge only for counts, StatusDot for status.
- Motion: 130–230ms fast / 310–550 medium / 730+ slow; ONE easing
  cubic-bezier(.24,1,.4,1); entrances animate, exits of transient UI are
  instant; NO animation on high-frequency hovers; contextual UI grows from
  its trigger. ✔ partially adopted (sidebar density + menu-pop, commit
  e5be8e0). Remaining: inset focus rings, chat radius token, message-row
  hover zero-animation audit.
- AvatarGroup + overflow + StatusDot = multi-agent roster primitive.

## 3. GAIA UI (ui.heygaia.io, shadcn registry, MIT) — component picks

HIGH for chat: message-bubble (grouping+tails), composer (attachments/
auto-grow), tool-calls-section (expandable agent calls), slash-command-
dropdown, code-block, file-dropzone+file-preview, wave-spinner (streaming
motif). MEDIUM: link-preview, author-tooltip, notification-card,
weather/todo/calendar-card as AGENT REPLY CARD templates, pricing-card
(glass), footer-glow, holo-card. SKIP: charts, nav menus, raised-button,
iphone-mockup. StyleX-free (Tailwind+Radix), copy-paste via
`npx shadcn add https://ui.heygaia.io/r/<name>.json` — but their aesthetic
is light-glass/iOS; adopt structure, restyle to Muster tokens.

## 4. Open gaps the benchmark study exposed (queued)
- Sidebar: drag-reorder sections, threads nested under each bot row,
  attention badges beyond counts (we shipped density+sections+dots 09-15).
- Transcript folding: reversible narration runs (tool-run grouping exists).
- Chat-header container-query collapse at narrow widths.
- Composer takeover for pending approvals + failed-send retry glyph.
- Usage ledger + per-bot approval levels (roadmap unchanged).

## 5. Benchmark mascot mechanics (avatar study, 2026-09-15)

Procedural SVG engine (~1585 lines, rAF + imperative setAttribute — React state
never updates during animation; zero animation assets):
- 39 states, each a triple: **expression pool + cadence** (idle drifts among
  3 faces every 9–16s, thinking among 5 every 2–3.6s; spring morph, stiffness
  7 overshoot), **blink** (per-state random interval 6–14s, never for
  sleeping/alerting; 320ms fast-close), **body motion** (sine bob/sway/pulse/
  squash table; working = 2.5u bob @900ms with ground-pivot squash).
- 25-expression face data = 48-point eye-ring pairs + 4-number mouth spec;
  10 interchangeable silhouettes share the identical face ("one character in
  different bodies").
- `stateForBot`: failed activity→alerting, busy→working, unread→notifying,
  options→curious, else keyword-derived resting personality (dev→working,
  research→searching…). One-shot event motions (switch spin, arrive scale-in,
  success/failure, celebrate, surprise, per-stream blink) borrow a face
  ~1.4s then hand back.
- Presence dot deliberately separate from the face (green/amber/grey ring).
- **Cost discipline**: sidebar avatars animate ONLY when busy||unread||motion;
  resting rows are one static frame, 4Hz wake-poll (comment: idle 60fps faces
  were most of the app's idle CPU). Turn-tail: mascot scales in beside a
  shimmer label + self-ticking timer (0.38s cubic-bezier(.16,1,.3,1)), the
  answer grows from its edge.

ADOPTED in Loop 102 (e5be8e0+): turn-tail mascot in ChatView (face + shimmer +
timer, scale-in), resting-row static gate (`animated={selected||busy||unread||
motion}`), threads-under-bot tree (attention-first, capped 4, "+N more",
peer-name label for 2-member rooms). Patterns still open: expression-pool
cadence table, spring morphs, glyph-morph states, 10-silhouette body set.

## 6. beUI (beui.dev) — MIT, Motion + Tailwind v4, shadcn registry
`npx shadcn add @beui/<slug>` (no npm pkg; raw source at /r/{slug}/raw; MCP
server mcp.beui.dev). HIGH-value picks for Muster: message-scroller
(reader-aware follow/release — the classic chat UX bug, solved), prompt-input
(auto-grow + send↔stop morph + model select), approval-card + tool-allow-once/
remember/deny (near 1:1 with ours), agent-activity + loading-states + todo-list
(workforce status stream), animated-sidebar/ai-sidebar (rail collapse),
animated-toast-stack, command-palette, dynamic-island (in-call indicator),
tabs/switch/select/input/checkbox (settings surfaces, token-matched). Codified
motion system: shared lib/ease tokens + per-component reduced-motion. SKIP:
charts, wallet/crypto blocks, tilt-card, marquee, dock. Adopt as patterns +
selective source, restyled to glass tokens; `motion` dep not yet in package.json
— any adoption slice must budget for it.

## 7. Polsia (polsia.com) — verified via bundle extraction (site is SPA)
Autonomous-AI-company platform (Claude Agent SDK; agents run daily business
cycles; $29–59/mo). Design DNA: editorial-print, NOT SaaS — Didone display
serif (weight 400, tight leading) + Suisse Mono uppercase micro-labels, pure
black/white + ONE deep-orange accent, radius 0–2px hairlines, landing = 4
full-viewport manifesto slides with dot indicators, and the signature device:
a fixed black terminal strip streaming fake live agent logs (>Deploying
campaign…) under a pulsing-dot orange announcement bar. Ranked Muster-landing
transfers: (1) live agent-log terminal strip (authentic for us — real fleet),
(2) manifesto slides over feature lists, (3) serif+mono pairing on dark glass,
(4) honesty microcopy under every CTA, (5) pulsing-dot banner, (6) one
narrative hero visual, (7) newspaper caption strips, (8) staggered fade-block
reveals. Polsia itself is light-dominant — the transfer is the typography +
terminal theater, which reads STRONGER on dark. Unverified: slide auto-advance,
plan names, slide images.
