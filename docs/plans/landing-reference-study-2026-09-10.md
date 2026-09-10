# Landing reference study — 2026-09-10

Decision: make Muster's approval-and-evidence workflow understandable before
sign-in. The strongest next conversion slice is a small, explicitly simulated
product preview: choose a task, inspect an action, Allow or Deny, then read the
result. Keep the existing Muster mascot and connect the preview to a truthful
first-task setup path. This is a design recommendation, not measured conversion
uplift or a claim that competitors lack these capabilities.

## Evidence and limits

Reviewed all five requested primary landing pages on **2026-09-10**, plus the
linked OpenMausBot demo and Sintra pricing pages. Vellum's primary CTA resolved
to its signup route, whose body was unavailable to the text retrieval tool.
Page structure and linked destinations below were observed through web
retrieval. Controls present in the retrieved document are not proof that their
interactions work.

CUA discovery returned **zero enabled browsers**; selecting a browser returned
“No browser is available.” Therefore this pass records **zero browser
interaction checks, zero viewport measurements, zero competitor runtime tests,
and zero account creations**. No downloads were run, forms submitted, user/demo
sessions touched, or competitor assets copied. Product-code observations are
read-only checks of the current checkout. No executable tests were run for this
research document.

The earlier platform strategy contains exclusivity and availability claims
that this study does not adopt. The corrected
[competitive landscape](competitive-landscape.md) remains the comparison
baseline. A landing page's promises, screenshots, testimonials, and animated
examples are marketing evidence; they do not establish task completion,
approval enforcement, privacy properties, or product reliability.

## Five references

| Primary page | Observed structure and entry path | Useful pattern for Muster | What remains unverified |
| --- | --- | --- | --- |
| [Grok Bot](https://x.ai/bot) | Download and sales entry points precede separate sections for messaging, parallel bots, computer use, teaching routines, memory, and delegation. Job examples, plan selectors, platform downloads, guides, and FAQs follow. The page also distinguishes existing eligible subscribers. | Explain the workflow in successive product moments. Put engine/setup prerequisites next to the relevant entry path. Give an existing user a direct return path. | Download/install quality, plan eligibility, demonstrated job execution, and selector behavior. The advertised outcomes and subscription details were not independently exercised. |
| [Rakazo](https://rakazo.com/) | The document contains a roster/chat/computer preview, role examples, self-host information, and a start flow separating immediate self-host setup from a hosted waitlist. Preview affordances include search, a composer, computer control, and routines. | Separate available deployment choices clearly. Let visitors inspect a recognizable working surface before choosing setup. A role should lead to a concrete task example. | No preview control or waitlist flow was operated. The page's description of a live demo does not prove a live engine or external action. Licensing and privacy statements remain vendor claims in this study. |
| [OpenMausBot](https://www.openmausbot.com/) | Download and repository links lead; a roster/composer preview explicitly identifies its responses as scripted. Platform installation notes, product screenshots, scheduled job examples, team playbooks, and further product sections follow. | Be explicit about simulation. Show one task and its decision rather than relying only on a screenshot. Explain installation availability per platform instead of presenting every companion as equally obtainable. | No download, installation, companion pairing, or production workflow was tested. Platform signing/distribution statements are the site's claims. The referenced [demo](https://www.openmausbot.com/demo) provides suggested approval, delegation, computer, and call interactions; none was clicked in this pass. |
| [Sintra](https://sintra.ai/) | Named employees are organized around twelve business roles, followed by everyday work examples, a four-stage setup explanation, business context/memory, integrations, and further sales content. Its main purchase CTA leads to [pricing](https://sintra.ai/pricing), which presents billing periods, a bundled offering, promotional pricing, and a refund promise. | Use role names and recognizable outputs to help a visitor choose a starting task. Explain what context and connections a task needs. | No purchase, refund, setup duration, integration, or business result was verified. Discounts and guarantees are vendor offers; this study proposes no matching Muster price or promotion. |
| [Vellum](https://www.vellum.ai/) | A short assistant-focused hero leads directly to signup. Personality, memory, availability, and device reach appear before business/personal outcome lists and practical FAQs. The FAQ describes explicit approval scopes. The CTA resolves to [signup](https://www.vellum.ai/account/signup). | Make the product feel personal through an selected identity, then explain its work and approval boundaries. Answer setup and autonomy questions near the entry path. | Signup content was unavailable to retrieval. Personality labels in the page do not establish a working selector. No memory, cross-device continuity, authorization behavior, or advertised economics was tested. |

These references already describe teams, approvals, memory, or multiple
surfaces in overlapping combinations. Muster should compete on a comprehensible
workflow and demonstrable results, without asserting exclusive ownership of
those categories.

## What the current Muster surface already provides

- **A coherent selected mascot exists.**
  [MusterBloom](../../src/components/MusterBloom.tsx) has an expression vocabulary,
  pointer response, and reduced-motion handling. It is a better continuity
  asset than a new character borrowed from a reference site. Mascot integration
  is being handled in the concurrent product slice; this document does not
  change it.
- **The hero explains ownership but does not demonstrate the approval loop.**
  [The landing source](../../www/index.html) starts with licensing, provider
  names, web/desktop CTAs, an agent-setup copy control, and a static `hero.png`.
  Numerous feature, ecosystem, role, engine, CLI, pricing, room, and comparison
  sections then compete for attention. Its scripts handle menu/copy actions;
  there is no working-task preview in that page.
- **The evidence story is implemented.**
  [ApprovalCard](../../src/components/ApprovalCard.tsx) now preserves history,
  rehearsal limits, and previous-run context under a clearly dated-in-meaning
  evidence heading. [PendingApproval](../../src/components/PendingApproval.tsx)
  keeps decisions in the composer. [TaskUsageStats](../../src/components/TaskUsageStats.tsx)
  and the task receipt surface in [ChatView](../../src/components/ChatView.tsx)
  provide a concrete result to demonstrate. Missing usage must remain missing,
  and ordered-tool rehearsal must not become a confidence or safety score.
- **Onboarding already contains the ingredients.**
  [Onboarding](../../src/components/Onboarding.tsx) offers quick start, provider
  readiness, teammate identity, optional permissions, and a first task. It also
  contains a concrete reliability gap: `finish()` creates a bot on the unnamed
  quick-start path even when a greeting bot exists; creation responses are not
  checked with `response.ok`, failures are swallowed, and completion is then
  marked. A polished entry path must not call that a successful first task.
- **Availability and packaging copy need reconciliation.** The landing promises
  unlimited free bots while [the server cap](../../server/license.ts) is two in
  the free tier. Its broad ecosystem-availability and zero-setup language also
  exceeds the separately recorded runtime verification in the
  [UI E2E program](ui-e2e-program.md). Keep these as explicit review items.
  Changing a live price, entitlement, paid activation, or public claim follows
  the board mandate; this research neither authorizes nor makes that change.

## Design decisions

| Decision | Proposed treatment | Grounding and check |
| --- | --- | --- |
| Hero hierarchy | Original mascot, one understandable work outcome, one primary start action, secondary desktop/download path, then an approval preview. Move detailed license/provider explanation into a concise adjacent setup note. | Existing brand and working approval surface. A first-time reader should be able to identify the task, who decides, and how to begin without opening an ecosystem grid. |
| Product preview | A clearly labeled simulation using fixed sample tasks. Show the exact proposed action, a human choice, a truthful branch result, and a sample receipt. | Existing app concepts; reference previews demonstrate the communication pattern only. No paid engine, real connection, or anonymous production mutation is needed. |
| Role cards | Three useful starting jobs first: review a project, draft a brief, or organize a launch checklist. Reveal the expected output and required access before setup. Link other packs to the existing library. | Current first-task suggestions, bot roles, and team library. Avoid implying mailbox access or automatic sending before a connector is ready and an action authorized. |
| Motion and personality | Use the existing mark to acknowledge a selection or progress. Keep essential labels and status in text. Motion should stop under reduced-motion preference and remain optional for task completion. | Current mascot implementation. No competitor illustrations, character names, screenshots, or exact copy are needed. |
| Proof | Demonstrate a recorded task outcome and its limitations before listing every available surface. Label example data and simulation consistently, including terminal examples. | Actual receipts, approval evidence, and the existing test log. Decorative numbers are not customer or reliability evidence. |
| Start-path clarity | Distinguish opening the hosted web app, downloading a desktop client, and self-host documentation. Show prerequisites appropriate to the selected path. | Actual `/app`, `/download.html`, and `/docs` routes. Browser sign-in does not authenticate a model provider or pair a desktop automatically. |

## Ranked implementation slices

### 1. Interactive approval preview on the landing page

Replace the static-only product explanation with one compact simulated task.
Use fixed task choices and the Muster identity. Let the visitor
inspect the proposed action, choose Allow or Deny, open the resulting receipt,
and reset the example. The entry button still points into the actual product.
Treat this as an isolated presentation component, with no connection to the
production approval API.

Acceptance:

- A visible simulation label remains through every state; successful and denied
  branches have different truthful outcomes. Deny never shows completed work.
- Keyboard and touch can choose, inspect, decide, reset, and reach the real
  product CTA. Reset clears prior choices and completion indicators.
- At 320, 390, 768, and 1440 pixels, no document overflow or hidden decision
  control; status does not depend on hover or motion. Verify reduced motion.
- No visitor text, account, credential, external action, or paid model is
  required. Network checks confirm no production task/approval mutations.
- Tests assert state transitions and the visible result, not timer completion
  alone. Record browser checks separately from automated tests.

### 2. A clearer landing entry path and claim inventory

Reduce the initial navigation to the product explanation, example jobs,
downloads/setup, and docs. Make the selected entry path understandable before
the user leaves the page. Keep detailed capabilities available farther down or
on existing pages. Prepare the specific copy corrections for board review
where the mandate requires it; do not change entitlements to fit marketing.

Acceptance:

- Every start CTA resolves to the intended first-party page. Authentication
  preserves an allowed destination; existing users can return to the app.
- Desktop/platform choices are accurate and keyboard accessible. Unsupported
  or unavailable distribution paths are described plainly.
- An explicit inventory reconciles bot caps, provider prerequisites, computer
  provisioning, native distribution, and sample terminal output with code and
  current verification. No security or superiority assertion is introduced.
- Layout and copy tests retain the accessible mobile menu and download/docs
  routes. Live pricing remains unchanged unless separately authorized.

### 3. Carry the chosen job into first-task onboarding

A role/example choice should become a reviewed first-task draft after sign-in.
Use a small allowlisted template identifier and an intentional handoff; do not
place private prompts or credentials in a URL. Preserve the user's ability to
edit or discard the draft. Avoid automatically sending it on account creation.

Acceptance:

- Each supported template survives sign-in, reload, and back navigation without
  duplication or cross-account carryover. Unknown identifiers fall back safely.
- A missing provider explains the next action and retains the draft. A ready
  provider allows an explicit send to the selected bot and task.
- Quick start reuses an eligible greeting bot or creates exactly one intended
  bot. A failed creation shows recovery and does not claim first-task success.
- Double clicks, retry, and network failure do not create duplicate workers or
  send the same task twice. The resulting user/reply rows persist after reload.

### 4. A first-result checklist with an optional phone handoff

Keep deployment, model access, application connections, and companion pairing
as distinct steps. Show completion from observed state: account ready, engine
ready, first task settled, optional device connected. Offer the phone handoff
after a useful result, and keep it skippable.

Acceptance:

- No-engine, unauthenticated-engine, connecting, waiting-for-human, failed, and
  settled states have accurate next actions; permission prompts occur only
  when the corresponding capability is chosen.
- A failed or denied turn does not satisfy first-success completion. Receipts
  show only available usage and cost.
- Pairing expiry, consumption, retry, and account identity are exercised using
  owned fixtures. Report native-device delivery separately from mobile web.
- Measure setup-to-first-settled-task and drop-off by step before asserting an
  improvement. Reuse approved event handling and omit prompt, transcript,
  credential, and private file contents from analytics.

## Handoff

Ship these independently with the normal typechecks, focused tests, full suite,
browser evidence, and CEO-log entry. A reference-inspired layout is not a
verified competitor benchmark. This document changes no product, pricing,
analytics configuration, provider connection, or deployed surface.


## Root browser follow-up

The root maintainer subsequently had an enabled CUA browser and opened all
five landing pages. **Five manual reference interactions passed**: Grok Bot's
Bug Reproduction selector changed the selected state and revealed its task
description; Rakazo's Get started opened explicit self-host/cloud-waitlist
choices; OpenMausBot's Release selection changed the bot/composer; Vellum's
autonomy FAQ expanded; Sintra's Get Sintra navigated to pricing. No purchase,
account creation, download execution or real work was attempted. A role-based
Grok selector initially had no match during page hydration; a fresh accessible
control succeeded and the failed attempt is not a passing check.

Screenshots of these landing views were inspected at the available narrow
browser size; late-loading graphics and moving layout limit visual conclusions.
These were **not** a five-site responsive acceptance matrix. Separately, the
requested musterbot demo rendered the star form; choosing Orange changed its
selected color and persisted through reload (**one mascot interaction check**).
The current product branding slice uses the board-selected identity; the
upstream code attribution and design-origin caveat are recorded in the master
[GLM handoff](glm-handoff-2026-09-10.md).
