# Robotics and ecosystem research — references, mapping, and what to steal

Date: 2026-09-09. Inputs: the links in the standing research request
(github.com/orgs/autonomous-ai, langgenius/mosoo, muse.ai, Apple HIG,
OpenRouter free models) plus this session's shipped work (Watch companion,
Telegram cloud sync, nex-agi driver). This is a study document — nothing here
is committed to the roadmap; each section ends with what Muster already has
and what is worth revisiting when the time comes.

## 1. autonomous-ai (the Open Interpreter family) — the robotics half

Current shape of the org (checked 2026-09-09):

| Repo | What it is |
|---|---|
| autonomous-computer | "Personal AI Data Center" — the flagship consumer product (~1.4k stars) |
| autonomous-os | Open-source OS for robots, "brings them to life upon installation" (~315 stars); absorbed autonomous-lamp |
| autonomous-robot | ROS 2 sim-to-real learning platform for robotics development |
| autonomous-grid | "AI intranet": network computers you already own for inference and training (~245 stars) |
| autonomous-intern | "Personal AI Device" |
| autonomous-key | NFC tap to unlock a smartphone into autonomous mode |
| autonomous-desk / -chair / -pod | Open-hardware furniture (CAD + electronics + assembly), BLE/Wi-Fi sensing |
| autonomous-terminal, autonomous-vibe | Terminal client; "vibe hardware" chat-to-device |
| picoclaw | Go agent fork, "deployable anywhere" |

The pattern is coherent: they are building the **physical layer** of personal
autonomy — the computer, the desk it sits on, the OS that boots robots — the
way Muster is building the **organizational layer** (fleet, approvals, goals,
mail). The two stacks meet at an obvious seam:

**The seam: a ROS 2 driver as a Muster bot.** Muster's driver abstraction
(claude/codex/opencode/openrouter process drivers, each owned by a bot) is
not conceptually different from a ROS 2 node wrapper: a long-lived process
that speaks a narrow protocol, reports activity chips, and can be
interrupted. A `robot` driver kind — one bot = one robot or one ROS graph
namespace — would let the existing machinery apply unchanged to physical
actuators:

- **Approvals are already the hard part.** Physical action is where
  human-in-the-loop stops being a compliance feature and becomes a safety
  one. `held:` cards ("why auto mode stopped to ask anyway"), the deny-first
  button order the Watch app just shipped, and always-allow grant keys
  (`Bash:git`-shaped) map directly onto `Bash:git` → `Actuator:gripper`
  shaped grants. Nothing in the approval pipeline assumes software.
- **Tool activity chips become telemetry.** `spoken:` lines are already
  designed for voice; a robot's chip stream is the same shape.
- **The Watch companion is the safety surface.** An e-stop that lives on the
  wrist and works when the robot is on another network is the approval view
  we already built, minus the chat.

**Sequencing (later, in order):**
1. Study `autonomous-robot`'s ROS 2 sim-to-real loop and `autonomous-os`'s
   boot story — "OS installed → robot alive" is the same promise as "Muster
   installed → agents alive", and their boot-time discovery is worth
   comparing against our Bonjour sidecar.
2. Prototype a read-only `robot` driver: subscribe to a ROS topic, surface
   it as activity chips, no actuation. Proves the driver seam with zero
   safety surface.
3. Only then consider actuation behind the existing approval pipeline, with
   physical actions **never** eligible for always-allow — a policy change,
   and the single most important rule in this whole document.

**autonomous-grid** is the nearer-term idea worth stealing: users already run
multiple machines with Muster; "network the computers you already own" maps
to multi-machine fleets (see `docs/plans/multi-tenancy-design.md`), with
grid's twist being *shared inference* across them. The nex-agi/OpenRouter
free-tier integration (`server/drivers/openrouter.ts`) makes "my old Mac
serves the free models my laptop's bots use" a real configuration.

## 2. mosoo (langgenius / Dify team) — the publish-and-run shape

mosoo: "The open-source Agent Gallery and Gateway for Codex, Claude Agent
SDK, and OpenCode." Developers publish an agent once behind one HTTP API;
users run it in an isolated cloud sandbox with no local harness setup.
Topics: agent-api, agent-control-plane, agent-gateway, agent-gallery,
agent-runtime, agent-sandbox, cloud-agents, mcp, cloudflare, self-hosted.
TypeScript, Apache-2.0, mosoo.ai.

What Muster has already (independently, different pole): hi.new agent mail
(bot-to-bot and human-addressed), SOUL.md persona export/import
(`server/soul-md.ts`, the Hermes pattern adapted — unknown sections import
cleanly), bot templates (`docs/bot-templates/`), and a restricted sidecar
contract that is effectively our "one API behind an agent".

What mosoo is worth rereading for, when bot **sharing** becomes a product
question:

- **"Publish once, run anywhere" for bot definitions.** The unit is not a
  container — it is the agent's definition (persona + permissions + tools).
  Muster's SOUL.md is already 70% of that artifact; a versioned,
  content-addressed publish step (gallery semantics) is the remaining 30%.
- **Sandbox isolation as the trust boundary.** mosoo's answer to "run a
  stranger's agent" is a cloud sandbox with no local harness. Muster's
  answer has been the default-deny companion policy. If templates from
  strangers ever run here, the sandbox question must be answered first —
  their Cloudflare-sandbox design is the reference to study, not to adopt
  (it conflicts with Muster's local-first promise).
- **Gallery as distribution.** A Muster template gallery (import a SOUL.md,
  get a configured bot) is a natural extension of the existing template
  docs — but publishing is an outward-facing act and stays out of scope
  until asked for.

## 3. Voice, memory, and the personal layer (muse.ai et al.)

muse.ai's differentiator — deep search across stored media ("find the moment
in the video where…") — is the memory search problem. Muster's transcript
store already does full-text search over SQLite; the muse.ai-shaped gap is
**semantic** recall over the same corpus (embeddings over transcripts,
returned as SearchHit-shaped results with a snippet and a jump target). The
interface contract already exists; only the index would be new. Park until a
driver with cheap embeddings is a default (the free-tier OpenRouter models
make this closer than it was).

Voice in Muster today: speakReplies + per-bot voice selection, voice-mode
docs, and now dictation on the Watch. The Apple HIG pass (below) governed
the watch side: voice input arrives through the system keyboard's dictation
affordance rather than a Speech-framework pipeline — no mic permission, no
transcription code, and the affordance users already know.

## 4. Apple HIG — what was applied to the Watch app

The watchOS guidance that changed real decisions in `ios/Watch/`:

- **Glanceable, actionable, minimal** — the fleet screen is approvals first
  ("Needs you"), then bots, then rooms. No task lists, no settings sprawl.
- **Short-burst interaction**: replies are a dictated sentence through the
  system keyboard, not a composed message; the transcript view keeps the
  last 20 messages and says so in the README ("what did it just say", not
  "what did it say in March").
- **Destructive actions need friction**: Deny renders before Allow and
  carries the destructive tint; "Always allow" appears only when the card
  carries a grant key. An accidental wrist tap should cost the bot a retry,
  not run a command.
- **Every notification must earn its haptic**: one `.notification` tap when
  the approval count rises, one `.success` when settled — never on every
  frame. Watch battery is the currency.
- **Independent watch app** (`WKApplication`, `WKRunsIndependentlyOfCompanionApp`):
  pairs straight to the computer — the phone is not a hub, so the watch
  works when the phone is off, which is the entire point of a wrist e-stop.

## 5. Cloud storage framework — the shipped answer

The request was: all information lives in the user's own cloud storage,
free, synced to their account — nothing of record on the device or our
servers. Shipped this session, two legs:

- **Telegram as a sync backend** (`server/telegram-sync.ts`, 12/12 tests):
  the user's own Telegram account is the storage provider via a bot chat —
  Saved Messages pattern — carrying ciphertext only; the server never sees
  plaintext and holds no key material. Free, no new account, works on the
  phones people already have.
- **Google Drive** (shipped earlier): `drive.appdata` scope, granted at
  Google sign-in, per-account app-scoped folder, same ciphertext rule.

The design rule both legs share, worth restating for future providers:
**BYO account, zero-knowledge payloads, no Muster-operated relay.** Any new
provider (Dropbox, S3, iCloud) must pass the same three-part test before it
gets a transport. The Watch and phone companions hold no sync state at all —
the computer is the sync origin; companions are viewers.

## 6. Free-model integration — shipped

`server/drivers/openrouter.ts` gained the free-tier catalog including
nex-agi (`nex-n2.5-mini:free`, `nex-n2.5-pro:free`, vision on Pro) alongside
GLM 5.2, Inkling, and the Nemotron 3 family, with `openrouter/free` auto
routing. Tests in `server/drivers/openrouter.test.ts`. The strategic point
recorded in the driver comment: a free tier means a Muster install is useful
before any API key is purchased, which changes the first-run story more than
any single model quality difference.

## 7. Standing decisions this research reinforces

1. Local-first stays. Every cloud capability above is BYO-account or
   off; nothing moves toward Muster-operated storage or relays.
2. The approval pipeline is the moat. It is the component robotics would
   reuse first and the component we should keep driver-agnostic.
3. Companions stay thin. Watch and phone are viewers of the harness's
   truth; the moment a companion keeps its own state, the no-optimistic-
   writes discipline dies and with it the single-source-of-truth promise.
4. Publishing/sharing waits for the sandbox answer. Galleries and template
   markets are downstream of a trust boundary, not upstream of one.
