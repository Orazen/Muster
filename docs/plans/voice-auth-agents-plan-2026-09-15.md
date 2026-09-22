# Voice, auth & agent-UX plan — 2026-09-15 research pass

Sources: vellum-ai/vellum-assistant (full monorepo incl. PRs/branches),
milind-soni/OpenMausBot (1,051 PRs, 432 branches), GetStream
build-grok-bot + stream-tutorial-projects + org survey. Shipped today:
mute-without-ending + caption toggle + provisional-tail grey + spoken
"end the call" (c40ba38); ownership-aware engine guard (2bbe52d).

## 1. Voice — where Muster stands vs Vellum

Vellum live-voice is a WebSocket JSON-frame protocol (start/audio/ptt_release/
interrupt/update_config/attach_frame ↔ ready/busy/speech_started/stt_partial/
stt_final/thinking/activity/assistant_text_delta/tts_audio/tts_done/
turn_cancelled/metrics) with server-side VAD, a sustained-speech barge-in
guard (250 ms speech + 200 ms gap tolerance + duty-cycle cap + learned echo
EMA), TTS-playhead word captions, and spoken session-control markers
([END_CALL]/[MUTE]/[UPDATES:FEWER]) gated by a per-client capability
handshake. Mute substitutes SILENT PCM rather than stopping capture — an
absent stream starves the server keepalive; mute is store-backed so a
reconnect never restores a hot mic.

Muster's web call is half-duplex browser SpeechRecognition + speaker queue —
right for a no-server product, but the UX gaps are closable:

- **W1 GroupCallView parity** — port today's mute/captions/spoken-end-call
  into room calls. Small.
- **W2 spoken register** — Vellum/OMB both rewrite screen-oriented agent
  output for ears before synthesis (drop code fences, name artifacts).
  Muster feeds raw markdown to TTS today. Pure function + tests.
- **W3 caption word-cursor** — highlight the word TTS is actually on
  (playedFraction × words, WPS ceiling, hold at last word while synthesis
  lags). Uses speechSynthesis boundary events as the playhead proxy.
- **W4 barge-in with browser AEC** — getUserMedia's echoCancellation IS the
  AEC the CallView header comment says is missing; with an energy gate +
  250 ms sustained-speech rule (port barge-in-guard's thresholds) the mic
  can stay open through playback. The flagship upgrade: interruption by
  talking instead of by button. Needs real-device testing (headless has no
  audio) — ship behind a setting, default off.
  **Shipped default-off (Loop175, 22 Sep 2026):** guard in
  `src/lib/barge-in.ts` (energy gate + 250ms sustain + 200ms gap
  tolerance, 9 tests), AEC analysis stream in `src/lib/barge-in-monitor.ts`
  (web capture path only; unsupported capture degrades to a note + tap),
  per-call toggle persisted in localStorage (store untouched), trip = the
  same interrupt as Space. Vellum's duty-cycle/echo-EMA was deliberately
  NOT ported (a naive cap blocks a real unpaused speaker) — **real-device
  proof remains an owner gate**, native desktop stays half-duplex by
  design (no AEC on its capture path).
- **W5 voice session controls** — extend the YES/NO recognizer with
  "end the call" (done), "be quieter" (update_config analog), per-call
  speaking-rate. Capability-tagged like Vellum's sessionControls.

## 2. Auth & restore — honest mapping

Vellum login = app-held PKCE against WorkOS + loopback callback + 0600
session file + per-device tokens; "restore" is NOT Google Drive — it is
`.vbundle` (gzip tar of SQLite + IDENTITY/SOUL + workspace) pushed to an
encrypted offsite folder (iCloud by default), AES-256-GCM per destination,
key confined to a separate security dir, and a DRY-RUN import report
(create/overwrite/unchanged + SHA-256 diffs) before any replace. Cloud
teleports use GCS signed URLs.

Muster already has: better-auth email + Google (branding-verified),
`muster up` QR claim, pairing, workspace bundle v1/v2 (AES-256-GCM,
Drive/Telegram/file transports, boot-apply + de-weaponize). The user's
"same logic like vellum auth login and restore chat from google drive" is
LARGELY SHIPPED — the real deltas:

- **A1 dry-run restore report** — v2 verify already inspects the bundle;
  surface a per-category create/overwrite/unchanged table + size estimate
  in PortableBackupCard before the replace-confirm. Vellum's
  import-analyzer concept; OMB #1192 same.
- **A2 sliding session expiry** (OMB #889) — in-use devices never re-pair:
  renew at ≤half-term, only after real authenticated use. better-auth
  supports it; wire the renewal hook.
- **A3 hosted sign-in allowlist** (OMB #970/#990) — admin/member email
  scopes for muster.today signups, editable in Settings without restart.
- **A4 engine self-service on hosted** (OMB #1024/#975/#1053) — the guard
  now says "add your key in Settings → Providers"; next step is the Test
  button on per-user keys (one read-only models request, verdict only) and
  browser-driven CLI sign-in on the server.

## 3. Agent-UX patterns from the Grok-bot materials

GetStream's OwnGrokBot (tutorial repo is UNLICENSED — learn, never copy)
and the org survey (Vision-Agents is the Apache-2.0 one worth watching;
Stream's chat/video SDKs are hosted SaaS — concepts only for a
local-first product):

- **RC live run-card** — plan as an editable message object ticking
  pending→active→done in place, Approve/Reject/Stop valid hours later,
  final-state write retried. Muster's approval cards are the base; add the
  plan rail. Biggest single transparency win for the receipts story.
- **RC2 approval tiers as data** — autonomous / queues-for-review /
  never-without-you per bot, enforced by the runtime (SOUL.md `runs:`
  field), rejection reasons stored as memory corrections.
- **RC3 teach-as-routine** — distill a thread into name/trigger/steps,
  trigger-match skips planning; Muster's routines engine already owns the
  scheduling half.
- **RC4 dictation review** — record ≠ send: Stop → Send / Keep-in-draft /
  Discard before a mis-heard sentence fires a turn (composer already holds
  drafts; add the voice-call variant).
- **RC5 visible handoff** — "Ada has this" as a real message when the
  lead routes an unaddressed room message.
- **RC6 throttled edit streaming** — send-then-edit at 0.45 s / 90 chars
  for the Telegram adapter (WhatsApp: final write only).

## Sequencing

W1→W2→W3 are small loops; W4 is its own loop with device testing. A1
before A2/A3. RC (run-card) is the landing-page-demonstrable one —
worth a loop of its own. All rows mirrored in DESIGN.md §38.
