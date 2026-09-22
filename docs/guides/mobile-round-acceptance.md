# Mobile/Watch round — hardware acceptance checklist (22 Sep 2026)

Everything shipped in this round — crown scrolling (`e4ccd99`), Watch haptic
vocabulary (`0b989cf`), phone dictation (`96650eb`), Android deep-link + QR
(`bb5f858`) — is verified by unit tests and simulator builds only. This
checklist is the remaining gate: physical Watch, iPhone and Android
acceptance, performed by the owner on real devices. Existing automation
stays paused; nothing here runs unattended. Mark each row PASS/FAIL with
device model + OS version. A FAIL is a finding for the handoff ledger, not
something to report around.

## A. iPhone — composer dictation

Prep: build from this checkout (`cd ios && xcodegen generate`, open
`MusterCompanion.xcodeproj`, run to the paired iPhone). TestFlight
distribution is an owner gate and is not claimed.

1. Pair as usual (paste link) — unchanged behavior.
2. Open any chat. The composer shows a mic button between the field and
   send.
3. Tap the mic fresh: the Speech Recognition prompt appears ("Muster
   converts your voice into messages … Walkie … dictate in a
   conversation"), then the Microphone prompt. Allow both.
4. Speak: words stream into the draft live; the field is disabled while
   listening; a "Listening — speak your message" line shows; send is
   disabled during the capture.
5. Tap the red stop: field and send return, the words stay. Edit them,
   then send — nothing was transmitted automatically at any point.
6. Dictate on top of typed text: typed words are kept, spoken words append
   with correct spacing (no double space; a trailing space absorbs the
   separator).
7. Denial paths: Settings → Muster Mobile → Speech Recognition off → mic
   tap shows "Speech recognition is off — allow it in Settings to
   dictate."; microphone off instead shows the microphone variant.
   Re-enable and retry — it works.
8. Tap back mid-capture: re-enter the chat — the words spoken are still in
   the draft (detach commits before silencing).
9. Walkie regression: hold, speak, release → sends. Untouched engine, but
   confirm it.

## B. Apple Watch — crown detents + haptic vocabulary

Prep: paired Watch, companion installed, fleet with ≥ 2 bots.

Crown (`FocusDetentTracker`):

10. Enter the fleet list: entering the screen is silent (no click on
    appear).
11. Rotate the crown row by row: exactly one `.click` per row crossed,
    with a visible focus tint on the resting row.
12. Leave the list and return: silent again — focus loss reset.

Haptics (`FleetHapticPlanner`, one event per frame):

13. From idle, send a task to a bot → `.start` (fleet began).
14. The bot's reply lands → `.success` (reply), and it must feel distinct
    from row 15's buzz.
15. A new approval arrives → exactly ONE `.notification`. (Before this
    round it buzzed twice and felt identical to a reply — both are the
    defect this slice fixed.)
16. Answer that approval on the watch → `.stop` (resolution), distinct
    from the arrival.
17. The last busy bot goes quiet → `.directionUp` (settled). Confirm it is
    distinguishable from the crown's `.click`: that separation is a
    code-level assumption until a wrist says otherwise. If they feel
    identical, record it as a finding.
18. Watch off wrist → back on / app relaunch: no buzz storm — hydrate is
    silent by design. Work that arrived while disconnected may buzz once
    on catch-up (also by design).
19. Two replies landing together → one buzz, not two (batched replies).

## C. Android — deep link + QR delivery

Prep: owner-built install of the companion (EAS/Play distribution is an
owner gate — not claimed). Unpaired for rows 21–26.

20. Manual/paste pairing still works (regression).
21. Deep link, cold start: force-kill the app, tap the `muster://pair?…`
    link from desktop Settings → Companion → the app opens, fills the
    address field ("Link for …" / invite-ready line) and does NOT connect.
    Tap "Pair with computer" explicitly, then it pairs.
22. Warm link: app open on the pairing screen, tap the link again → same
    fill, same wait for the explicit tap.
23. While already paired, tap a link → nothing happens (no listener — no
    silent re-pair).
24. QR: tap "Scan QR code" → the camera permission prompt shows the
    configured string → allow → aim at a QR encoding the pairing link
    (render the link the desktop shows with any QR generator; a
    desktop-rendered QR of its own is a separate product question) → the
    field fills, the scanner closes, still no auto-connect → explicit
    Pair tap pairs.
25. QR denial: deny → "Scanning needs camera access …" with Allow and
    Cancel; deny permanently → "Camera access is off. Turn it on in
    Settings, or paste the pairing link instead."
26. Scan a non-invitation QR (any ordinary URL) → scanner closes, one
    honest error on the form ("That code is not a Muster pairing
    invitation."), typed fields otherwise untouched, Pair stays disabled.
27. Local-network reality: pair over the actual LAN (IP:port, HTTP or
    HTTPS as configured) — beyond what host tests simulate.

## D. Cross-device regression (any phone + watch)

28. Roster loads; chat opens; a sent message appears; an approval answered
    on the phone reflects on the watch and vice versa.
29. Unpair → re-pair works with no leftover state from the old pairing.

## Recording results

- Per row: PASS/FAIL + device model + OS/watchOS/Android version.
- Fails → handoff ledger entry with reproduction; this file is the
  scenario list, the ledger is the record.
- Completion of this checklist is the acceptance evidence for the round;
  until then every slice's evidence stays unit + simulator only.
- Still not claimed by anything here: TestFlight/Play distribution,
  production rollout, signing/notarization, release-channel changes, and
  any security claim — the project's security scanner has not completed a
  full re-run.
