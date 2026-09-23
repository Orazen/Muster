# OpenMuse demo notes — extracted frames + UI/layout parity notes

Companion to `docs/plans/openmuse-integration-study.md`. Source videos (read-only):

- `…/openmuse-src/assets/demos/2026-09-16/mobile.mp4` — 38.0 s, 1920×1080 (16:9 canvas,
  iPhone mock framed right; captions for sound-off viewing).
- `…/openmuse-src/assets/demos/2026-09-16/web.mp4` — 42.0 s, 1920×1080 (1440×810 browser
  capture inside the same branded canvas).

**Method:** `ffmpeg` was available locally (`/opt/homebrew/bin/ffmpeg`), so **10 frames**
(5 per video) were extracted with `-frames:v 1 -q:v 2` into the **newly created** folder
`docs/screenshots/openmuse/`. That folder did not exist before this pass; no existing
screenshot file was touched. Model caveat inherited from their `docs/DEMO.md`: responses
come from CopilotKit **AI Mock** (scripted excerpts), while the browser runs a **real**
Chromium worker and the web mail flow runs **real** search/read tools over an isolated
fictional mailbox — the recordings demonstrate UI/tool flow, not live-model reasoning.

---

## Frame notes — mobile (`mobile-*.png`)

All mobile frames: 1920×1080 canvas, cream→lilac gradient, "OpenMuse 🪁" wordmark top-left,
phone mock on the right (~x 1207–1683), left caption block = blue scene kicker ("01 /
HACKER NEWS"), large two-line headline, gray subline, three **chapter pills**
(Ask / Follow / Take over — active pill is sky-blue), an 8-dash progress row, and
"Built with CopilotKit · Open source" footer.

### mobile-01s.png — 0:01 · scene "Ask OpenMuse to explore Hacker News" (kicker: AN AGENT WITH ITS OWN COMPUTER / "Ask it. Watch it browse." · chapter **Ask**)
- **Header:** hamburger left, capybara avatar centered above the agent name "OpenMuse" and
  status line "Here when you need me", bell with unread dot right. Below: a gray **status
  pill** "🖥 Computer · take control ●" (green dot = agent has a live session) — the
  header status names current capability, per their `docs/EXPERIENCE.md`.
- **Transcript:** user bubble right, sky-blue fill, ~18 px radius, single line
  ("Check out Hacker News for cool stuff"). A small gray chip "Recent results" groups
  follow-on results. Assistant typing indicator = gray pill with three dots.
- **Input pill (RUNNING state):** full-width rounded-3xl white pill; `+` (attach) left;
  placeholder "Message…" stays editable during the reply; right slot is a **filled
  sky-blue circle containing a white stop square** — same position where the send arrow
  sits when idle (their headline interaction).
- **Bottom nav:** separate floating pill with 5 icon buttons — chat (selected: white pill
  behind), a grid/apps icon, a lightbulb (Ideas), a checkbox (Goals), a nodes/molecule
  icon (connectors/apps — inferred from iconography, not verified in source).

### mobile-07s.png — 0:07 · scene "Read highlights from the live page" (kicker: 01 / HACKER NEWS / "A few good finds. In your thread." · chapter **Follow**)
- **Inline browser card:** screenshot thumbnail of the actual Hacker News page inside a
  light card, followed by a **full-width white "✋ Take control" button** — the handoff
  affordance sits *inside the transcript*, under the result it controls.
- **Assistant results card:** gray bubble, left, plain bullets with sources in
  parentheses, ending with an explicit provenance line `Source: https://news.ycombinator.com/`
  (source always printed, not hidden behind a link).
- **Input pill (IDLE state):** right slot is a subtle outlined **up-arrow** circle
  (disabled-look while empty) — the morph target of the running-state stop square.
- "Recent results" chip still parked above the composer.

### mobile-12s.png — 0:12 · scene "Ask it to summarize CopilotKit" (kicker: 02 / COPILOTKIT / "Give it a link. It takes a look." · chapter **Ask**)
- New user bubble ("Summarize https://copilotkit.ai") below the previous gray results card
  — assistant and user turns interleave in one column, assistant bubbles full-width gray,
  user bubbles right/sky.
- Typing-indicator pill active; **input pill shows the stop square while the text field
  remains focused with a visible caret** — the composer is fully usable mid-reply (their
  "composer stays available during replies" claim, visible in one frame).

### mobile-19s.png — 0:19 · scene "Follow the inline browser and result, Stop inside the input pill" (kicker: 03 / RICH RESULTS / "The browser. Right in the chat." · chapter **Follow**)
- **Browser card anatomy (second appearance):** header row = small round icon + bold
  "Browser" + domain subtitle (`copilotkit.ai`) + a **check mark top-right** (read
  complete); then the live screenshot preview; then full-width "✋ Take control".
- **Provenance framing on the answer:** gray card opens with
  "From CopilotKit's current page:" before the bullet — the answer is scoped to the page
  the browser just read.
- **Scroll-to-latest:** a floating white pill **"↓ Latest messages"** sits directly above
  the composer (visible only when scrolled up) — reading history never fights the live
  tail.
- Input pill idle (outlined up-arrow), nav pill unchanged.

### mobile-27s.png — 0:27 · scene "Take control of the same live browser" (kicker: 05 / SAME SESSION / "Your agent's computer." · chapter **Take over**)
- **Takeover console as a full sheet over the chat** (chat dimmed behind, sheet handle at
  top): title = domain `copilotkit.ai` with subtitle `active · updated 5:56 AM` (connection
  freshness is textual, not assumed), **X** close top-right.
- Controls top-down: **"Website address"** label + URL field + sky **Go** button; a row
  "Browser" · **Live** (green) · circular **↻ refresh**; **"Type into the selected field"**
  input + sky **Send text** button; a chip row of keyboard controls **Enter ↵ · Tab ⇥ ·
  Delete ⌫ · Scroll ↑ · Scroll ↓**; then the live page screenshot ("Connect any agent to
  any user" visible — same session the card was reading).
- Footer instruction inside the sheet: *"Tap the page to select a field, then send text
  above. You're controlling the agent's browser."* — the console always states whose
  browser it is.
- Assistant bubble peeking below the sheet ("3. Great news…") confirms the transcript kept
  streaming behind the takeover.

---

## Frame notes — web (`web-*.png`)

All web frames: same branded canvas; app shown inside a **macOS-style window mock**
(traffic lights + centered URL pill `OpenMuse · 127.0.0.1:8084`); chat column is narrow
and centered (~600–680 px content width) on a near-white page; header = hamburger left,
avatar + name + "Here when you need me" centered, bell-with-dot right, and the same
"🖥 Computer · take control ●" status pill under the name; bottom **segmented nav pill**
(5 icons, active = white pill) floats below the composer. Bottom-right scene caption
("DESKTOP WEB / 01…") — final frame replaces it with their github.com link.

### web-04s.png — 0:04 · DESKTOP WEB / 01 · "Ask for the school-trip email; the agent searches and reads it"
- User bubble right/sky; assistant bubble left/gray, full column width.
- **Inline tool line:** "🔍 Found 1 email" — a *plain muted row with a search glyph*, no
  chip box and no card border: tool calls in web chat are deliberately quiet.
- Typing-indicator pill; "Recent results" chip; **input pill RUNNING**: `+` left,
  "Message…" placeholder, filled sky **stop square** right (identical geometry to mobile —
  one component across breakpoints).
- Empty space below is generous; nothing else competes with the transcript.

### web-11s.png — 0:11 · DESKTOP WEB / 02 · "Open the inline email card and full message"
- **Full email viewer modal:** white rounded sheet over a dimmed chat; header = bold
  subject ("A little reminder: permission slips are due Friday") + subtitle
  "1 message in this conversation" + **X** close.
- Message card inside: sender bold + address, date right-aligned (`Sep 16 · 8:42 AM`),
  `To:` line, hairline divider, body paragraphs, then an honesty note —
  **"This message is included with your local workspace."** (local-data disclosure in the
  viewer itself).
- **Attachment row:** file icon + `Field trip permission slip.pdf` + metadata
  "2 pages · PDF attachment" + chevron (drill-in) — the Documents pipeline's entry point.
- Footer action: **"↩ Write a reply"** sky pill, bottom-left of the sheet.

### web-16s.png — 0:16 · DESKTOP WEB / 03 · "Review departure, return, and packing details"
- **Inline email card** in the transcript: gray card with the subject as headline,
  two snippet lines (greeting + preview with ellipsis), and a centered
  **"✉ Open email"** button — card opens the modal from web-11s.
- Assistant summary card below quotes the source explicitly ("From Lincoln Middle School:
  *"A little reminder…"*") then paragraphs, ending with forward-looking intent
  ("I can look up the aquarium next.").
- Input pill idle (outlined up-arrow), "Recent results" chip, nav pill — layout rhythm:
  card → answer → chip → composer, always in that order.

### web-26s.png — 0:26 · DESKTOP WEB / 05 · "Follow the aquarium website inline"
- **Browser card centered in the column:** icon + "Browser" + domain
  `montereybayaquarium.org` + check top-right; large real screenshot (site chrome +
  cookie banner visible = it is the live page, not a mock); full-width "✋ Take control".
- Answer card: "Exhibits from the aquarium's own guide:" (scoped provenance again).
- **"↓ Latest messages"** floating pill above the composer; input idle.

### web-37s.png — 0:37 · final frame · "Take control, scroll the same browser, and return to chat"
- **Takeover console modal** (desktop form): title `montereybayaquarium.org` +
  `active · updated 5:52 AM` + **X**; **Website address** field with the full current URL
  (`…/visit/exhibits`) + **Go**; "Browser" · **Live** (green) · ↻ refresh; **"Type into the
  selected field"** + **Send text**; key chips **Enter ↵ · Tab ⇥ · Delete ⌫ · Scroll ↑ ·
  Scroll ↓** (Scroll ↓ in selected/sky state — a chip reflects the last action); live
  screenshot below shows the Exhibits hero — the console is *the same session* from the
  card, address pre-filled (their "Reopen keeps the saved profile and the address").
- Session footer copy and the frame caption (github.com/CopilotKit/OpenMuse) close the
  web story.

---

## Style tokens observed (for parity work; matches `apps/server/src/browser-console.ts` CSS)

- Type: `-apple-system, BlinkMacSystemFont, system-ui` stack; 14 px base.
- Surfaces: page `#fcfcfc`; ink `#171215`-family (`#172125` in console); field fill
  `#f1f3f4`; card/radius: 14–18 px cards, 24 px pills.
- Accent: sky `#c8e7ff` primary buttons/chips, hover wash `#edf7fd`, focus ring
  `#1473c8`; live-green `#248258`; error wash `#fbefed` with `#984a41` text.
- Controls: min-height 42 px (pills), 36 px (chips); disabled = 0.45 opacity; visible
  `:focus-visible` outlines.
- Bubbles: user = sky fill, right; assistant = light gray, left, full width; cards =
  white or gray frames; artifact frames restrained (thin borders, no shadows).

## Parity takeaways mapped to Muster (target per study §4)

1. **Web (build):** stop-in-slot + editable draft during replies already exist in
   `Composer.tsx` — add the multi-item queue strip, resume chip, and "↓ Latest messages"
   pill (study S2). Quiet inline tool line style ("🔍 Found 1 email") for `ChatView` tool
   rows (study S3).
2. **Web (build):** browser card + "Take control" console sheet =
   study S1/S3 — console control order to copy: address → Live status → type field → key
   chips → live preview → ownership sentence in the footer.
3. **Web (build):** email viewer modal anatomy (subject header + "n messages" subtitle +
   local-data disclosure + attachment row + "Write a reply") = study S7/S10/S13 card
   conventions; reuse for PDF/attachment viewers.
4. **Web (build):** header status pill naming the agent's current capability
   ("Computer · take control ●") fits Muster's `ConversationHeader` without touching the
   App shell (stream (i)).
5. **iOS (map only, stream (v) owns `ios/**`):** input-pill states, activity list behind
   the avatar, bottom segmented nav, and inbox badge are the four native candidates from
   these frames; Muster Watch keeps its own approval-card design (OpenMuse has no Watch
   surface).

*Frames extracted and annotated 2026-09-23 by the research/planning subagent. Only the
new folder `docs/screenshots/openmuse/` and these two new plan docs were written; no
existing file was modified, no service was started.*
