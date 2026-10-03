# Muster Charm — Hardware Research (Agent 4)

Date: 2026-10-03 · Author: Agent 4 (Hardware Research) · Status: **research only — no purchase authorised**
Revision: 2 (supersedes rev 1 after review)

## How to read this document

Every substantive claim is labelled. Do not mix the categories.

| Label | Meaning |
|---|---|
| **[OFFICIAL]** | Stated in the manufacturer's own documentation or store. Source and fetch date given. |
| **[ESTIMATE]** | My reasoning or a third-party figure. **Not verified.** May be wrong. |
| **[RECOMMENDATION]** | My judgement. Not a measurement. |
| **[NOT MEASURED]** | A value I did **not** measure. No hardware has been bought or tested. |
| **[MEASUREMENT PLAN]** | The specified procedure for obtaining a value later. |

> **There are ZERO [NOT MEASURED] results in this document, by definition.** No hardware has
> been bought, flashed, or measured. Every runtime, current-draw or endurance figure below is
> either an [ESTIMATE] or an open question awaiting the [MEASUREMENT PLAN] in §7.1. Nothing in
> this document is an experimental result.

## Scope and prohibitions

Per `Muster_Sub_Agent_Operating_Loop.md` → *Agent 4: Hardware Research Agent*:

- **Must not** start hardware before the software MVP. This note authorises no purchase, assembly, or flashing.
- **Must not** claim full local AI on ESP32. See §5.1 — addressed workload by workload, as an engineering expectation rather than a claimed measurement.
- **Must not** recommend expensive hardware without reason. §4 sequences cheapest-first and says why.

**Product intent, restated so it is not lost:** Charm is a **portable pocket/keychain companion** with an **interactive mascot on a screen**, that **listens** and **speaks**. A screen is central to the product, not optional. Screenless boards appear in this document only as an **optional voice test rig** (§4.3) — a way to de-risk audio cheaply — and are explicitly **not** the approved product direction.

---

## 1. What Charm is

Charm is the always-there **input/output surface** for a privacy-first personal AI OS. It captures intent, shows state through the mascot, confirms locally, and hands work to something that can reason.

It is **not** the assistant, and it does not hold long-term memory or provider keys.

---

## 2. Official specifications — the candidate board

**Source: [Waveshare official documentation, `ESP32-S3-Touch-AMOLED-1.75`](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.75), fetched 2026-10-03. All rows below are [OFFICIAL].**

| Item | Official specification |
|---|---|
| SoC | ESP32-S3R8 — Xtensa 32-bit LX7 **dual-core, up to 240 MHz** |
| Memory | **512 KB SRAM**, 384 KB ROM, **8 MB PSRAM** (stacked), **16 MB external Flash** |
| Radio | 2.4 GHz Wi-Fi 802.11 b/g/n + **Bluetooth 5 LE**, onboard chip antenna; IPEX-1 socket for an external antenna (resistor-switchable) |
| Display | **1.75" capacitive-touch AMOLED, 466×466, 16.7 M colours**, driven by **CO5300** over **QSPI** |
| Touch | **CST9217** capacitive-touch controller over I2C |
| Microphone | **Dual-microphone design with echo-cancellation circuitry**, plus a dedicated **ES7210** echo-cancellation chip |
| Speaker | **MX1.25 2-pin speaker interface** (board provides the connector; a speaker is attached) |
| IMU | **QMI8658** 6-axis (3-axis accelerometer + 3-axis gyroscope) |
| RTC | **PCF85063**, powered by the AXP2101 with a battery connection for uninterrupted timekeeping |
| Power | **AXP2101** power-management IC; onboard **3.7 V MX1.25 LiPo charge/discharge** header |
| Buttons | PWR (configurable) and BOOT |
| Storage | **TF/microSD card slot** |
| Other | **TCA9554** I/O expander; Type-C USB for flashing and serial logging; 8-pin header (3 GPIO + 1 UART) |
| Dimensions | Circular; ~45 mm class (per board dimension drawings) |
| Variants | `31261` base · `31261-B` · `31264-G` (adds **LC76G GPS** module, requires an external ceramic antenna) |
| Frameworks | Arduino IDE and ESP-IDF |

**[OFFICIAL] Price: US$29.99 – US$39.99**, with version options *GPS*, *Standard*, and *Standard with protective case*.
Source: [Waveshare official store product page](https://www.waveshare.com/esp32-s3-touch-amoled-1.75.htm), fetched 2026-10-03. This is the manufacturer's listed range, not a quote including shipping or tax.

### Why this board fits the product intent

The product needs a mascot that **moves**, **listens**, and **speaks**. This board covers all three with unusually little integration risk:

- **Speaks** — a speaker interface is already on the board. [OFFICIAL]
- **Listens** — the dual-mic array plus the dedicated **ES7210** AEC chip is the notable feature. Echo cancellation is normally the hardest part of a voice product, and here it is a **silicon feature**, not firmware the team must write. [OFFICIAL]
- **Moves / shows a mascot** — a 466×466 AMOLED over QSPI, which is the bandwidth a mascot animation needs. [OFFICIAL + ESTIMATE for the animation judgement]
- **Pocket form factor** — circular, watch-sized, with a battery connector and PWR button. [OFFICIAL]
- **Gesture rejection** — the QMI8658 IMU enables tap-to-talk and motion rejection without extra parts. [OFFICIAL]

---

## 3. ESP32-S3 variant choice

| Variant | Relevance to Charm | Verdict |
|---|---|---|
| **ESP32-S3** | BLE 5 + Wi-Fi, 512 KB SRAM, 8 MB PSRAM, vector instructions for TinyML | **Selected.** Only variant with both radios and enough memory for audio buffering plus a mascot UI. |
| ESP32-C3 | Cheapest and lowest power | **[RECOMMENDATION]** Rejected: **no Bluetooth LE**, so the companion pairing path Muster already uses is unavailable. |
| ESP32-C6 | Wi-Fi 6, Thread, Matter | **[RECOMMENDATION]** Rejected: mesh radios are not the constraint; BLE is. |
| ESP32-P4 | Higher-performance MCU, MIPI/CSI, no integrated radio | **[RECOMMENDATION]** Rejected: more cost, needs an external radio anyway. |

---

## 4. Development sequence — cheapest-first, product-led

**[RECOMMENDATION]** throughout. Ordered so that each stage answers one question and none of them presumes a product decision we have not made.

### 4.1 Stage 0 — toolchain and BLE pairing (~US$10–20)
Bare ESP32-S3 dev board. Proves: build/flash/OTA works, BLE pairs with the Mac and phone, and the mascot pipeline can be built at all.
**Nothing product-shaped is decided here.**

### 4.2 Stage 1 — the product candidate display board (~US$60–80)
Two × ESP32-S3-Touch-AMOLED-1.75 at the [OFFICIAL] US$29.99–39.99. This is where the **mascot, listening and speaking** are proven together, because that is the actual product.

### 4.3 Optional voice test rig (~US$20–40) — *optional, not the product*
A screenless ESP32-S3 audio board (e.g. Waveshare ESP32-S3-AUDIO-Board class) can be bought **only if** we want to iterate on wake-word and audio-capture quality without paying for or handling a round AMOLED each time.

**This is a developer convenience, explicitly not the product direction.** Charm has a screen and a mascot. If the rig is skipped, nothing about the product changes — it only makes audio iteration slower.

### 4.4 What is deliberately NOT in the sequence
Custom PCB, enclosure design, injection tooling, and certification. Those are Stage-4 problems, unjustified before Stage 1 passes.

---

## 5. Workload-specific capability findings

This replaces the earlier absolute claim. Each workload is assessed separately, because the answer differs sharply between them.

### 5.1 Local inference — what the SoC can and cannot do

| Workload | Verdict | Basis |
|---|---|---|
| Keyword spotting / wake word ("hey Muster") | **[RECOMMENDATION]** Feasible on-device | 240 MHz dual-core LX7 with vector instructions, 512 KB SRAM + 8 MB PSRAM — the conventional envelope for TinyML keyword spotting. |
| Small fixed-vocabulary intent classifier | **[RECOMMENDATION]** Feasible on-device | Same envelope; a few hundred KB of model fits comfortably. |
| Small audio-event classifier (smoke, doorbell, etc.) | **[RECOMMENDATION]** Feasible on-device | Same envelope. |
| Speech-to-text of useful fidelity | **[RECOMMENDATION]** **Not demonstrated or supported for the proposed workload** on this part | Aggressive quantised streaming ASR is widely reported to exceed 512 KB SRAM. *No measurement was performed here, and this is not presented as a hard silicon limit.* |
| Conversational language model | **[RECOMMENDATION]** **Not demonstrated or supported for the proposed workload** on this part | The part has no accelerator or GPU and offers 512 KB SRAM / 8 MB PSRAM. *This is an engineering expectation, not a measured or vendor-stated limit; no benchmark was run.* |

**[RECOMMENDATION]** The honest framing: on the evidence available here, Charm can reasonably be expected to do *wake* and *classify*, and is **not demonstrated or supported for the proposed workload** when it comes to *transcribing* or *reasoning*. Anything that reads like conversation should be planned to happen on the user's own machine, or on an optional remote executor (§6).

**This is an expectation, not a measurement.** No benchmark was run, and this document does not claim to establish a hard silicon limit — only that no evidence was found supporting these workloads on this part, and that the team should not plan on them without measuring.

### 5.2 Voice processing — the strongest part of this board

- **[OFFICIAL]** Dual-microphone array with echo-cancellation circuitry and a dedicated **ES7210** AEC chip.
- **[OFFICIAL]** MX1.25 speaker interface for audio output.
- **[RECOMMENDATION]** This is the reason to prefer this board over a cheaper one. Full-duplex speech (listening while speaking) is normally the hardest audio problem in a voice product, and here it is substantially solved in hardware. That is a large de-risk for a small team.

### 5.3 Mascot animation — bandwidth-feasible, power-unverified

- **[OFFICIAL]** 466×466 AMOLED driven by **CO5300 over QSPI**, 16.7 M colours.
- **[RECOMMENDATION]** QSPI bandwidth is sufficient for a sprite/part-based mascot at modest frame rates. A small mascot composed of a few dozen sprites is a modest workload; full-screen 60 fps video is not, and is not needed.
- **[ESTIMATE]** 30–60 fps for a simple sprite mascot is plausible. **Unverified.**
- **Battery impact of animation is the open question in §7 — not a solved problem.**

### 5.4 Remote assistant execution

- **[OFFICIAL]** The SoC exposes Wi-Fi and BLE; there is no on-device reasoning (§5.1).
- **[RECOMMENDATION]** Reasoning, memory writes, tool use and BYOK key handling must happen on the Mac, the phone, or an optional remote executor. This is a **design decision, not a hardware limitation to apologise for** — it is what keeps Muster's privacy promise intact.

---

## 6. Three execution options compared

All three are viable. They differ in where the user's data and audio go, which is the decision that actually matters.

| | **A. Charm + user's Mac** | **B. Charm + user's phone** | **C. Charm + optional remote executor** |
|---|---|---|---|
| **Connectivity** | Wi-Fi on the user's LAN; BLE for pairing/discovery | BLE for pairing; Wi-Fi or cellular for uplink | Wi-Fi/cellular to Muster infrastructure |
| **Privacy** | **Strongest.** Audio and reasoning stay on user hardware. | Strong, but the phone is a second device that can be updated remotely. | **Weakest.** Traffic traverses Muster infrastructure. Must be opt-in. |
| **Battery impact** | **[ESTIMATE]** Wi-Fi duty is the main draw; LAN-only avoids radio-offload cost. | **[ESTIMATE]** BLE + Wi-Fi duty; cellular adds a second radio's cost. | **[ESTIMATE]** Highest — radio must stay reachable. |
| **Offline behaviour** | Excellent while on LAN. **Degrades when away from home.** | Good; phone can queue. | Depends entirely on reachability. |
| **Development effort** | **Lowest** — reuses the existing native Mac app and the macOS lane already built. | **Medium** — needs a companion transport; Cue owns that path. | **Highest** — needs server endpoints, auth, fencing, durable receipts. |
| **Fits Muster's direction** | Directly: user-owned data, low server dependency. | Fits, with care. | Contradicts "low server dependency" unless strictly optional. |

### 6.1 [RECOMMENDATION] Position

- **A is the primary path.** It best serves privacy-first and low-server-dependency, and it reuses native Mac work that already exists.
- **B is the roaming path** and is the natural answer to A's offline weakness, reusing the companion transport the project already has for phone/Watch.
- **C should be opt-in and last.** It is the only option that weakens the privacy story, so it should exist only if A and B provably leave a real gap.

### 6.2 The tension, named rather than hidden

"Low server dependency" and "a companion that is always with the user" pull against each other: away from the user's own machines, option A cannot help. [RECOMMENDATION] Resolve by shipping **A first**, measuring whether roaming actually matters, and adding B or C only against evidence. Designing for roaming now would build the server dependency Muster is trying to avoid.

---

## 7. AMOLED battery life — an UNVERIFIED engineering question

**This is a question, not a finding.** Rev 1 of this note asserted that always-on AMOLED was "likely non-viable". That was an **[ESTIMATE]** presented with too much confidence. It is **not measured**, and the board's power-management IC (**AXP2101** [OFFICIAL]) may change the answer materially.

**[OFFICIAL]** facts that bound the question: AXP2101 power-management IC; 3.7 V LiPo charge/discharge header; PCF85063 RTC powered from the battery connection for uninterrupted timekeeping.

### 7.1 Measurement plan

**[RECOMMENDATION]** — no measurement has been performed. Method, so results are comparable and reproducible:

**Apparatus:** the board, a USB power meter or inline current measurement, a USB-serial console, and a fixed script per scenario. Log mean current and mAh over a fixed window.

| Variable | Scenarios to sweep |
|---|---|
| **Screen brightness** | 0 %, 10 %, 25 %, 50 %, 100 % |
| **Screen duty cycle** | always-off · always-on · 1 s/10 s · 1 s/60 s · on only during animation · on on interaction |
| **Display technology** | AMOLED vs an equivalent SPI LCD, same brightness and duty (isolates the AMOLED penalty) |
| **Wi-Fi** | off · associated idle · continuous ping · high-throughput transfer |
| **Bluetooth** | off · advertising · connected idle · connected streaming |
| **Microphone** | off · always-on capture · wake-word-only (duty-cycled with AXP low-power) |
| **Speaker** | off · idle · short confirmation tone · continuous playback |
| **Sleep** | ESP32 deep-sleep · light-sleep · modem/Wi-Fi power-save · RTC-only retention with screen off |
| **Animations** | static mascot · low-fps mascot (1–5 fps) · high-fps mascot (30–60 fps) |

**Metrics to report:** mean current (mA) per scenario, derived runtime (mAh ÷ mA), and the current attributable to each subsystem.

**The decision this feeds:** what the shipping default duty cycle and brightness must be, and whether an always-on mascot is viable at all. **[RECOMMENDATION]** Until this table exists, treat any runtime claim — including mine — as unfounded.

---

## 8. Microphone, speaker, battery (component view)

- **Microphone** — **[OFFICIAL]** dual-mic array + ES7210 AEC on the candidate board. Cheaper boards have a single MEMS mic, which makes full-duplex harder. **[RECOMMENDATION]** Prefer the AEC board for the product; the single-mic path is acceptable only if half-duplex (stop listening while speaking) is acceptable.
- **Speaker** — **[OFFICIAL]** MX1.25 2-pin interface on the board. A small 8 Ω mylar speaker is appropriate for desk/pocket range. **[RECOMMENDATION]** Include audio output: speaking is part of the product intent, so this should not be deferred as rev 1 suggested.
- **Battery** — **[OFFICIAL]** 3.7 V LiPo via MX1.25, charged and discharged by the AXP2101. **[RECOMMENDATION]** Capacity selection must wait on §7.1 measurements; choosing a cell before measuring current is how prototypes end up with the wrong endurance.

---

## 9. Budget — itemised, with source and date

**[OFFICIAL]** unit price for the product candidate board: **US$29.99 – US$39.99**, Waveshare store, fetched 2026-10-03, variant-dependent.

| Stage | Items | Basis | Cost |
|---|---|---|---|
| 0 — toolchain + BLE | 2 × bare ESP32-S3 dev board | **[ESTIMATE]** third-party pricing, **unverified** | ~US$10–20 |
| 1 — product candidate | 2 × ESP32-S3-Touch-AMOLED-1.75 | **[OFFICIAL]** US$29.99–39.99 each | **~US$60–80** |
| 2 — optional voice rig | 1–2 × screenless ESP32-S3 audio board | **[ESTIMATE]** third-party, **unverified** | ~US$20–40 |
| — LiPo cells + speakers | 2 × 3.7 V cell, 2 × 8 Ω speaker | **[ESTIMATE]** **unverified** | ~US$10–20 |

**Totals:**
- **Stages 0 + 1 only: ~US$70–100.** This is the honest "prove the product concept" figure.
- **Stages 0–2 plus cells/speakers: ~US$100–140.**

**What changed from rev 1, and why.** Rev 1 quoted **US$120–160** built on the assumption that the cheapest board was the right starting point. That was wrong twice over: it under-weighted the product board (the thing actually being prototyped) and used unverified prices as if they were sourced. The revised figures are lower, better sourced, and cover the actual product candidate.

**Excluded from all figures:** shipping, tax, PCB, enclosure, tooling, certification.

**Re-verify every price before purchase.** Only the product board's price is [OFFICIAL]; the rest are [ESTIMATE] and have not been checked against a live checkout.

---

## 10. Risks and blockers

| Risk | Severity | Note |
|---|---|---|
| Battery life unknown | **High** | §7 is unmeasured. Blocks any runtime claim. |
| "Local AI on ESP32" expectation | **High** | §5.1 closes this off; must be restated before hardware work starts. |
| Always-listening hardware is a trust object | **High** | **[RECOMMENDATION]** A **physical mic-mute** should be a Day-1 product requirement, not a later feature. |
| Off-LAN usefulness | Medium | Deferred by choice (§6.2); Charm is home/desk-first for v1. |
| Firmware OTA / fleet management | Medium | Fine for one device, unsolved for a hundred. Out of scope until Charm exists. |
| ESP32-S3 silicon availability | Low | **[OFFICIAL]** parts are in normal distribution; no supply concern identified. |
| GPS variant temptation | Low | **[OFFICIAL]** the `-G` variant adds an LC76G module needing an external antenna. **[RECOMMENDATION]** Do not buy it for v1; location is not needed for a desk/pocket companion. |

---

## 11. Decisions needed from Tharun

1. **Is Charm home/desk-only for v1?** This determines whether option A alone is sufficient, or whether B (phone) is required at launch.
2. **Is an always-on mascot display acceptable as a goal, given §7 is unmeasured?** If battery forbids it, the mascot becomes interaction-driven rather than ambient — a real product-design change.
3. **Is a physical microphone mute a hard v1 requirement?** Recommended: yes. It is a trust requirement for always-listening hardware.
4. **Is ~US$70–100 authorised for Stages 0 + 1, and is anyone authorised to purchase?** No purchase is authorised by this document.

---

## 12. Recommended next action

1. **Do not start hardware.** The software MVP (login, Drive sync, chat, memory, sessions, tasks, restore) is unaffected by this note.
2. Get answers to §11 — they are cheap and they unblock real work.
3. When authorised, buy **Stage 0 + Stage 1 only**, and run the **§7.1 measurement plan**. Publish the current/brightness/duty table as the gate.
4. Re-open this note once the MVP's login/Drive/chat/memory path is solid, so Charm extends a working assistant rather than defining one.