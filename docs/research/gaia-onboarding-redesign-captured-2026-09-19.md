# GAIA onboarding redesign — captured live 2026-09-19

Source: heygaia.io/onboarding, signed in via the owner's own Google consent in
the shared browser pane (two screenshots in the session artifacts). Purpose:
design mapping for Muster's onboarding. Study only — GAIA's product repo is
PolyForm Noncommercial; nothing is copied, patterns and copy tone only.

## The pattern (as captured)

The whole onboarding is a **conversation with the assistant**, not a wizard:

1. Full-screen ambient aurora (deep blue/teal glow rising from the bottom);
   no card chrome at all — pure centered chat column.
2. GAIA speaks in **progressive bubbles** (their avatar beside them): a
   personal greeting using the account's name, then the value proposition in
   casual first person ("I do all of that. Not you."), then exactly one
   question.
3. Every question is answered with **chips, not forms**: single-select
   (role: Founder/CEO, Executive, Sales, Product, Creative, Engineering,
   Marketing, Finance, Student, Other — each a tinted pill with an emoji)
   then multi-select pain points ("Pick up to three", live "3 left" counter).
4. The user's pick renders as **their own blue bubble** with their avatar;
   GAIA acknowledges conversationally ("Marketing, got it.") before the next
   question.
5. Earlier messages **blur as they leave focus** (depth, not deletion).
6. Progress: thin segmented bars across the top; "Restart Onboarding" pinned
   bottom-right.

## Muster mapping (next pass; plan only — nothing built)

Muster already owns the ingredients: its seed welcome card is chat-native
(question + option chips inside the thread), the Flower character has
per-beat expressions and narrated lines, and the wizard has the voice-setup
beat. The GAIA-shaped port:

- Replace the wizard's stage/screen metaphor with the **thread-conversation
  experience**: the onboarding runs as a real Muster thread where the new
  teammate asks one question at a time with chips (the existing
  ask-user/OptionCard surface IS this pattern — the redesign generalizes it
  to onboarding).
- The Flower guides from beside its own bubbles (character + narrated line
  already built), rather than a sidebar.
- Keep Muster's advantages GAIA lacks: the approval spine is already the
  chat pattern ("asks before risky things"), the storage gate stays as its
  own step (decision 14), and hire-a-team-in-60s becomes a chip group.
- Voice setup stays a beat ("tap to check your mic"), delivered in-thread.

Honest note: the conversational shape overlaps so strongly with Muster's
existing seed-card chat that the port is mostly composition, not new
machinery. Scope it as its own verified slice before touching the wizard.
