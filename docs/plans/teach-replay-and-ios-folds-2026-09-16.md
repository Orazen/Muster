# Teach-by-Demonstration, Fold-Aware iOS, and the reference sweep

Researched 2026-09-16 from seven sources the owner supplied, plus Apple's Human
Interface Guidelines. This is a plan, not a claim of work done.

## 1. TeachReplay — the feature to port

**What it is.** A harness-agnostic "teach-by-demonstration" engine: instead of
writing automation code, a person demonstrates a task once and the system
compiles it into a reusable, parameterised skill. Validated on live Linux boxes
over SSH, Apache-2.0.

**The loop, as its own README describes it:**
teach → record → compile → replay → verify, with "an explicit verdict — never
silent success."

**What it actually captures.** A versioned trajectory of clicks, typed values
and shell commands. Values that were demonstrated become *inputs* with the
original as the default. Verification is not a vibe: the recorded condition
must hold, and a failure names the broken step.

**Two design choices worth stealing outright:**

1. **"Roles and names, not pixels."** Semantic grounding tolerates mild UI
   drift and fails loudly on severe drift. Anything pixel-addressed would be
   broken by the next app update.
2. **The core has zero harness dependencies**, enforced by an automated test.
   Adapters add backends, stores and event sinks; they never leak into the core.

**Why this fits Muster specifically.** Muster's whole product is *repeat briefs
to remote bots* — the user asks for the same class of thing over and over with
different inputs. That is exactly the shape a compiled skill addresses. And
Muster already has the pieces the loop needs: a durable thread/transcript
store, a tool-activity stream, an approval broker that can gate a step before
it runs, and a sidecar that speaks to the machine doing the work.

**Honest limitations from the source, carried forward:** recording polls state
around every 500 ms so fast actions can merge; clicks are inferred and
ambiguous changes record nothing; model-assisted recovery is optional; replay
is SSH-bound at roughly 4 s/step. None of these are disqualifying, but a plan
that pretended the feature was free would be lying.

### Proposed shape in Muster

- `teach_start` / `teach_stop` on a bot: record the demonstration.
- `teach_compile`: deterministic, no model in the loop, producing a versioned
  skill artefact stored beside the bot.
- `teach_replay(skillId, inputs)`: step-verified execution, returning a verdict
  object — `{ ok, failedStep?, observed, expected }` — never a bare success.
- Approval integration: a compiled skill that will run shell commands goes
  through the same approval broker as any other tool call. This is not
  optional. A taught skill that bypasses the approval path would be a
  privilege-escalation hole by construction.
- The pure parts — trajectory schema, parameter substitution, the verifier —
  belong in a testable module with no Electron, no network, no harness, in the
  same spirit as `electron/companion-settings.mjs` and
  `ios/Sources/CompanionCore`.

**Effort.** The pure core plus tests is a bounded piece of work. The replay
backends (local shell, remote GUI) are where the real cost lives, and each
backend is its own decision.

## 2. The fold / glass effect projects

**FrostFold** (iOS, MIT) makes the interface appear fixed in space while the
phone tilts: a Metal `layerEffect` casts rays from a fixed eye through the
tilted screen onto the interface plane, blurs by separation, dims, and paints
black where rays miss. Its README states the constraint that matters most:
*everything under the effect must be pure SwiftUI*, flattened with a
compositing group — UIKit-backed views like `ScrollView` are not rasterised.

**DuoBook** (macOS, MIT) is the same optics driven by the real lid-angle sensor
(HID page 0x20, usage 0x8A, polled at 120 Hz on a dedicated thread because
input reports arrive about once per second), with ScreenCaptureKit streaming
the built-in display.

**iphone-duo** is a *browser* Three.js study of the same idea — it is not
native iOS code, and should not be treated as an implementation reference.

**Recommendation: do not build this into Muster yet.** The honest assessment is
that it is a striking demo with a narrow product fit. In Muster's companion the
transcript is a scrolling UIKit-backed view, which the FrostFold constraint
explicitly excludes. Adopting it would mean rebuilding the chat surface as pure
SwiftUI to serve an effect that does not make anyone's bots more useful. Worth
revisiting for a *showcase* — a landing-page demo or a marketing screen — not
for the app.

## 3. NightBloodRemote — CarPlay as the comparison

An experimental iPhone companion for a coding agent, with a SwiftUI portrait
app, a Live Activity extension, and **a native CarPlay surface**. It uses
full-duplex WebRTC audio, TrueDepth gaze input, a P-256 identity anchored in
the Secure Enclave with a Face ID check before sessions, and Keychain storage
limited to the device.

**The relevant idea for Muster is the surface split, not the voice stack.**
NightBloodRemote ships the same product on three surfaces — phone, lock screen,
car — with a native UI on each rather than one view squeezed into three shapes.
Muster's watch app already follows this instinct (it deliberately refuses
search, screen-watching and routine management because a 45 mm display is the
wrong place for them). CarPlay would extend the same reasoning: a driving
surface shows *what needs you* and nothing else.

**Recommendation: note it, do not start it.** CarPlay needs an Apple
entitlement approval that is its own external gate, on top of the Developer
account work already pending. It belongs in the backlog behind TestFlight
shipping at all.

**Worth taking now, cheaply:** the credential-boundary pattern — a native
credential store that the web layer cannot reach. Muster's iOS app already
keeps tokens in the Keychain via `App/Keychain.swift`, so this is a
confirmation rather than a change.

## 4. Errand — a validation, not a template

An Electron + React + TypeScript macOS app giving each AI teammate a cloud
computer, with a live noVNC desktop view, persistent conversations, and
OS-backed credential encryption. Architecturally it is *the same shape as
Muster's desktop app* — Electron main owning auth and an allowlisted broker, a
typed preload bridge, a React renderer.

**The finding is the convergence, not a gap.** Two independent projects arrived
at the same architecture, which is mild evidence Muster's is right. Nothing
here needs porting.

## 5. fwc-swiftui-skills — adopt for iOS work

A pack of Agent Skills for SwiftUI on iOS 26+, MIT, following the Agent Skills
spec. Each skill is `skills/<name>/SKILL.md` with YAML frontmatter and an
optional `reference.md`. Cloned to `/tmp/fwc-swiftui-skills` for reference.

Two skills ship today:

- **`swiftui-liquid-glass`** — implementing and reviewing iOS 26+ Liquid Glass
  with native APIs, patterns and pitfalls. **Directly applicable**: Muster's
  `ios/App/Glass.swift` already implements a native-glass-with-material-fallback
  wrapper, and this skill is the authoritative reference for whether that
  implementation is idiomatic.
- **`swiftui-iphone-duo`** — fold-safe layout and hinge interactions. Not
  applicable until foldable iPhones ship.

**Recommended action:** vendor the liquid-glass skill's guidance into the repo
as a reference document and audit `Glass.swift` against it in a future pass,
rather than installing a global skill that only one project uses.

## 6. Apple Human Interface Guidelines

**The fetch returned only navigation chrome** — Apple's HIG is a client-rendered
page and the body did not come through. Rather than invent a summary, this
section is deliberately empty. The guidelines are the right north star and
should be consulted directly for any specific surface; a fabricated
paraphrase would be worse than no section at all.

**What can be said from the sources that did load:** every iOS project reviewed
here leans on native APIs rather than imitation — Liquid Glass via
`glassEffect`, fold effects via Metal `layerEffect`, runtime sessions via
`WKExtendedRuntimeSession`. That is consistent with the guidelines' core
insistence on platform fidelity, and it is already how Muster's iOS app is
built.

## 7. Security constraint carried into any implementation

Per the standing constraint: any server-side URL fetching must allow only
`http` and `https`, validate the host before the request, and reject
localhost, loopback, private and reserved addresses. The TeachReplay replay
backend is exactly such a surface if it ever fetches, and must honour this from
the first commit.

## Recommended order

1. **Ship TestFlight** — the IPA is built; only the Issuer ID is missing.
2. **TeachReplay's pure core** — trajectory schema, parameter substitution,
   verifier — in a harness-free module with tests. This is the genuinely
   valuable feature in the set.
3. **Audit `Glass.swift` against the liquid-glass skill.**
4. **Fold effects** — only as a showcase, never in the transcript.
5. **CarPlay** — backlog, behind the entitlement.
</system-reminder>