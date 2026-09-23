# iphone-duo-skills → Muster integration study (2026-09-23)

Owner instruction: *"checkout https://github.com/mirzaaghazadeh/iphone-duo-skills —
use this skill, make Muster accordingly."*

Read-only study: the repo page, `README.md`, `LICENSE`, `package.json`, the full
`skills/` tree, one skill's complete `SKILL.md`, `reference/device-facts.md`, and the
`scripts/` and `reference/` directory listings were fetched from GitHub and read (no
guessing — every claim below traces to those fetches). Muster-side paths cited were
verified to exist in this working tree during this study. Format follows
[openmuse-integration-study.md](openmuse-integration-study.md) /
[tiptour-integration-study.md](tiptour-integration-study.md). **Status: research and
planning only.** No code changed, no tests run, no service started, no git command
run beyond a read-only `git status --short`. A future implementing agent executes ONLY
from this document.

**Honesty notes up front:**
- This repo contains **zero executable code** — no app, no Shortcuts, no iOS APIs, no
  agent harness, no duo/two-phone rig. It is nine prose skills + three reference
  sheets + one research script. Anyone expecting a working "iPhone Duo integration"
  as software must read §3 first: the genuine integration is *skill content* in the
  places Muster already mounts skill content.
- "Duo" is **the device** — Apple's foldable iPhone (announced 2026-09-09), not a
  two-phone setup. Their own accuracy caveat rides along everywhere: APIs were
  announced while Xcode 27.1 was rolling out, so names are "the *shape* of the API
  and confirm exact signatures against the SDK headers."
- Working-tree state at study time: the only modified files are `www/*` (4 files) and
  the untracked set `.commandcode/`, `.freebuff/`, `.zcode/`, `docs/research/glm/*`,
  `marketing-video/`, `www/fonts/`, `www/templates.html` — i.e. exactly the
  **excluded parallel-session set**. Everything cited in §4 (`server/`, `src/`,
  `skills/`) is clean today. Do not touch the excluded set.
- No security claims are made anywhere below; the owed full scanner re-run stands.

---

## 1. What iphone-duo-skills actually is (verified)

### 1.1 Purpose

Agent **skills for building iOS apps on Apple's first foldable iPhone** ("iPhone
Duo", announced September 9, 2026). Their README: Apple's developer material for the
device is six Tech Talk videos plus the *Designing for iPhone Duo* HIG page (Xcode
27.1 and the *Preparing your app for iPhone Duo* article "still listed as coming");
these skills "distill what exists into structured guidance an agent can act on, plus
reference sheets for device facts and the full API surface."

### 1.2 What a "skill" is in this repo's format

Exactly one shape, stated in their README under *Manual install*: **"Each skill is a
self-contained `SKILL.md` with YAML frontmatter, so it also works anywhere that reads
plain Markdown instructions."** Verified: `skills/iphone-duo-readiness/` contains
only `SKILL.md`. Frontmatter is two fields —

```yaml
---
name: iphone-duo-readiness
description: Audit and port an iOS app to iPhone Duo, Apple's first foldable iPhone. Use when asked to support, adapt, prepare, test, or review an app for iPhone Duo, ...
---
```

— followed by Markdown prose: checklists, decision tables, grep-target lists,
routing tables to sibling skills, a "Reporting back" section, and an "Accuracy
note". **No scripts inside any skill, no prompts-as-code, no tool definitions.** The
skills are distributed by the third-party `npx skills add
mirzaaghazadeh/iphone-duo-skills` CLI (detects Claude Code / Cursor / Copilot /
Gemini and drops the folders where each agent looks) or by manual copy — but the
format itself is harness-neutral plain Markdown, which is why it also works "anywhere
that reads plain Markdown instructions."

### 1.3 Real file layout (quoted from the repo page)

```
.github/
assets/          (iphone-duo-hero.webp, layout-model.svg)
reference/
  api-index.md     — every announced API by job, with framework and minimum SDK
  device-facts.md  — displays, silicon, cameras, poses, size-class table
  sources.md       — every source, linked
scripts/
  fetch-transcripts.py   — re-fetches Tech Talk transcripts from each video's HLS WebVTT track (how the repo was researched)
skills/
  iphone-duo-readiness/SKILL.md          (entry point; routes to the rest)
  iphone-duo-adaptive-layout/SKILL.md    (fold region, reserved regions, ArrangementView)
  iphone-duo-vertical-bars/SKILL.md      (toolbars/tab bars on the vertical axis, AxisBehavior)
  iphone-duo-hinge-and-scenes/SKILL.md   (hinge effects, Split View, scene accessories)
  iphone-duo-camera/SKILL.md             (virtual front camera, direction coordinator, mirroring)
  iphone-duo-design-review/SKILL.md      (framework-neutral critique: poses, side controls, asymmetry, fold avoidance)
  iphone-duo-games/SKILL.md              (Unity/Unreal/Godot/SpriteKit/Metal)
  iphone-duo-flutter/SKILL.md            (why MediaQuery.displayFeatures returns empty here)
  iphone-duo-react-native/SKILL.md       (no fold API; asymmetric insets + native bridge)
.gitignore
LICENSE
README.md
package.json     (name iphone-duo-skills, version 1.2.0, license MIT,
                  files: ["skills","reference","README.md","LICENSE"])
```

### 1.4 Workflows it encodes

- **Readiness audit (entry):** establish the SDK tier (pre-iOS 27 / 27 / **27.1** —
  "the gate"), open the Duo simulator in Device Hub, hunt fixed assumptions
  (`userInterfaceIdiom`, `isPad`, `interfaceOrientation`, `UIScreen.main`,
  symmetric inset math like `width - safeAreaInsets.left * 2`, hardcoded widths,
  hand-rolled bars) → adopt standard containers → four safe-area rules → route to a
  specialist skill.
- **Specialist passes:** adaptive layout (division vs occlusion, displacement, keep
  touch targets out of the curve), vertical bars (side controls, overflow/visibility
  priority), hinge & scenes (Split View, dual-display UI), camera (the two front
  cameras + the virtual-camera intersection problem), design review (critique
  checklist), plus stack-specific ports (games / Flutter / RN).
- **The core doctrine**, quoted: **"iPhone Duo is not a new idiom — it's a wider
  continuum of sizes."** Branch on size class / available space, never on
  orientation or idiom; three consequences — the inner display ignores supported
  interface orientations, `UIScreen.main` is ambiguous and slated for deprecation,
  safe areas are asymmetric.

### 1.5 Tech assumptions (what it does and does NOT assume)

- Assumes: an agent harness that reads `SKILL.md` + YAML frontmatter (they name
  Claude Code, Cursor, Copilot, Gemini); Xcode 27.1 / iOS 27.1 SDK for the APIs it
  describes; Apple's Tech Talks + HIG as the only sources (`reference/sources.md`).
- Does **not** assume: any runtime code, Shortcuts, iOS APIs being *called*, a
  second phone, a server, credentials, or a specific harness's tool system. It is
  pure guidance content.
- Accuracy posture (quote-worthy): "Nothing is invented — but most of these APIs
  were announced while Xcode 27.1 was still rolling out, so treat the names in this
  repo as the shape of the API and confirm exact signatures against the SDK headers
  before relying on a build." `reference/device-facts.md` even flags one unresolved
  discrepancy (HIG illustration shows *six* poses; prose names five) rather than
  papering over it.

---

## 2. License and attribution verdict

- **`LICENSE` = MIT License, "Copyright (c) 2026 Navid Mirzaaghazadeh"** (fetched
  verbatim; `package.json` `"license": "MIT"` agrees). The LICENSE file appends
  beyond the MIT text: a non-affiliation paragraph ("not affiliated with, endorsed
  by, or sponsored by Apple Inc." + Apple trademark list) and a provenance sentence
  ("All technical guidance here is original writing derived from Apple's publicly
  published developer material, which is linked in `reference/sources.md`").
- **Verdict: MIT → attribution header required for verbatim copies**, same rule
  Muster applies to openmuse/tiptour/laya/OpenMausBot. On any verbatim or
  near-verbatim reuse of their skill text, add a file-header comment:

  `Adapted from iphone-duo-skills (github.com/mirzaaghazadeh/iphone-duo-skills),
  MIT License, Copyright (c) 2026 Navid Mirzaaghazadeh.`

  Per AGENTS rules, **that github.com link is headers/docs only — never in
  user-facing UI.** Nuance specific to this pack: skill bodies are *mounted into bot
  system prompts* and can surface in transcripts, so inside the mounted text itself
  carry the short form `Adapted from iphone-duo-skills by Navid Mirzaaghazadeh, MIT
  License.` (name + license, no URL); the full SPDX-style line with the URL lives in
  the file header / this doc.
- If their Apple non-affiliation/trademark sentence is dropped from copied text,
  restate it wherever the guidance is redistributed as ours — we must never imply
  Apple affiliation or that the guidance is official Apple documentation.
- MIT is compatible with Muster's private BSL 1.1 repo; the copyright and permission
  notice must be retained in copies/substantial portions.
- Clean-room is **not** required (it would be, if unlicensed). Clean-room *is*
  required for anything not copied — Muster's own adaptations carry Muster's voice
  plus a provenance line.

---

## 3. "Make Muster accordingly" — the honest fit

Four candidate mappings were considered, per the owner brief. Verdict vocabulary:
**GENUINE** (real seam, real value), **SECONDARY** (real but bounded), **FORCED —
SAY NO.**

### 3.1 Mapping table

| # | Candidate mapping | Verdict | Grounding (verified paths) |
|---|---|---|---|
| 1 | **As bot skill/capability packages bots can be given** | **GENUINE — this is the integration** | Muster already *is* a SKILL.md platform: marketing says so (`www/switch.html`: "Bring your **Agent Skills (SKILL.md)** — Muster reads the same format"), the repo skill format is `skills/<name>/SKILL.md` with YAML frontmatter (precedent: `skills/mascot/SKILL.md`; format stated in `docs/plans/teach-replay-and-ios-folds-2026-09-16.md`), per-bot playbooks live at `<workspace>/skills/<name>.md` and ride the system prompt via `server/workspace-skills.ts` (`skillsSystemPrompt` — "appended, not substituted", 128 KB cap, filename gate `/^[\w][\w .()-]{0,79}\.md$/`), the team library ships `skills/**/SKILL.md` paths (`server/team-library.ts`, surfaced by `src/components/TeamLibraryPanel.tsx`), and `docs/plans/muster-store-spec-2026-09-14.md` packs `SOUL.md + skills/*/SKILL.md`. Their nine `SKILL.md` files drop into this machinery nearly as-is (names fit the gate, sizes are far under the cap). A bot doing iOS work for a human owner is exactly Muster's product; handing it this playbook is "make Muster accordingly" in the most literal, useful sense. |
| 2 | **As iOS/watch companion behaviors (`ios/`, `companion/`)** | **SECONDARY — mapped, deferred, verification-blocked** | The *content* is real guidance for Muster's own native surfaces (asymmetric insets, size-class branching, side controls). But: (a) no iPhone Duo hardware or Xcode 27.1/iOS 27.1 SDK is verifiable in this environment — claiming "Muster supports iPhone Duo" would be an unverifiable claim, and honesty over optimism; (b) `docs/plans/teach-replay-and-ios-folds-2026-09-16.md` **already contains a fold-aware iOS section** from the owner's earlier inputs — any fold work must read it first so two studies don't design rival fold strategies; (c) standing constraint: iOS work never changes bundle IDs, entitlements, or App Groups — layout-only; (d) the Watch (`ios/Watch/`) is not a Duo surface at all — nothing maps. Verdict: keep as a **map** in §4-S5 for a later stream, not a shippable slice now. |
| 3 | **As fleet tool definitions (`server/fleet-mcp.ts`, 11 bounded tools)** | **FORCED — SAY NO** | Skills are content, not bounded capabilities. The fleet MCP server's 11 tools are deliberately narrow (`send_task` the only writer; no approvals/deletes/credentials/engine/memory tools per the brief's bounded-by-design rule). Adding a "skills" tool is not implied by this repo (it has no API), would widen the write surface for zero gain (skills already have an HTTP path: `server/index.ts` ~L7534–7557 list/write), and the asymmetry IS the product. No. |
| 4 | **As engine-driver actions (`server/drivers/`)** | **FORCED — SAY NO** | Nothing in this repo is an engine action — no runtime, no API calls, no tool schema. Drivers execute model/provider turns; prose playbooks belong in the prompt layer. No. |

**Chosen mapping: #1 (bot skill/capability pack),** with #2 documented as deferred
map-only and #3/#4 explicitly rejected. The one genuinely interesting wrinkle in #1:
their skills use **relative cross-references** (`../../reference/device-facts.md`,
sibling-skill routing tables) that break when a file is imported standalone into
`<workspace>/skills/` — so the import must either vendor `reference/` beside the pack
or inline the device facts (see §4-S2).

### 3.2 What "accordingly" does NOT mean

Muster does not become a Duo app, a foldable simulator, or an iOS-app-building IDE.
Muster becomes the platform where a human's bot *carries this playbook* when the
human's task is iOS work. The skills append under persona and safety prompts and can
never outrank them (the `workspace-skills.ts` header contract — preserve it verbatim
in any change).

---

## 4. Ranked implementation slices (smallest-verifiable-first)

**Standing constraints — every slice, no exceptions:**
- Approvals stay human: `OptionCard`/`ApprovalCard`/`PendingApproval` + Watch
  one-tap (`ios/Watch/WatchViews.swift`) are the only actuators; these slices add
  **zero** execution paths — skills are appended prompt text only.
- Preserve mascots, route shells, saved choices, and user sessions untouched.
- Login/auth changes: none (any auth touch would have to be additive — not needed
  here).
- iOS: never change bundle IDs, entitlements, or App Groups. §4-S5 is map-only.
- No security claims. Credentials env-only (no credentials involved in any slice).
- Never touch or point anything at the demo server `127.0.0.1:8845`.
- Never surface `npx muster` or any github.com link in user-facing UI (headers/docs
  and short-form prompt attribution only, per §2).
- Per-slice attribution: every copied/adapted file carries the §2 header before any
  commit.
- Verification gate for every slice: `npx tsc --noEmit -p tsconfig.server.json` +
  the slice's own vitest loop while developing + one full `npx vitest run` before
  any commit, compared against the latest verified baseline at the end of the
  handoff ledger — report real numbers, note any decrease explicitly.
- `git status --short` review before staging (staging is not this subagent's job);
  do not sweep the excluded parallel-session set (`www/*`, `.commandcode/`,
  `.freebuff/`, `.zcode/`, `docs/research/glm/*`, `marketing-video/`, `www/fonts/`,
  `www/templates.html`) into any commit.

### S1 — Frontmatter-aware skill ingestion + one attributed fixture  ← **best first slice**
- **What:** teach `server/workspace-skills.ts` to parse the two-field YAML
  frontmatter `SKILL.md` files use: expose `description` on `SkillEntry` (additive
  field; today it is `{name, bytes}` only) and mount the **body** via
  `skillsSystemPrompt` without leaking the raw `---` block into the prompt. Keep
  every existing contract: filename gate, 128 KB cap, appended-not-substituted
  ordering, absent-dir → empty list.
- **Files:** `server/workspace-skills.ts`, `server/workspace-skills.test.ts`, new
  test fixture(s) — **one** of their `SKILL.md` files copied verbatim under
  `server/` test fixtures with the §2 attribution header. If `SkillEntry` crosses
  the wire in a schema, extend `server/contracts.ts` additively (verify during
  implementation; the route at `server/index.ts` ~L7534 returns it via `json()`).
- **Tests:** frontmatter present → `{name from frontmatter-or-filename, description,
  bytes}`; front absent (existing plain skills) → unchanged behavior — **every
  existing `workspace-skills.test.ts` case must stay green**; malformed/unclosed
  frontmatter → treated as plain body (fail open to today's behavior, never a
  throw); fixture body mounted with attribution line and without `---` fences;
  cap and traversal cases untouched.
- **Verification:** `npx vitest run server/workspace-skills.test.ts` → typecheck →
  lint → full suite pre-commit.
- **Attribution:** fixture file header per §2. No user-facing surface.
- **Conflict flags:** none — clean today; new fixture + focused edits only.

### S2 — Ship the nine-skill pack as a vendored, importable seed + one-action attach
- **What:** vendor the pack in-repo at a **new** directory (proposal:
  `skills-packs/iphone-duo/<skill>/SKILL.md` + `skills-packs/iphone-duo/reference/…`
  — deliberately *not* under `skills/`, which holds agent-behavior-for-this-codebase
  skills like `skills/mascot/SKILL.md`; polluting it would confuse what a repo skill
  means). Each vendored file keeps its YAML frontmatter and gains the §2 header.
  Resolve their relative references by vendoring `reference/` too (device-facts,
  api-index, sources) and rewriting only the `../../reference/` link lines —
  that makes each copy near-verbatim (attribution still required) and standalone-
  correct inside `<workspace>/skills/`. Add `server/skill-packs.ts` (+ test): a
  pack reader (bounded file count/size, name-gate re-checked before write) and a
  `seedSkills(botId, pack)` that reuses `writeSkill`. Additive route in
  `server/index.ts` next to the existing skills routes (~L7534–7557), e.g. import-
  one-named-pack into one bot — no new global surface, no auth change (uses the
  same owner-guarded pattern as the existing skills routes).
- **Files:** new `skills-packs/iphone-duo/**` (9 × SKILL.md + 3 reference md),
  new `server/skill-packs.ts` + `server/skill-packs.test.ts`, additive hunks in
  `server/index.ts`.
- **Tests:** pack read is pure/bounded (rejects a pack with a name that fails
  `isSkillName` before any write); seed is idempotent (re-import = replace, no
  duplicates); all nine land with description parsed (S1 machinery); size cap
  respected; route test patterned on the existing skills-route tests; **no network**
  in tests — the pack is vendored, tests never fetch GitHub.
- **Verification:** touched-file vitest → typecheck → lint → full suite.
- **Attribution:** §2 header on all 12 vendored files; Apple non-affiliation
  sentence retained; github.com URL only in headers/this doc.
- **Conflict flags:** none (`server/index.ts` clean today — keep hunks scoped to
  the skills-routes region).

### S3 — Skills surface with name/description (so the pack is visible, not invisible)
- **What:** during this study **no skills editor/list component was found under
  `src/`** (the HTTP API exists; `src/lib/agent-templates.ts`'s `skills:
  string[]` are display tags, not workspace skills — do not conflate them). Ship the
  smallest honest surface: list the bot's skills with frontmatter `description` +
  read/delete (write already exists via API), mounted on an unowned surface following
  `TeamLibraryPanel`'s existing mount pattern — **never** `SettingsModal.tsx` /
  `SettingsPrimitives.tsx` (desktop-parity stream's files per the tiptour study
  conflict table; re-verify `git status` before starting).
- **Files:** new `src/components/SkillsPanel.tsx` (+ colocated test patterned on
  `src/components/SeedOptionCard.test.ts`), mount point chosen during implementation
  by locating `TeamLibraryPanel`'s parent (do not restructure `src/App.tsx` route
  shells), `src/state/store.tsx` only if skill state must live there (prefer local).
- **Tests:** renders name+description from the S1 payload; delete confirmation stays
  destructive-action-gated; empty state honest; mascot/route-shell snapshots
  unchanged.
- **Verification:** component tests → typecheck → lint → full suite.
- **Attribution:** none needed (no copied text rendered); if any vendored skill
  title/description renders in UI, render it **without** the github.com URL.
- **Conflict flags:** 🟡 settings-owned files — stay off; `src/state/store.tsx` hot.

### S4 — `iphone-duo-design-review` adapted as a bot playbook for narrow/outer-width review of Muster's own surfaces — SECONDARY, owner-gate recommended
- **What:** their design-review skill is framework-neutral (poses, side controls,
  asymmetry, fold avoidance). A **clean-room adaptation** (Muster's voice, §2
  provenance line) turned into one per-bot skill that a review bot can be given when
  checking Muster's responsive web at outer-display widths (5.4") and Split-View-like
  narrow contexts. Hard scope from AGENTS.md: **audits fix reproduced defects — this
  skill must not become a redesign license.** Findings arrive as ordinary bot output
  (or an OptionCard when a consequential fix is proposed), never as autonomous UI
  edits.
- **Files:** one new adapted skill file under the S2 pack directory or seeded per-
  bot only (owner call on whether it ships in the repo pack); no component edits.
- **Tests:** if shipped in the pack, it rides S2's pack tests; content itself is
  prose — verified by the S1/S2 mount tests, not by snapshotting wording.
- **Verification:** as S2; any resulting defect-fix work is a separate, reproduced-
  defect slice under the stability contract.
- **Attribution:** adaptation, not copy — provenance line, no verbatim paragraphs.
- **Conflict flags:** none.

### S5 — iPhone Duo fold-readiness of `ios/**` — **MAP ONLY, NOT SCHEDULED**
- **What (when unblocked):** layout-only adoption of the readiness/adaptive-layout/
  vertical-bars rules in `ios/Sources/CompanionCore/**` and the app shell: size-class
  branching over orientation, per-edge safe-area handling, no symmetric inset math.
- **Blocked on:** (a) an environment with Xcode 27.1 + the iPhone Duo simulator (none
  here — pose-dependent bugs "are not statically decidable" by their own skill's
  reporting rule); (b) reading
  `docs/plans/teach-replay-and-ios-folds-2026-09-16.md`'s existing fold-aware iOS
  section first and reconciling with it; (c) the iOS stream's ownership — zero edits
  under `ios/**` until then, and when done: bundle IDs, entitlements, App Groups
  untouched; (d) `ios/Watch/**` excluded outright (not a Duo surface).
- **Constraint echo:** no "supports iPhone Duo" claim in any UI, README, or `www/`
  copy until a real device/simulator run produced evidence — and `www/*` is in the
  excluded set anyway.

**Deferred/side notes:** the third-party `npx skills add` distribution and their
`package.json` publish metadata are *their* channel — Muster's channels are the
skills HTTP API, the team library, and the store spec (§5). `scripts/fetch-transcripts.py`
is research tooling for maintaining their repo, not Muster's (§5).

---

## 5. What NOT to do (scope guardrails)

1. **Do not import a harness.** The repo assumes an external agent harness (Claude
   Code / Cursor / Copilot / Gemini) only for *installation convenience*. Muster's
   replacement for that whole layer is its existing skills system:
   `server/workspace-skills.ts` + routes in `server/index.ts` (+ later the store /
   team library). Never add `npx skills add …` to Muster docs, scripts, or UI —
   it is a third-party installer Muster does not have, and Muster's own package-name
   rule (`npx muster` squatter) makes npx-install guidance in UI doubly wrong.
2. **Do not add fleet-MCP or driver surface for this** (§3 rows 3–4). The 11 bounded
   tools stay 11; `send_task` stays the only writer; skills already have their own
   owner-guarded HTTP path.
3. **Do not claim Duo support anywhere** — not in ios/, not in `www/` (excluded set
   anyway), not in release notes — without a verified device/simulator run. Their
   own accuracy posture ("shape of the API, confirm against SDK headers") must be
   preserved inside any vendored/adapted text; do not sharpen their hedged API names
   into confident Muster claims.
4. **Do not vendor `scripts/fetch-transcripts.py`, `.github/`, assets, or their
   `package.json`.** The transcript script is how *they* maintain *their* repo
   (HLS/WebVTT fetching, Python — not Muster's toolchain); hero images and diagrams
   are their marketing assets with an Apple-image copyright note — out of scope
   entirely.
5. **Do not redesign `skills/` semantics or the mascot skill.** Repo `skills/` =
   agent-behavior for working on Muster (`skills/mascot/SKILL.md`); the pack gets
   its own directory (S2). Do not weaken the `workspace-skills.ts` contract:
   skills append after persona/safety prompts and never outrank them.
6. **Do not let a skill become an execution path.** No auto-approve, no new
   `autoDecision` categories, no bypass of OptionCard/Watch — a skill that proposes
   consequential action produces a card like everything else.
7. **Do not touch the excluded parallel-session set** (`www/*`, `.commandcode/`,
   `.freebuff/`, `.zcode/`, `docs/research/glm/*`, `marketing-video/`,
   `www/fonts/`, `www/templates.html`), **`docs/plans/ceo-log.md` or
   `docs/plans/current-state.md` (owner-only)**, **the demo server
   `127.0.0.1:8845`**, and **no mutating git** from this stream's plan.
8. **No security claims, no deployment claims** ride along with any slice; a push is
   not a receipt; credentials env-only (none needed here).

---

## 6. The 5-step eval (style of astra-gpt6-mvp-brief §4)

Runnable after S1+S2 land; record real evidence, score honestly:

1. **Seed:** import the vendored pack into a test bot (`seedSkills` or the S2 route)
   → expect **9/9** skills listed, each with `name` + `description` parsed from
   frontmatter, every file carrying the §2 attribution header (grep the workspace,
   not the UI).
2. **Mount hygiene:** read `skillsSystemPrompt(bot)` output → expect bodies present,
   **no raw `---` frontmatter fences**, attribution short-form present, relative
   `../../reference/` links either resolved (vendored) or inlined — and persona/
   safety prompt ordering byte-identical to before (skills appended, not
   substituted); total skill bytes under the 128 KB per-file cap each.
3. **Task probe (completion):** `send_task` a real "audit this iOS app for iPhone
   Duo readiness" task → expect `wait_for_conversation` → `settled` with a reply
   that visibly follows the skill's workflow (SDK tier stated, fixed-assumption hunt
   with `file:line` findings, routing to the right specialist) — evidence the pack
   actually rode the prompt.
4. **Escalation probe (the differentiator):** task that proposes a consequential
   action (e.g. apply a fix to a real repo) → expect `needs-user` with card title +
   options relayed verbatim and the decision made by a human on card or Watch —
   **skills must not have changed this in any way**; confirm via
   `get_approval_history`.
5. **Score:** import correctness (9/9), mount hygiene (step 2 booleans), task
   completion, escalation correctness, attribution completeness (12/12 files), and
   tokens/cost per task vs. the same task without the pack (the pack should cost
   prompt budget, not correctness). Then one full `npx vitest run` against the
   latest handoff-ledger baseline — report the real numbers or the eval itself fails.

---

*Written by the research/planning subagent (read-only pass): source fetched from
GitHub 2026-09-23 (repo page, README, LICENSE, package.json, skills tree, one full
SKILL.md, device-facts.md, reference/scripts listings). No tests executed, no
services started, no existing file modified other than this document. No git
command run beyond read-only `git status --short`.*
