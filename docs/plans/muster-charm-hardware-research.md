# Muster Charm — Hardware Research (Agent 4)

Date: 2026-10-03 · Author: Agent 4 (Hardware Research) · Status: **research only**

## Scope and self-imposed limits

This is a **research note, not a purchase order and not a build plan.** Per `Muster_Sub_Agent_Operating_Loop.md` → *Agent 4: Hardware Research Agent*:

- **Must not** start hardware before the software MVP. This note does not authorise buying, soldering, or flashing anything.
- **Must not** claim full local AI on ESP32. Section 5 explains concretely why that is not possible, not merely discouraged.
- **Must not** recommend expensive hardware without reason. Section 6 leads with the cheapest path that answers each question.

The software MVP (login, Drive sync, chat, memory, sessions, tasks, restore) is unaffected by this note. **Nothing here is on the critical path.**

Prices are **observed approximations gathered 2026-10-03**, not quotes. Re-verify before any purchase; board pricing and stock move quickly.

---

## 1. What Charm is for

Muster is a privacy-first personal AI OS. Charm's job is to be the **always-there input/output surface** for the assistant — not to be the assistant.

In Muster's own terms: Charm is a **voice/notification endpoint for agent workflows**. It captures intent, confirms it locally, and hands work to something that can actually reason. It must therefore optimise for **battery, latency to first response, and privacy**, not for model capability.

The single most important design consequence: **the user's own Mac/PC should be the default executor.** That keeps Muster's "low server dependency" promise intact and means Charm works even if Muster's servers are down.

---

## 2. ESP32-S3 options (why S3 and not the others)

| Variant | Strength for Charm | Verdict |
|---|---|---|
| **ESP32-S3** | Dual-core LX7, USB-OTG, vector instructions for TinyML, Wi-Fi + BLE 5, PSRAM options (8 MB) | **Recommended.** The only variant with both BLE and the DSP/vector support that wake-word detection needs. |
| ESP32-C3 | Cheapest, lowest power, single-core RISC-V | Rejected for audio: no BLE, weaker vector support, and no PSRAM headroom. Fine for a bare sensor. |
| ESP32-C6 | Wi-Fi 6, Thread, Matter | Rejected: Thread/Matter are mesh-networking wins we do not need yet, and BLE is the pairing path we do need. |
| ESP32-P4 | High-performance MCU with MIPI/CSI, no integrated radio | Rejected for a pendant: adds cost and needs an external radio anyway. |

**BLE note, and why it matters more than Wi-Fi here.** Charm should pair and be discovered over **BLE**. It should reach the user's Mac over **Wi-Fi on a local network**, not through Muster's servers. That keeps the audio path user-owned. BLE is also how the Watch/phone companion path already behaves in Muster, so Charm reuses a pattern the project has rather than inventing one.

---

## 3. Waveshare ESP32-S3-Touch-AMOLED-1.75 — board notes

Observed characteristics of the primary candidate:

- 1.75-inch **circular** capacitive-touch **AMOLED**, 466×466, 16.7M colours, QSPI interface
- ESP32-S3 dual-core LX7; N16R8 configuration (16 MB flash / 8 MB PSRAM)
- **Onboard dual-microphone array with acoustic echo cancellation (AEC)**
- **6-axis IMU** (3-axis accelerometer + gyroscope)
- Power-management IC on board
- Variants: bare board and a `…-1.75C` **aluminium-alloy cased** version (also offered at 1.43")

Why this board is a strong first prototype: the **dual mics with AEC** remove the single hardest audio problem (the device hearing its own speaker), and the **IMU** enables tap-to-talk and gesture rejection without extra parts. That combination is what makes a usable voice endpoint possible on a first attempt.

Honest drawbacks:

- **AMOLED is power-hungry.** A always-on bright round AMOLED is close to worst-case for battery. Expect the screen to be the dominant draw, not the radio.
- Round 466×466 is an unusual aspect ratio; UI work is not free.
- Cased variant costs more and adds weight for a pendant.

Approximate pricing observed: **~US$30** for the 1.75" AMOLED board; the **1.43" cased variant ~€27.50 ex-tax**.

---

## 4. Cheaper test boards — buy these first

The correct sequence is **cheapest-first**, answering one question per board. Do not start with the AMOLED board.

| Stage | Board / part | Approx. cost | Question it answers |
|---|---|---|---|
| **0** | Bare ESP32-S3 dev board (e.g. DevKitC-1 class) | ~US$5–10 | Does the build/flash/OTA toolchain work at all? Does BLE pair? |
| **1** | Screenless ESP32-S3 **audio** board (Waveshare ESP32-S3-mini class) | ~US$10–20 | Can we capture clean audio, run a wake word, and stream a snippet? **This is the decisive board.** |
| **2** | ESP32-S3 + small SPI TFT (1.8"–2.0" class) | ~US$15–25 | Is a non-AMOLED screen good enough for notifications? If yes, Charm is far cheaper. |
| **3** | Waveshare ESP32-S3-Touch-AMOLED-1.75 | ~US$30 | Only after 0–2 pass. Buys the good-looking round AMOLED prototype. |

**The finding that matters most:** a screenless ESP32-S3 audio board is roughly **US$20 cheaper** than the AMOLED board and is the board that actually de-risks the voice pipeline. Screen and IMU are cosmetic; audio is the feature. Optimising in that order is the cheapest path to knowing whether Charm is worth building.

---

## 5. What runs local vs phone/server — the honest split

**The ESP32-S3 cannot run a language model.** This is a capability limit, not a policy choice: no GPU, no accelerator, and roughly 512 KB SRAM alongside 8 MB PSRAM. Anyone describing "local AI on ESP32-S3" for a conversational assistant is describing something that will not work.

| Task | Runs on Charm | Runs on user's Mac/PC | Runs on Muster server |
|---|---|---|---|
| Wake word / "hey Muster" | **Yes** — keyword spotting (TinyML/Edge Impulse) | no | no |
| Voice activity detect, ring-buffer, clip capture | **Yes** | no | no |
| Push-to-talk, tap-to-talk (IMU) | **Yes** | no | no |
| Haptics, LED/screen notification, glanceable status | **Yes** | no | no |
| Speech-to-text | no | **Preferred** | Fallback only |
| Reasoning, planning, tool use, memory write | no | **Preferred** | Fallback only |
| Model routing (BYOK — user's own key) | no | **Yes** | Should not |
| Pairing, BLE, OTA firmware update | **Yes** | no | no |

**Why this split serves the vision rather than fighting it:**

1. **Privacy-first** — audio never has to reach Muster's servers if the user's own machine handles it. Server fallback is a fallback, not the design centre.
2. **Low server dependency** — if Muster's servers are down, Charm still wakes, still shows status, and still hands work to the local Mac.
3. **User-owned data** — memory and BYOK keys stay on user-controlled machines; Charm holds no long-term memory.
4. **Voice, now** — voice is on the roadmap, and wake-word + capture is exactly the part that *must* be local for latency and privacy anyway.

**The tension worth naming now, before hardware exists.** "Low server dependency" and "the pendant is always with the user" pull in opposite directions when the user is away from their own machine. Charm will be useless-but-honest off-LAN unless a server path exists. The honest resolution for the MVP is: **Charm is a home/desk device first**, and roaming is a later problem. Deciding this later, with evidence, is cheaper than designing for it now.

---

## 6. Cost estimate

Stage-gated, cheapest-first, excluding labour and shipping:

| Stage | Boards | Indicative total |
|---|---|---|
| 0 — toolchain + BLE proof | 2 × bare dev board | ~US$15 |
| 1 — **voice pipeline proof** | 3 × screenless audio board | ~US$45 |
| 2 — display viability | 2 × SPI TFT board | ~US$40 |
| 3 — AMOLED prototype | 2 × 1.75" AMOLED | ~US$60 |

**Total to answer every feasibility question: roughly US$120–160.** That is a small, bounded, reversible research spend — and every stage is independently useful even if the project stops at Stage 1.

Excluded on purpose: PCB design, custom enclosure, injection tooling, certification. Those are Stage-4 problems and are not justified before Stage 1 passes.

---

## 7. Microphone, speaker, battery

**Microphone.** The Waveshare board's **dual-mic array with AEC** is the reason to prefer it; AEC is what stops the assistant hearing its own speaker. Cheaper boards usually have a single MEMS mic — workable, but echo handling then has to be avoided by design (e.g. half-duplex: stop listening while speaking).

**Speaker.** For a pendant at desk range, a small 8 Ω 1 W–2 W myler speaker plus a passive buzzer for confirmation tones is sufficient. **Recommend deferring audio output**: most Charm interactions will be confirm-to-phone/Mac, and a speaker is the cheapest part to omit and the most expensive in battery and enclosure terms. Note that many cheap ESP32-S3 audio boards already include a speaker amp.

**Battery.** This is the real constraint on a pendant, and the one most likely to invalidate the AMOLED route.

- The board carries a power-management IC, so LiPo charging is feasible.
- Realistic target for a **screen-off, wake-on-demand** device: **several days**. With an always-on AMOLED at usable brightness: **hours, not days**.
- Therefore: **always-on AMOLED is not viable for the first Charm.** A dark, mostly-off screen with a wake gesture/IMU tap is the realistic configuration. This is a finding, not a preference, and it is worth deciding before anyone buys a display.

---

## 8. Risks and blockers

| Risk | Severity | Note |
|---|---|---|
| AMOLED battery life | **High** | Likely forces screen-off-first design. Cheap to learn at Stage 2/3. |
| "Local AI on ESP32" expectation | **High** | Must be closed off explicitly (Section 5) before anyone spends time on it. |
| Off-LAN usefulness | Medium | Deferred deliberately; Charm is home/desk first. |
| Firmware/OTA and fleet management | Medium | One device is a hobby; a hundred needs real OTA. Out of scope until Charm exists. |
| Wi-Fi power draw vs BLE-only | Medium | Pair over BLE, act over Wi-Fi; measure both. |
| Board supply/price volatility | Low | Re-verify before purchase; nothing here is urgent. |
| Privacy of always-listening hardware | Medium | Hardware mic is a trust object. **Physical mic-mute is a must-have**, not a nice-to-have, and should be a Day-1 requirement. |

---

## 9. Decisions needed from Tharun

1. **Is Charm home/desk-only for v1?** This decides whether we need a server fallback at all. Recommended: yes.
2. **Screen-off-first acceptable?** If we want always-on AMOLED, battery expectations must change materially. Recommended: yes, screen-off-first.
3. **Physical mic-mute as a hard requirement?** Recommended: yes — it is a trust requirement, not a feature.
4. **Do we authorise the ~US$120–160 stage-gated research spend?** Recommended: Stage 0–1 only (~US$60) until the voice pipeline is proven.

---

## 10. Recommended next action

1. **Do not start hardware.** Finish the software MVP.
2. When authorised: buy **Stage 0 then Stage 1 only** (~US$60) and prove BLE pairing plus wake-word capture.
3. Publish the wake-word accuracy and measured current draw as the gate for Stage 2/3.
4. Re-open this note once the software MVP's login/Drive/chat/memory path is solid, since Charm should then extend a *working* assistant rather than define one.