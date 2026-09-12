# Fleet-desktop benchmark pass — 2026-09-12

Field study of the leading open-source agent-fleet desktop (installed DMG, v0.1.74,
plus its public repo main — 370+ agent-authored branches, releases through v0.1.75),
its iOS companion (built from source to a simulator), and its docs tree, read
end-to-end. Purpose: steal what works, note what we already beat, and queue
bounded Muster slices. The benchmark product is referenced below only as "the
benchmark app".

## What the benchmark app does better today

1. **Threads as first-class navigation.** Bots own parallel conversation threads
   (default 3 concurrent, 1–10 configurable), organized in folders under each bot;
   the sidebar is a quiet tree (quiet headings, indented thread rows, chevrons
   separate expand from select, drag-reorder, three densities, "Show threads"
   toggle with an "Other activity" fallback). "#Title" replies render as links that
   open the thread; sidebar labels read "opened by Scout". A "Worked for 22m 57s"
   collapsible run-summary pill sits under the turn it describes; Inspector hosts
   Run Log / Events / Raw with a copy-redacted action.
2. **Approval levels per bot** — the provider's own permission modes passed
   through (Ask / auto-accept edits / approve-for-me / full / provider custom),
   never an app-side re-implementation; delegation uses the receiving bot's level.
   AskUserQuestion-style cards answer with the model's own options, not Allow/Deny.
3. **Memory surface** — per-bot memory editor with a capacity gauge ("260 lines
   saved, 200 load into every conversation — 60 lines are not being loaded"),
   entries carry a date + source, a change journal outside the workspace with
   per-row Undo, conflict copy ("Scout changed this file while you were editing")
   with Reload / Overwrite-with-mine, and Open-in-Obsidian / Show-in-Finder on the
   server machine. Delete is never offered for MEMORY.md.
4. **Onboarding in three layers** — a morphing welcome card (beats: hello, reel,
   engines, permissions, phone, meet-your-bot), a six-scene code-drawn feature reel
   ("no media to ship, every skin gets the same picture"), and a guided tour that
   spotlights the LIVE interface via data-tour anchors ("it opens the Tools menu,
   points at the item, and closes what it opened"). Plus a first-conversation tour
   that explains the first approval card when it actually appears. All skippable,
   replayable from Settings, never on remote clients.
5. **Settings: 11 searchable sections** (General / Appearance / Experimental /
   Connections / Engines / Companion / Computer / Usage / People / Backups /
   Workspaces), two-column at 1280px, section-dropdown at 390px.
6. **Usage ledger** — durable history with grouping, export, "who asked", monthly
   spend limit, sell prices (entitlement-gated); cached tokens on a dimmed second
   line ("cache reads are re-read context, billed at a fraction of input").
7. **People & fleet** — invite links with roles + last seen + monthly spend;
   many client workspaces per server; white-label on hosted servers.
8. **Notification policy as a designed contract** — "proactivity is an explicit
   trigger, not a hidden heartbeat"; four notification kinds only (needs approval /
   needs your hands / finished with non-empty result / routine failed); a click
   must select the bot AND switch to that exact task.
9. **Voice register** — a "speech-text" style guide ("says the prose, names the
   artifacts, drops the syntax"), spoken activity chips, spoken yes/no approvals
   with "consent must never be inferred from a sentence that merely contained the
   word 'sure'".
10. **Small delights** — keyboard-shortcut cheat-sheet modal; Daylight light skin
    sampled like Midnight; markdown upgrades (raw toggle, code-block headers with
    language + line count, download-snippet-as-file); composer tray chips
    (working folder + tools above the input); avatar-only roster density; chat
    presence animation; run logs for routines with list + calendar views and
    results routed to a dedicated thread.

## iOS companion notes (built from source to a simulator)

Single-roster, messages-shaped app — no tab bar. Route machine: welcome → pairing →
unpairedHome → notificationPrompt → chats → revoked. Sidebar sections (Pinned /
Groups as channel tiles / Bot threads strip / Bots / user-named sections) with a
floating bottom bar (Updates pill, search, gated "+" menu). A bot waiting on you
"grows out of the island" (NeedsYouIsland). Phone-owned thread selection per bot;
thread tree with folders on the phone; share extension (share-to-bot); admin-gated
VNC "Open live cloud desktop"; Live Activities. Light-mode welcome sells three
value props (chats in your pocket / respond when a bot needs you / private by
design) above one primary CTA.

## How they build (process worth copying)

- **Verification as a product**: one control CLI launches an isolated child with a
  temp data dir + fake engine ("Mutating commands refuse silent port discovery"),
  drives the REAL renderer headlessly by accessibility name, and every recipe ends
  with "what this proves, and what it does not". "A green unit test alone does not
  prove a user workflow."
- **Plans as executable checklists** for subagent workers (TDD red/green per task,
  commit after every task), with global constraints restated in every plan: a test
  floor that only rises, secrets write-only (UI sees a `configured` boolean),
  0600 atomic writes, "imports land disabled", "never offer a control a driver
  cannot mount", the two-transcript rule.
- **Agent-authored branch taxonomy**: ~203 `codex/*` cloud-task branches, 88
  `feat/*`, release branches per version, PR-squash merges by the maintainer,
  commits co-authored by coding agents; oxlint anti-slop with `--deny-warnings` in
  required CI; a CI job that deletes the enterprise folder and proves the open
  source build still boots.

## Where Muster is already ahead

- Signed job receipts with verification endpoint; approval cards with evidence +
  why-journal + approval history; per-role benchmark harness (`muster bench`).
- Memory history + rollback with origin attribution (this week); SOUL.md
  export/import; login-scoped Drive backup.
- Durable storage (durability-first write ordering, failure-injection tests).
- Glass design system with three skins; MusterBloom/flower mascot identity
  generated from one geometry into every asset; ⌘K CommandBar; hi.new agent mail;
  Goal mode with bounded rounds; docs site; fleet MCP server.

## Queued Muster slices (ranked, bounded)

1. **Memory capacity honesty** (shipped this pass): surface lines/bytes vs the
   load budget in the memory card with a plain-sentence gauge.
2. **Keyboard shortcut cheat sheet** (shipped this pass): "?" / ⌘/ sheet listing
   the real bindings (⌘K, ⌘N, ⌘1–9, ⌘⇧[/], ⌘F, Esc, Enter/⇧Enter).
3. **Sidebar sections + density** — Pinned / Groups / Bots with user-named
   sections and a compact density toggle; drag-reorder later.
4. **Run-summary pill** — after each turn, a collapsible "Worked for Nm · N tools
   · N verified" line under the turn, feeding the existing receipts.
5. **Usage ledger** — durable per-turn history with who-asked + export + monthly
   spend limit (builds on existing botUsage).
6. **Approval levels per bot** — map onto our drivers' native permission modes;
   delegation keeps the receiver's level.
7. **Guided tour v2** — spotlight layer over the LIVE UI via data-tour anchors +
   Settings replay + first-approval-card hint (our Loop 53 tour already has the
   mock-panel layer).
8. **Threads organization** — folders under a bot's tasks + "#title" links between
   threads + phone-owned selection parity in iOS.
9. **Show-in-Finder / Open-in-editor** for workspace files on the desktop.
10. **Notification contract** — reduce kinds to the four, guarantee click→bot+task,
    adopt the "explicit trigger, not a hidden heartbeat" copy.
