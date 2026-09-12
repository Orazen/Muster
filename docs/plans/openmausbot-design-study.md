# OpenMausBot UI study — implications for Muster

**Current source audit: 2026-09-10, v0.1.70**, commit
[`67336fb2d7139de1b91a8050d9c1ca1215844fea`](https://github.com/milind-soni/OpenMausBot/commit/67336fb2d7139de1b91a8050d9c1ca1215844fea)
(2026-09-10 04:13:31 +05:30). This was a read-only review of a shallow
checkout of that public snapshot. **0 executable competitor tests and 0
competitor runtime checks** were run. Source indicates implemented behavior;
it does not prove that behavior works end to end on every device.

The original 2026-09-07 study used v0.1.60 and its `docs/screenshots/` set;
a 2026-09-09 pass referenced v0.1.69. The current findings supersede the
older conclusions below, rather than treating those conclusions as verified
advantages. This audit does not date when each capability was introduced.
See [competitive-landscape.md](competitive-landscape.md) for the product
comparison and measurement standard.

## Corrections to the earlier comparison

- **OpenMausBot is a fleet product.** Its current README describes a roster
  of bots with separate models and channels. "One agent in one window" was
  an incorrect blanket description.
- **Mobile approvals exist in source.** The iOS roster routes needs-you
  updates into the relevant chat; Android has native pairing/navigation
  code. An absence-of-mobile claim is unsupported.
- **Receipts exist in source.** Delegation receipts and routine execution
  cards are present. Their exact semantics should be benchmarked against
  Muster's task receipts, not described as absent.
- **Visual identity is not an exclusive capability.** Earlier screenshots
  showed a flat dark desktop shell. Current iOS source has glass surfaces
  and platform-specific presentation. "Glass vs flat" is not a reliable
  product-wide distinction, and the old claim of zero GPU compositing cost
  had no measurement behind it.
- **Computer presentation has evolved.** Current code includes local VM
  workspaces and remote desktop panels. The old "external browser handoff
  only" description is not a current architecture comparison.
- **Do not infer lack of memory from the old screenshots.** That study did
  not establish absence of memory functionality. Muster's memory and
  why-journal still deserve a useful, discoverable surface.

Sources: [README](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/README.md),
[iOS roster](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/ios/App/ChatListView.swift),
[Android root](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/android/app/src/main/kotlin/com/openmausbot/companion/ui/RootScreen.kt),
[delegation receipt tests](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/server/delegations.test.ts),
[application shell](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/App.tsx).

## Current source-grounded interaction patterns

### Conversation layout and controls

The desktop/web shell retains a roster, conversation, and optional work
panels. Its chat header uses a named container query so controls can compact
when the **chat column** narrows, including when a panel is open. Long user
messages can collapse; tool steps can group into expandable activity runs;
transcript rendering is windowed. The scroll logic explicitly handles touch
and suspends following when the user reads earlier content. Tool visibility
is configurable, while live approval cards have their own rendering path.

Sources: [ChatView](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/ChatView.tsx),
[ActivityRun](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/ActivityRun.tsx).

### Task and approval state

Roster activity considers sibling tasks, not only the currently selected
conversation. Waiting, working, queued, and unread tasks remain reachable
when the normal thread tree is hidden. A compact activity selector above
chat provides the same escape hatch when the mobile drawer is closed.
Approval asks are distinguished from the onboarding question card; talking
past the introductory quiz hides that quiz without hiding live asks.

Sources: [SidebarBotActivity](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/SidebarBotActivity.tsx),
[TaskPicker](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/TaskPicker.tsx),
[OptionCard](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/OptionCard.tsx),
[ApprovalCard](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/ApprovalCard.tsx).

### Mobile navigation

Web uses a drawer that closes when the selected conversation or thread
changes. The native iOS roster uses a navigation stack, scrolling content,
a bottom action bar, and clearance beneath the final row so that bar does
not cover it. Needs-you updates route to chat. iPad uses readable width
limits and disables the iPhone-specific island presentation. These are
separate adaptations; a web viewport test does not validate the native apps.

Sources: [web shell](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/App.tsx),
[iOS roster](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/ios/App/ChatListView.swift),
[iPad layout](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/ios/App/CompanionLayout.swift).

### Onboarding and capability explanations

Desktop onboarding displays live engine availability and setup actions,
skips dictation when unavailable, and offers optional phone setup. Its
terminal guide distinguishes AI-provider sign-in, product identity, and
device pairing; scanning a code is not presented as a completed connection.
These are clarity patterns to evaluate, not proof of a zero-config first run.

Sources: [Onboarding](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/src/components/Onboarding.tsx),
[terminal setup guide](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/docs/cli-onboarding.md).

## Ranked Muster UI audit priorities

These gaps describe the Muster baseline inspected before this UI slice.
Record implemented fixes and their actual test results in
[ceo-log.md](ceo-log.md); do not turn the checklist into a completion claim.

1. **Responsive conversation controls and pickers.** At the audit baseline,
   `src/components/ChatView.tsx` placed task, model, usage, working folder,
   receipt, call, computer, browser, search, and inspector controls on one
   header row. Give identity and interrupt clear space, with an accessible
   way to reach secondary controls. Verify 320/390/768px widths, long names,
   open pickers, keyboard navigation, and desktop side panels. Group chat
   needs the same checks; solving one header does not validate every page.
2. **Task-specific attention.** `FleetOrb.tsx` derives attention from bot
   state; `TaskPicker.tsx` at the audit baseline shows task titles, times,
   and usage without sibling activity labels. Verify a waiting sibling task
   remains discoverable and selecting its alert opens that exact thread.
   Preserve this behavior when reducing navigation density.
3. **Optional phone handoff after useful work.** Muster's onboarding already
   includes a first-task step; keep it. Companion setup currently lives in
   Settings. Offer a skippable next step after the first result, explain the
   account/provider/device distinction, and verify resume, expired pairing,
   reconnect, and notification-to-task navigation on the relevant client.

Keep Muster's existing approval evidence, plan rehearsal, receipts, and
memory accessible while improving layout. Evaluate whether each surface
helps a person understand work and make a decision. Claims that a surface is
unmatched, more performant, or inherently better require comparative evidence.

## Patterns already present — do not queue as missing

Muster already has lettered OptionCards and hotkeys, inline tool activity,
bot context menus, routines, MCP clients, and a bounded Fleet MCP server.
The older study's suggestions to add those primitives were stale. Work on
their discoverability, state handling, accessibility, and actual outcomes.
Likewise, a runs-on control is useful only if its choices match the actual
execution capabilities and unavailable choices explain their prerequisites.

## Reuse boundary and verification

This audit copied no competitor implementation. The inspected
[licensing notice](https://github.com/milind-soni/OpenMausBot/blob/67336fb2d7139de1b91a8050d9c1ca1215844fea/LICENSING.md)
identifies Apache-2.0 outside the separately licensed `enterprise/` directory,
with separate trademark and third-party notices. Interaction research does
not authorize copying names, mascots, or separately licensed implementation.

Browser evidence for Muster must distinguish local fixtures, real server
behavior, authenticated flows, and production deployment. Native iOS/Android
and packaged Electron checks need their own evidence. No runtime superiority
or security conclusion follows from this source study.


## Installed desktop observation — 12 September 2026

Navigated the installed macOS app through native UI controls. Its update label
said **0.1.75 ready — restart**; no restart/update was performed, so this does
not establish that the running binary was 0.1.75. This was an existing workspace,
not a fresh-account installation. Private conversations and screenshots are not
reproduced here. No messages, connections, approvals, backups or VM jobs were sent.
Opening Browser and VM settings initiated the app's own status checks.

At 1238×768, the app used an approximately 220px navigation column, a quiet chat
canvas, compact model/task controls, a bottom composer and a separate Computer/
Browser panel. Collapsible sidebar sections and Tools/profile menus keep secondary
controls out of the conversation. General, Appearance, Engines, Local VM, Remote
access and Backups were inspected. The searchable settings dialog has stable left
navigation and a separately scrolling content column with grouped form cards.

The first five app-tour steps pointed to actual interface controls using a dimmed
background, bright target outline, mascot coachmark, progress and explicit Next.
Escape dismissed the tour; steps six through nine were not inspected. Muster's
existing onboarding examples instead advance every3.6 seconds, and Back returns
to Welcome rather than the previous example. Queue a user-paced tour with larger
selectors and clear example labels, then test focus, reduced motion and320px layout.

Engines separated five displayed Ready rows from seven Needs setup rows. Those
labels are UI observations, not new provider execution tests. Local VM settled on
“Create the Local VM”; nothing was created. Remote access showed a conflicting
companion port and actionable recovery; no existing companion was stopped.
Backups explained included workspace data, excluded credentials/remote disks,
password requirements and validation before import. Export/restore was not run.

Apply the hierarchy and explicit recovery patterns using Muster's own mascot,
copy and components. Preserve task identity, approvals and truthful capability
labels. This inspection does not establish native parity, successful remote
pairing, backup portability, VM execution or comparative product superiority.

The live [landing page](https://www.openmausbot.com/) was also opened in a browser.
It uses a dark, spacious hero, a row of expressive mascots, one dominant platform
download action and a product-shaped interactive preview. Selecting its Release
bot updated the pressed state and displayed a scripted working state. The page
explicitly labels the preview as a simulation. No installer, external account,
real release or native task was exercised by that interaction. For Muster, pair
the orange Flower with similarly clear product hierarchy and honestly labelled
examples; use verified availability for each platform CTA.
