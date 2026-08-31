# Landing redesign — agent-reach clarity pass (spec-kit)

> Method: github/spec-kit flow — specify → plan → tasks → implement, in one
> PR-sized pass. Status: SHIPPED 2026-08-22 (commit follows).

## 1. Specify

**Problem.** muster.orazen.online explains Muster well but buries the two
things a first-time visitor needs: *why this exists* (problem-first) and
*where it runs* (platform coverage). Panniantong/agent-reach's README — #1
trending the day we studied it — wins precisely because it leads with those.

**User stories**
1. As a visitor, I see a one-line statement of the problem Muster solves
   before any feature list, so I know within 5 seconds if this is for me.
2. As a visitor, I see which platforms Muster runs on at a glance.
3. The existing hero, crowd, features, engines and download sections stay —
   this is an addition-and-tighten pass, not a rebuild.

**Requirements**
- R1: A "Why" section sits between the mascot crowd and Features: one bold
  problem line, one Muster answer line, three concrete pain points.
- R2: A "Runs everywhere you do" platform grid sits between Download and the
  closing CTA: macOS, Windows, Web, iOS, Android — each with status.
- R3: Hero subline tightens to one sentence; detail moves to the Why section.
- R4: No new dependencies; reuse Reveal/motion primitives and palette.

**Acceptance criteria**
- [x] lint 0 / typecheck 0 / build passes / full suite green
- [x] Sections render on mobile (max-sm paddings present)
- [x] No layout shift to existing sections

## 2. Plan

Reuse `Reveal` for scroll-in. Why-section = centered narrow column like the
crowd section's header pattern. Platform grid = 5 cards mirroring the feature
card styling already in Features (`border-white/[0.08] bg-white/[0.02]`).

## 3. Tasks

- [x] T1 Write spec (this file)
- [x] T2 Tighten hero subline
- [x] T3 Add Why section after StarCrowdSection
- [x] T4 Add Platforms grid before CTA
- [x] T5 Gates + commit + push
