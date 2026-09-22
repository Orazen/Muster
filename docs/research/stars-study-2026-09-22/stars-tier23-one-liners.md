# Tier 2/3 — monitoring one-liners and dismissals

Tier 2 = monitor (relevant-adjacent, revisit when its slice opens). Tier 3 = dismissed (with reason). Date: 22 Sep 2026.

## Already covered by existing docs (link, don't re-research)
- `qunqin24/grokbot-animation` (fork), `scrya-com/grokbot-animation`, `zhulin025/LaoA-GrokBot`, `casquijo/openmaus-avatar-preview`, `pftq/GrokBot`, `ajagatobby/grokbot-landing-page`, `hackyguru/botato-website` → already covered: `docs/research/mascot-character-study-2026-09-18.md`, `docs/plans/landing-reference-study-2026-09-10.md`.
- `oomol-lab/open-connector` → already attached: Muster Connector (Loop107).

## Tier 2 — monitor
- `trycua/assume` (HTML, 25.9k★): computer-use 2.0 drivers + **benchmarks** — revisit for bench:roles harness intel and eventual bot-computer slice.
- `idan-rubin/browseshot` (75★): snapshot + ref browser automation from OpenClaw lineage — revisit when bot-web-actions slice opens.
- `jkudish/askshot` (236★): browser use via typed model — same trigger.
- `browser-use/ultrafast` (17.2k★): fastest/cheapest web agent — same trigger.
- `TheoLeeCJ/SemIf` (3.5k★): semantic ifs on a 3090 — monitor for local typed-judgment serving.
- `githubnext/localjev` (712★), `typesafe-ai/skills` (1.7k★), `dbreunig/building-with-typed-skill` (128★), `codeitlikemiley/typed-sdk-rust` (3★): typed-judgment ecosystem — monitor for grading/grading-intel as typed models mature.
- `NiazMorshed2007/askreview` (201★): continuous quality review by coding agents — revisit for bench:roles grading intel.
- `raihankhan-rk/shotdrama` (7★): two agents duel in click-only browser games — fun eval-harness idea; revisit for eval variety.
- `raihankhan-rk/diffjury` (7★): PR risk router + review coach — revisit for fix-bundle grading.
- `monid-ai/monid` (337★): "OpenRouter for agent tools" — revisit as Plugins/connector backend alternative.
- `alesha-pro/tools` (419★): 4x3090 local-inference benchmarks + ComfyUI workflows — bench-config intel.
- `ARahim3/kaggle-tpu-lab` — tier1-engines (open-model serving).
- `web_states_website` (141★): cinematic video websites — www intel only.
- `CelestoAI/assume` (959★): secure persistent computer for agents — revisit with bot-computer slice.
- `browser-use/life-recorder` (313★): Swift life-recorder — monitor for walkie context capture (privacy-heavy; needs research-first).
- `EldanRing/askshot` (7★): real private computer on your machine for any agent — revisit with bot-computer.
- `totec448-spec/chat-on-steroids` (3.8k★): local MCP for ChatGPT with Goal, Compact & Resume — pattern intel for resumable turns.
- `Kunchenguid/grok-ship` (177★): turn a work agent into a software factory — workforce slice intel.
- `davila7/claude-code-templates` (30.9k★): configure + monitor coding agents — workflow intel.
- `pavanjoshi914/Reframe` (28★): desktop screen recorder + editor — www/marketing intel.
- `eracle/OpenOutreach` (3.1k★): B2B lead-gen agent — workforce business-task slice idea.
- `elder-plinius/CL4R1T4S` (50.1k★) + `asgeirtj/system_prompts_leaks` (68.0k★): extracted system prompts — prompt-design research only; never adopt verbatim; treat as untrusted content.
- `elayadesign/ai-design-skills` (2.3k★) + `FloWritesCode/fwc-swiftui-skills` (336★): coding-agent skill packs — monitor for companion dev velocity.
- `ever-co/ever-gauzy` (7.8k★): ERP/CRM/HRM open platform — workforce business intel only.
- `wechaty` — tier1-infra (channels).
- `agentgram` / `oasis` — tier1-competitors (social).
- `meetopenbot/openbot` (339★), `beevibe-ai/beevibe` (345★), `lingosandi/agent-web-os` (310★), `avibe-bot/avibe` (506★), `jaylfc/taOS` (544★), `nuwax-ai/nuwax` (890★), `CoWork-OS/CoWork-OS` (457★), `stereOS` (496★, Nix), `agentlas-ai/Agentlas-OS` (1.1k★), `spyrae/kronos-agent-os` (52★), `PhyAgentOS/PhyAgentOS-core` (2.5k★), `memovai/mimiclaw` (5.8k★), `lahfir/agent-desktop` (1.5k★): the "Agent OS" wave — monitor the genre; cherry-pick only per-slice (durability, accessibility-based computer use, hub+orchestrator). `lahfir/agent-desktop` is the strongest: accessibility-based computer use (sees real UI structure) — revisit before any pointer-automation choice.
- `GeminiLight/MindOS` (677★): human-AI collaborative mind system, synced across agents — compare with workspace-brain ranking; monitor.
- `HazAT/glimpse` — tier1-ux (micro-webview).
- `skye-reader/cloud-sky` (56★): threejs volumetric sky — www background intel only.
- `askmaddyy/FrostFold` (11★): Metal frosted-glass tilt UI — companion polish intel.
- `iAmVishal16/ScrollAnimation` (3★): iOS 17 scroll transitions — companion polish intel.
- `humation-labs/humation` — tier1-agent-core (avatar engine).
- `Alain00/blobatar` (1170★): blob avatars — blobatar mentioned in AGENTS.md; check whether our blobs already use it; monitor for avatar pack ideas.
- `legeling/awesome-codex-pet` — tier1-ux (installable pet actions).
- `CodeUpdaterBot/assume` — tier1-mobile (sensor consent).
- `MagsnapMZ/magsnap-ai-watchos` (1★): watch-first AI companion — watch design intel.
- `lhfer/visionclaw` (4★): 3D AI companion for Vision Pro — dismissed for now (no visionOS target).
- `apoorvdarshan/scowld` (22★): iOS companion with live VRM avatar, BYOK vision/speech — companion design intel.
- `zhulin025/BuddyLiveGF` (89★): work-agent dynamic skins — mascot skin intel.
- `mpociot/claude-siri-ai` (218★): macOS 27 App Intents model delegation — monitor for Siri/App-Intents delegation on watch/watchOS.
- `jonnyoo/glance` (1.3k★): Face Unlock for Mac — desktop identity intel.
- `hieunc229/Pie` (59★): native macOS GUI for a coding agent — desktop teardown intel.
- `mecls/kinas` (7★): local Mac app running operations on AI agents — desktop teardown intel.
- `DeepanshuMishraa/assume` (24★, fork): native app for coding agents — genre monitor.
- `Dadmin88/Family-Planner` (7★): family wall planner with Google Calendar — plan-my-day intel.
- `Dadmin3d/agent-profile-packs` (7★): curated agent profile packs — persona content source.
- `tt-a1i/archify` (695★): verifiable architecture-diagram skill — plan artifacts/why-journal visuals intel.
- `buzzkit-dev/buzzkit` — tier1-infra (notification orchestration).
- `Paymug/paymug` (17★): sell digital products — marketplace monetization intel (future).
- `hieunc229/leaderbid` (7★): bidding leaderboard — dismissed for now.
- `Wasims07/OrcaShot` (4★): privacy-first BYOK chat in browser — www demo intel.
- `gtgg123124/vrchat-assistant` (24★): VRChat MCP monitor — dismissed (no VR target).
- `ClawArgus/ClawArgus` (11★): autonomous research agent with cross-validated investigations — deep-research slice idea.
- `Tencent-Hunyuan/HY-World-2.0` (2667★): 3D world model — dismissed (no 3D target).
- `diffusionstudio/editor` (3036★): video editor built for agents — marketing-video monitor only.

## Tier 3 — dismissed (reason)
- Personal/profile repos (`cubxxw/cubxxw`): not a library.
- Ticketing/storefront/dental/dental-site/YT-sync/Omegle-style/family-UI repos: unrelated products.
- Attendance systems (4 repos: AI attendance, RFID+ESP32, prototype site, QR+geolocation): unrelated.
- `jgamblin/agent-mirai` (9.5k★): leaked IoT malware source — research-only risk; do not clone.
- `whiskerrs/whisker` (136★): Rust mobile UI framework (Lynx) — we are native Swift/SwiftUI.
- `kuuky29/UniRoot`, `code-update/assume` forks, `ZhengyiLuo/AssumeDock`, `Elie222/hi-new`, `Zhengyi3d/zero` forks, other forks with no delta: noise.
- `santhiprakash/freshlane`, `luxesmile-dental-site`, `thatcreativetayo/shotdrama`: template products.
- `mpociot/teamd` (PHP): Laravel teams — our server is TypeScript.
- `soxoj/telegram-bot-dumper` (384★): forensic dumper for Telegram bots by token — security-sensitive; do not use against third-party bots.
- `VisionAssistantPro` (54★): NVDA assistant — Windows accessibility; no Windows target.
- `hypit-ai/hypit` (13.4k★): viral-video cloning agents — legal/policy risk; not for the fleet.
- `bingreeky/JIT`, `ZYRAXON-AI`, `sintra-AI` clones, `Elysia-AI`, `GreatUI` (221★, React polish only), `tailwind-panda-starter`, `dental` repos: template/polish noise.
- Forks of starred repos (`DivyamTalwar/*` set, `zhulin025/*` forks, `hieunc229/paymug-app`, `qunqin24/assume` fork): identical upstream already tiered.
- `milind-soni/assume` (645★): pointer automation — tier1-ux (teardown), no integration now.
