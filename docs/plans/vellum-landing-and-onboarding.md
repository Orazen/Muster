# Muster landing motion + onboarding — plan (studied from Vellum)

Sources studied:
- https://www.vellum.ai — hero + scroll behavior (screenshots taken, full page reviewed)
- https://github.com/vellum-ai/vellum-assistant — `clients/web/src/domains/onboarding/**`,
  `i18n/locales/en/onboarding.json`, `onboarding-navigation.ts` (real funnel + real copy)
- gaia-ui pattern → new repo: https://github.com/Orazen/muster-ui

---

## Part 1 — Landing page with Vellum-style motion

### What vellum.ai actually does
1. **Editorial-minimal hero**: serif wordmark, one-line tagline, single pill CTA,
   subtle corner illustration. No gradients fighting for attention.
2. **Scroll-revealed mascot crowd**: as you scroll past the hero, a colorful cluster
   of blob characters with eyes appears — playful, on-brand, and it *is* the product
   story ("your own assistant"). This maps 1:1 to Muster's star teammates.
3. Motion is restrained everywhere else; the mascots carry the personality.

### What changes on our landing page (`src/pages/LandingPage.tsx`)
Keep our dark/orange identity (do NOT copy Vellum's cream palette). Steal the
*motion grammar*, not the colors:

| # | Change | Detail |
| - | ------ | ------ |
| 1 | Hero entrance choreography | Staggered fade+rise: badge → headline → subcopy → CTAs (60ms stagger, 500ms ease-out). One-time on load. `motion.div` variants. |
| 2 | Hero star comes alive | StarLogo gets idle float (y ±6px, 6s loop) + occasional blink using `StarAvatar` from muster-ui next to the wordmark. |
| 3 | **Mascot crowd section** (new, the big one) | Between hero and Features: a scroll-triggered section where 8–10 `StarAvatar`s in different colors pop in with spring stagger (`whileInView`, `viewport={{ once: true }}`), then idle-float. Copy: "Muster your team." Each avatar = one engine color. This is the direct vellum.ai-equivalent moment, built from OUR mascot instead of copied blobs. |
| 4 | Feature cards scroll-reveal | `whileInView` fade+rise per card, 80ms stagger by grid index. Currently static. |
| 5 | Engine chips cascade | The 10 engine pills reveal in sequence when scrolled into view. |
| 6 | Reduced motion | All animation behind `useReducedMotion()` / `prefers-reduced-motion` — static fallback. |

Library: add `framer-motion` (one dep, no config). Estimated diff: ~150 lines in
`LandingPage.tsx` + a small `StarCrowdSection.tsx`.

### Explicitly NOT doing
- No parallax/scroll-jacking. Vellum doesn't do it either.
- No palette swap to Vellum's light editorial look.

---

## Part 2 — Onboarding, modeled on vellum-assistant

### Vellum's funnel (verbatim from their code)
welcome → hosting (Managed vs Local) → api-key (local) → privacy/consent →
**hatching** (phase progress: initializing → provisioning → connecting → ready) →
**research** ("Let's start with you" — name/role/hobbies → assistant searches the
web about you) → research results (reviewable claims, remove what's wrong) →
**create-personality** (5 slider axes: Companion↔Coworker, Gen Z↔Boomer,
Independent↔Collaborative, Playful↔Serious, Polite↔Unfiltered — assistant writes
its own SOUL.md from these) → **give-me-a-face** (pick character, name it, hear
its voice, shuffle) → finishing-up ("Updating my personality… Finding my voice…")
→ suggestions (concrete first tasks, skip-to-chat) → "Let's chat".

Engineering detail worth stealing: the whole wizard lives in ONE history entry
(every step `replace`s), so browser Back is genuinely inert after handoff to chat.

### Muster mapping (our version of each beat)

Current state: `src/components/Onboarding.tsx` = 3 utilitarian steps
(email → engines installed → dictation). Keep its data plumbing; replace its shape.

| Vellum beat | Muster version |
| ----------- | -------------- |
| Welcome | Welcome screen with StarLogo + Google sign-in (matches cloud reality) |
| Hosting choice | Already have both modes: Cloud (muster.orazen.online) vs Local desktop — surface as an explicit first choice like Vellum |
| API key screen | Engine connect step (we already detect installed CLIs — reuse existing engines detection) |
| Hatching screen | "Waking your team…" phase progress while engines/auth provision |
| Research about you | **Skip** — too invasive for v0; we already have name from auth |
| Create-personality sliders | Per-bot personality axes when you create a teammate (Companion↔Coworker etc.) — feeds the bot's system prompt |
| Give-me-a-face | **Strong fit**: pick `StarAvatar` color + name per teammate, exactly the muster-ui component. This is where muster-ui becomes load-bearing. |
| Suggestions | "First things your team could do" — 3–4 concrete starter prompts per engine |
| Day-2 check-in | Later — needs scheduling infra; note as future |

### Build order
1. `LandingPage` motion pass + StarCrowd section (Part 1) — self-contained, shippable alone
2. Onboarding wizard shell (single-history-entry routing, step layout, progress dots)
3. Face+name step wired to muster-ui `star-avatar`
4. Personality sliders → system-prompt builder
5. Suggestions step + handoff into chat

Each numbered item is an independent PR-sized chunk. Nothing here requires the
desktop-app Google-signin gap (separate known issue).
