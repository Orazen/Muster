# Muster onboarding redesign — plan (from vellum-assistant study)

## What vellum-assistant actually does (re-confirmed)
Onboarding is conversational, not a form wizard: the assistant interviews the
new user in chat and writes its own personality/preference files as it goes.
There is no separate "step 1 of 5" UI — the chat IS the onboarding.

## What this means concretely for Muster
Muster already has bot-driven chat as its core interaction model, so the
right move is NOT a new onboarding UI layer bolted in front of it — it's a
**first-run system prompt** that makes the very first conversation with a
freshly-created bot do the onboarding work: ask what the user wants this
teammate to do, what tools/integrations it should reach for, and quietly
write the resulting bot config (name, persona, model, tool grants) as the
conversation naturally produces answers — instead of a settings form the
user fills out before ever talking to the bot.

## Landing-page motion (from the vellum.ai study)
Vellum's own marketing site takes the opposite, editorial approach: a large
serif wordmark, one pill CTA, a lot of whitespace — then, on scroll, a crowd
of colorful blob-mascot characters (each with expressive eyes) appears. That
crowd-of-characters motif maps directly onto Muster's own "every teammate is
a star" concept: Muster's landing page could reveal a small crowd of
`StarAvatar`s (different colors, matching the app's own agent-color
palette) on scroll, as the visual proof of "a roster of teammates," instead
of the current static feature-grid layout.

## Proposed phased plan (not yet started — awaiting go-ahead)
1. **Landing page hero rework**: swap the current dark-gradient hero for a
   lighter, editorial layout; add a scroll-triggered reveal of several
   `StarAvatar` components in different colors as the "meet your teammates"
   moment. Uses the now-published `muster-ui` `star-avatar` component
   directly — first real consumer of the new registry.
2. **First-run bot onboarding**: new bots start with a short, scripted
   system-prompt addendum ("this is a first conversation, ask what the user
   wants before doing anything else") instead of a modal/form; once the
   first few questions are answered, config is written the same way any
   other bot-settings change is written today — no new persistence path.
3. **Sign-up → first bot handoff**: after Google-only sign-up completes,
   route straight into a brand-new bot's first conversation (skip the
   current settings/model-picker screen as a mandatory first step) — the
   model/tool choice can still happen, but as something the chat asks about,
   not a form gate before the chat exists.

Each phase is independently shippable and testable; (1) is the smallest,
already unblocked by muster-ui, and is the natural next piece of real work
if you want to keep going down this path.
