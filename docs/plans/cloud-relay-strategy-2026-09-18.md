# Muster product direction — owner decisions, locked 2026-09-18

The owner answered 17 strategy questions this session. This file is the
binding record: latest owner request outranks every older plan. When a slice
seems ambiguous, resolve it with the decisions below before consulting any
historical doc.

## 1. The decisions (verbatim intent)

| # | Question | Decision |
|---|---|---|
| 1 | Deployment focus for the next month | **Cloud-hosted first** — muster.today is the flagship front door, like GrokBot's product shape |
| 2 | Core identity | **AGI harness fleet** — approval spine, receipts, workspace brain, benchmarks, Drive continuum are the moat |
| 3 | Next build tracks | **All four**: release & polish · voice true-calling · skills + brain growth · AGI ladder M1–M4 |
| 4 | Money model | **BYOK free forever** — no billing, no paid tiers; users bring their own API keys |
| 5 | Hosted compute | **BYO-computer relay** — bots run on the user's own machine(s); muster.today is control plane + relay, near-zero hosted compute |
| 6 | Desktop/self-host | **Keep first-class** — Electron app + Docker self-host remain equal citizens, not legacy |
| 7 | Primary user | **Everyone** — templates, guided first run, plain-language onboarding |
| 8 | Model access | **All providers BYOK** — every major provider + OpenRouter; no pooled inference |
| 9 | Voice v1 | **You ↔ bot true calling** — ring / accept / end, distinct from walkie push-to-talk; Watch included |
| 10 | iOS release | **TestFlight now, App Store later** — public TestFlight stays the channel until hosted-relay onboarding works on phone |
| 11 | Agent social | **Private + explicit links** — fleets stay private; agent mail only between explicitly connected fleets (no public directory) |
| 12 | Offline relay | **Route to any online paired device** — if the usual computer is offline, work routes to whichever paired device of that user is online |
| 13 | First-run magic | **Hire a team in 60 seconds** — template gallery (www/templates.html shapes this) right after setup; one tap hires a pre-written team |
| 14 | Storage sovereignty | **Drive/Telegram only, enforced at onboarding** — chats, memory and files live ONLY in the user's own Google Drive or Telegram; muster.today keeps NO stored workspace copy. Connecting storage is a hard gate before first use |
| 15 | Launch hero | **Watch calling** — "call your AI teammate from your Watch; it does the work on your Mac" |
| 16 | Owner unblocks (this week) | **All four**: GitHub Actions billing · VPS SSH · Google OAuth credentials · Apple Developer ID certificate |

## 2. What decision 14 means architecturally (the big one)

Today the hosted server stores each user's workspace server-side. Decision 14
changes the hosted contract to **storage sovereignty**:

- muster.today becomes the **control plane**: accounts/auth, pairing/relay,
  approvals routing, the fleet brain's live queries — plus **live routing
  only**. Durable workspace state (transcripts, memory, files, bot
  definitions of record) lives in the user's Drive/Telegram and on their
  paired computers.
- **Onboarding gate**: a new hosted user must connect Google Drive or
  Telegram before a workspace is created — the storage connect step moves
  from "Settings → Connections, any time" to a required first-run step,
  ahead of "hire a team in 60s".
- **One open sub-decision** (resolve when the hosted-relay slice starts, not
  before): how a browser session gets a workspace view when the server holds
  no stored copy —
  - **(a) transient hydration (recommended)**: on sign-in, muster.today
    hydrates a working view from the user's online paired computer (live
    relay) or from their latest Drive snapshot; while the session lives, it
    behaves like today; on sign-out/timeout, the server-side copy is wiped;
    every mutation is pushed to Drive continuously. Browser feels instant;
    server stays storage-free at rest.
  - (b) dashboard-relay only: muster.today is purely a remote-control
    surface onto your online computer; a browser with no computer online
    shows pairing/recovery only. Simpler, weaker first impression.
  Recommendation: (a), because "everyone" onboarding (decision 7) plus
  "hire in 60s" (decision 13) cannot require a running desktop as a
  precondition, but the existing v2 bundle encrypt/restore machinery already
  implements exactly the hydrate/persist/wipe loop needed.
- The existing pieces map cleanly: the encrypted v2 bundle (passphrase-only),
  account-Drive push/pull (roundtrip-pinned), Telegram backup, the recovery
  card, and per-user isolation are the building blocks; the new work is the
  onboarding gate, continuous Drive persistence during live sessions, and
  the wipe-on-end guarantee.

## 3. The relay (decisions 5 + 12)

Bots execute on the user's paired computers. muster.today brokers:

1. **Device registry**: which of a user's computers are online (desktop app
   connected, self-host box connected).
2. **Routing**: new work goes to the user's preferred computer; if it is
   offline, to any other online paired device of the same user (decision 12).
   If none are online, work queues server-side as intents (no execution)
   until a device connects — routing, never hosted execution.
3. **Trust**: the existing pairing spine (one-time codes, HMAC device
   tokens, frozen peer grants) extends to computer↔cloud with per-device
   identity; approvals stay human via the existing OptionCard path,
   delivered to whichever surface the owner is on (decision: unchanged).

Self-host/desktop stay fully functional WITHOUT the cloud (decisions 1 + 6):
the relay is an additional front door, never a dependency.

## 4. Build order (all four tracks, sequenced)

0. **Owner unblocks land this week** (decision 16) — the moment each lands,
   its verification slice becomes executable: Actions billing → CI checks +
   Windows/Linux legs; VPS SSH → 1.12.3 mirror promotion + HEAD-fix
   redeploy; Google OAuth → real "Connect my Google Drive" + Google sign-in
   acceptance; Apple cert → notarized macOS release leg.
1. **Release & polish**: 1.12.4 desktop, mirror promotion, HEAD fix live,
   CI green for the first time (this makes everything already built visible).
2. **Storage-gate onboarding** (decisions 13 + 14): required Drive/Telegram
   connect as first-run step → template gallery → hire-a-team-in-60s.
3. **Hosted relay foundation** (decisions 5 + 14): device registry, live
   routing, transient hydration (sub-decision above), wipe-on-end.
4. **Multi-device routing** (decision 12): preferred-device + failover.
5. **Voice you↔bot calling** (decision 9): ring/accept/end, backgrounding,
   mid-call renegotiation; **Watch calling** as the launch hero (decision 15).
6. **Skills + brain growth**: skill-creation API behind the fleet MCP,
   brain auto-capture from settled turns, semantic retrieval connector.
7. **AGI ladder M1–M4**: self-measured routine → evidence-carried persona
   change → certify-then-commit → unattended eval gate (unchanged from the
   GLM synthesis; now sequenced after the product surface it will measure).

Mobile stays TestFlight-channel until step 3 works on phone (decision 10).
Social stays private + explicit links; S5–S10's public pieces are dropped
from the ranked list (decision 11).

## 5. Non-claims

This file records direction, not built work. No billing ever (decision 4)
means no payment code should be started. No security claim is made or
implied; the Mimosa re-run remains owed. Anything already verified carries
its receipts in the CEO log (Loops 104–120) and current-state.
