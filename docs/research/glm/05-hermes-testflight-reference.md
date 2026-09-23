# 05 — TestFlight reference: "Cadu: A Hermes Agent UI" and what Muster should learn from it

_GLM research pass, 2026-09-11. Source: the TestFlight page at
https://testflight.apple.com/join/XfeprEPX, fetched 2026-09-11 via web search
snippets of the page (Apple's TestFlight pages are JS-rendered; the capture
below is from the page's indexable text, cross-checked for consistency). No
runtime claims: the app was not installed or launched — a TestFlight page can
only be read, joined, and installed on-device._

## 1. What the page shows, verbatim facts

- **Name:** "Cadu: A Hermes Agent UI" — open beta, joinable via the link above.
- **What it is:** a native iOS client for a **Hermes Agent server you run
  yourself, on your own machine**. It syncs with the desktop dashboard.
- **Feature surface on mobile:** chat, past conversations, photos, drawings,
  dictation — and, the load-bearing part, it **manages profiles, skills,
  plugins, MCP servers, scheduled jobs, file store, logs, and messaging
  pairing** from the phone.
- **Trust posture, quoted:** "There is no Hermes account and no hosted
  backend." Sign-in is by server address plus your own credentials, stored in
  the Keychain.
- **Requirements:** iOS 16+ / macOS 13+ (the macOS mention implies a Catalyst
  or "designed for iOS" build ships in the same beta).
- **Not shown on the page:** developer name, version number. Whether this is
  Nous Research's own client or a third-party client for the Hermes Agent
  protocol is **not established** by the page — recorded as unknown, not
  assumed.

## 2. Why this matters to Muster (analysis)

**a) The positioning is ours, arriving from a 241k★ ecosystem.** "No account,
no hosted backend, point it at your own server" is verbatim Muster's
own-your-data posture — and it belongs to the Hermes Agent world that
agi-os-frontier-v2 already tracks (~241k★, GEPA self-evolution, SOUL.md
personas). A first-party-grade mobile client for that ecosystem existing in
open beta confirms two things at once: the local-first agent-server category
is big enough to justify native mobile spend, and the "companion, not
post-office" architecture (muster-hi-new-agent-mail's client-not-post-office
invariant) is becoming the expected shape.

**b) The mobile feature surface is wider than Muster's companions'.** Muster's
iOS/Android companions are built but unlisted, and their surface is
chat-and-approvals. Cadu manages **skills, plugins, MCP servers, scheduled
jobs, file store, and logs** from the phone — full fleet administration, not
just monitoring. That is a concrete gap to close before Muster's store
listing: the "answer approvals from my phone" aha-moment is win-plan §2.1's
framing, but Cadu raises the bar to "run the whole fleet from my phone." The
server API surface for all of those management domains already exists (the
desktop app and web app drive it); this is a companion-UI project, not a
backend one.

**c) TestFlight itself is the distribution lesson.** An open-beta TestFlight
link is a public, shareable URL that puts a native iOS app on devices **today,
without App Store review**, gated only by the developer's build. Muster's iOS
companion is code-complete and store-blocked on the Apple Developer account
($99 — ask-list item 3 in serious-talk-brief.md). A TestFlight open beta is
the same unlock for us: the moment the account exists, the companion can be
in testers' hands in days, with App Store review running in parallel rather
than in the critical path. Android's equivalent (Play internal/closed testing
track) comes with the $25 account already on the same ask-list line.

**d) Competitive watch item.** If Cadu is official, Hermes has mobile
distribution while Muster's mobile sits unlisted — one more reason the $99
ask is the highest-leverage operator action on the list. If it's third-party,
it's arguably better news: the Hermes protocol already has an ecosystem
building on it, and Muster's equivalent opening (the fleet MCP server +
`muster` CLI + receipts spec) is the same kind of surface for others to build
clients against.

## 3. What Muster should copy, concretely (design notes, nothing built)

1. **Keychain-backed server-address sign-in** — Muster companions already pair
   via the pairing API (`/api/pair/create` → code → verify); the Cadu pattern
   confirms credentials-in-Keychain + server-address as the expected UX.
2. **Dictation and drawings as first-class input** — dictation matters for
   one-handed approvals on the go; matches the voice-first patterns from the
   Watch study in agi-os-frontier-v2 §2.
3. **Logs and file store visible on mobile** — trust surfaces (logs, file
   store) belong next to approvals, not hidden behind desktop; receipts are
   Muster's version and should be first-class in the companion.
4. **Scheduled-job management from the phone** — routines are Muster's
   compounding primitive (doc 03 L1); being able to inspect and toggle them
   from mobile closes the "the fleet works when I'm away" loop.

## 4. Non-claims

- Not installed, not launched, no performance/behavior claims; everything in
  §1 comes from the TestFlight page text.
- Developer attribution (official Nous vs third-party) unknown, kept unknown.
- "Syncs with the desktop dashboard" is the page's claim, not an observed
  behavior.
- No inference is made about Hermes' server architecture beyond what the page
  states; the ~241k★ figure and GEPA loop come from the repo's
  agi-os-frontier-v2 study (2026-09-04), not from this page.
