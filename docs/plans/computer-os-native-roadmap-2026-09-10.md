# Computer, remote access, Muster OS, and native-client roadmap

**Research snapshot: 2026-09-10. Handoff for GLM 5.3 Flash and subsequent maintainers.**

Muster already contains computer destinations, shared/per-bot local desktops,
browser previews, a companion service, and `/os`. The immediate work is to
make capability claims match execution, guide setup and recovery, and obtain
real runtime evidence. A replacement operating system or a second transport
stack is not the next slice. The current mascot/onboarding work belongs to
the root maintainer; this document changes no product behavior.

## Evidence boundary and pinned references

- Muster inspected at `f006fa9f1b8ebc199da1209b6c900e4c9c685ea5`.
- [OpenMausBot source](https://github.com/milind-soni/OpenMausBot/tree/ca61118787f687749eb1251bc3007e4d7d7bdd93):
  `ca61118787f687749eb1251bc3007e4d7d7bdd93`, committed 2026-09-10 07:06:35 UTC;
  its package declares `0.1.71`. Previous 0.1.69 research remains historical.
- [Rome source](https://github.com/rome-os/rome/tree/2f79d9158982851608d97d305984fe7a10ab5b7f):
  `2f79d9158982851608d97d305984fe7a10ab5b7f`, committed 2026-09-10 06:30:15 UTC.
- Both public repositories were inspected through shallow, no-checkout clones
  in an isolated scratch directory. Only source blobs were fetched. No
  repository scripts, dependency installation, applications, containers or
  VMs were executed. README descriptions are product claims; the source paths
  below establish implementation presence, not successful runtime behavior.
- The user's pasted engine-count, Computer, Browser, Local VM and remote
  Settings descriptions are reference claims. Do not freeze “12 engines” as
  an acceptance contract or import their claims into Muster marketing.
- Read-only host check: Docker CLI exists at `/opt/homebrew/bin/docker`;
  selected context is `colima`, pointing at the existing default Colima
  socket. `colima status` reported **not running**. Other listed contexts are
  `default` and `desktop-linux`; their daemon health was not checked. Nothing
  was started, stopped, reconfigured, or downloaded as a runtime image.
- **This research ran 0 tests, 0 builds, 0 browser interactions and 0 native
  UI checks.** Existing verification remains in
  [the UI/E2E matrix](ui-e2e-program.md) and [CEO log](ceo-log.md); it must not
  be recounted as new evidence.

## What the references actually contribute

| Reference | Source-backed observation | Implication for Muster |
| --- | --- | --- |
| OpenMausBot terminal entry | Its [CLI onboarding guide](https://github.com/milind-soni/OpenMausBot/blob/ca61118787f687749eb1251bc3007e4d7d7bdd93/docs/cli-onboarding.md) separates agent-provider sign-in, optional phone access and the product account. AI setup can finish before phone setup; a failing remote check must leave local use available. | Keep the first useful local task independent of optional remote/cloud configuration. Explain subscription versus API access without promising that all engines have equivalent tools. |
| OpenMausBot desktop client | [Desktop companion design](https://github.com/milind-soni/OpenMausBot/blob/ca61118787f687749eb1251bc3007e4d7d7bdd93/docs/desktop-companion.md) and `electron/desktop-companion-client.mjs` describe separate host/client roles, an Electron relay, device-scoped access and a return to local mode. The client retains bundled UI rather than merely loading any remote URL. | Reuse Muster's companion contract if implementing desktop-to-desktop access. Explicitly distinguish it from cloud-account pairing and self-host claim links. |
| OpenMausBot VM inventory | [`server/local-vm-inventory.ts`](https://github.com/milind-soni/OpenMausBot/blob/ca61118787f687749eb1251bc3007e4d7d7bdd93/server/local-vm-inventory.ts) discovers existing bot-derived desktops even when a bot changes destination, checks managed status before arming idle cleanup, and projects a small public inventory. | Add a restart/recovery inventory before promising per-bot desktops automatically clean themselves up. Do not expose workspace paths or viewer credentials in that inventory. |
| Rome runtime lifecycle | [`RuntimeProvider`](https://github.com/rome-os/rome/blob/2f79d9158982851608d97d305984fe7a10ab5b7f/packages/desktop/src/main/runtime/provider.ts) defines explicit host check, runtime start, image pull, app start, health, ready, stop and failure phases. `manager.ts` owns lifecycle and retry decisions. | Give Muster's existing lifecycle a clear operation identity and phase contract. “Starting” should not mean downloading, booting and ready at once. |
| Rome setup UI | [`OnboardingPage.tsx`](https://github.com/rome-os/rome/blob/2f79d9158982851608d97d305984fe7a10ab5b7f/packages/desktop-base-web/src/pages/OnboardingPage.tsx) shows step status, elapsed waits, retry actions and pull progress that avoids jumping backward during retry. | Use truthful phase progress and persistent recovery actions. Keep image size and storage requirements available before download rather than adopting every presentation choice. |
| Rome macOS boundary | [Desktop-runtime architecture](https://github.com/rome-os/rome/blob/2f79d9158982851608d97d305984fe7a10ab5b7f/docs/architecture/desktop-runtime.md), `packages/desktop/src/main/runtime/providers/lima.ts` and `local-proxy.ts` specify a bundled Linux guest, host loopback proxy over a Unix socket, userspace networking and durable home outside disposable VM state. The documented floor is Apple Silicon/macOS 13; initial app-container download is still required. | This is a source reference for a later self-contained runtime. It does not prove first launch is offline or that Muster should immediately bundle Lima. Retain existing working provider contracts while measuring setup failures first. |
| Rome apps | Its [app model](https://github.com/rome-os/rome/blob/2f79d9158982851608d97d305984fe7a10ab5b7f/README.md) combines manifests, typed actions, agents, UI and persistent app data; the repository contains runtime/web SDKs. | Eventually give repeated work a durable interface backed by Muster's approval and evidence contracts. Merely drawing a dock does not establish executable app lifecycle or an app marketplace. |

Do not restate the references' competitor comparisons, security language,
platform certification or release claims as independently verified facts.

## Current Muster: present, missing, and unverified

“Present” below means source inspected. It does not fill a runtime test cell.

| Surface | Present in Muster | Missing or incomplete | Still unverified |
| --- | --- | --- | --- |
| Engine setup | `server/drivers/builtIn.ts`, `server/harness/registry.ts`, `src/components/EnginesSettings.tsx`, `NoEngines.tsx`, `Onboarding.tsx` provide discovery, setup and multiple driver families. | One plain-language capability explanation per selected engine: chat, tools, computer destinations, account prerequisite and actionable failure. Registered drivers are not interchangeable working connections. | Real provider sign-in and a real task through every advertised combination. Existing fake ACP results do not establish this. |
| Computer destinations | `ComputerPanel.tsx`, `server/computer-control.ts`, `computer-proxy.ts`, `local-computer.ts`, `box.ts`, `vps-computer.ts`, `opensandbox.ts`, `vm-bootstrap.ts`; routes in `server/index.ts`. | A tested destination decision path for “where will my work run?”, with recovery that preserves the selected bot and task. | Cloud provisioning, VPS SSH/viewer, OpenSandbox, actual screenshots and human takeover in this audit. Paid/provider activation remains a board escalation. |
| Local VM | `container-computer.ts` has Docker/Podman/Apple-container discovery, pinned Cua base and driver, prepare/create/start/stop/remove, durable workspace and loopback viewer. `LocalComputerSection.tsx` has the setup controls. | Unified observable setup phases, clearer storage/download prerequisites and a proven recovery experience. The Docker-on-macOS start path attempts Colima then Docker; a Linux Docker start requires a user-visible sudo path. Do not imply identical automatic setup on every OS. | Real cold/warm start, image preparation, desktop readiness, stop/recreate and retained files. Colima being stopped means these are not currently demonstrated. |
| Shared/per-bot desktops | `perBotLocalVmTarget`, `local-vm-lease.ts`, `local-vm-idle.ts`, `server/index.ts` target pools, cap fence and `config.ts` isolation setting already exist. | Restart discovery/status for all existing per-bot targets. The inspected startup backstop checks the shared target; per-bot timers are armed on allocation. This is an audit target, not a demonstrated destructive incident. | Two real bots on separate desktops, shared lease exclusion, cap exhaustion, surviving restart, viewer-port collision recovery and retained workspace. Viewer ports are digest-derived within 128 slots, so collisions deserve a bounded test. |
| Browser panel | `server/browser-panel.ts` owns per-bot Chromium, bot/guest profiles, navigation and screencast. `BrowserPanel.tsx` shows frames and a URL field. Routes are `/api/bots/:id/browser-panel/*`. | **Concrete claim mismatch:** `setTakeControl` only changes a boolean. The inspected routes do not attach agent tools or forward pointer/keyboard input, while the banner says the bot pauses. A displayed image is not an interactive remote browser. `server/obscura.ts` is a separate agent-browser path. | Real profile persistence, guest cleanup, failed install/start, frame reconnect, reliable process ownership and an actual shared human/agent session. Navigation validation must not be weakened just to make fixtures easier. |
| Phone/remote access | `CompanionSection.tsx`, `electron/companion.mjs`, `companion/src/`, `src/lib/companion-pairing.ts`, cloud `pairing.ts`, `claim.ts` and `desktop-auth.ts` implement distinct access paths. | No equivalent desktop host/client role switch was found in the inspected Electron entry/preload. A connected account, a paired phone and a remotely controlled desktop must have different UI states. | Physical QR, Bonjour, Tailscale off-network behavior, native notification-to-task, device revocation and desktop-to-desktop relaunch. Test only disposable devices/sessions. |
| `/os` | `src/App.tsx` gates the route; `DesktopShell.tsx`, `Window.tsx`, `AgentWindow.tsx`, `RoomsWindow.tsx`, `CommandBar.tsx` and `app-manifests.ts` supply agent windows, Rooms, focus, minimize/restore and command UI over the existing store. | Window stack/geometry are component state, so reload persistence is absent. The singleton registry currently contains Rooms only. Small-screen window layout, keyboard movement and exact pending-task navigation need audit before further apps. | Window gestures, keyboard/focus, room actions, command recipient, reload, and cross-surface approval targeting. `/os` is a browser shell, not a Linux guest OS or native execution proof. |
| Native clients | Electron packaging/bridges, Swift iOS/Watch source and Expo React Native Android companion source exist. | Native verification setup described below; current web checks cannot substitute. Android source is `android-companion/`, not the stale handbook `android/` path. | All packaged Electron/iOS/Watch/Android UI in this audit program. |

## Ranked slices and acceptance contracts

Execute one row at a time. Use the current mandate's relevant typecheck,
focused tests and full-suite gate for code commits, then log real counts.
Numbers in the acceptance column describe required cases, **not passed tests**.
Root's ongoing mascot/onboarding slice has precedence; do not overlap its files.

| Rank / bounded slice | Intended files | Acceptance evidence |
| --- | --- | --- |
| 1. Make Browser control truthful | `src/components/BrowserPanel.tsx`, `server/browser-panel.ts`, matching focused tests | If shared-session control is not implemented in this slice, label it a preview and remove pause/takeover promises. Verify no agent pause is claimed by toggling a cosmetic flag; navigation, stop, retry and bot/guest switching remain usable. Browser checks at 320/390/1440px and on keyboard. |
| 2. Guide Local VM readiness and recovery | `LocalComputerSection.tsx`, `container-computer.ts`, small lifecycle route changes in `server/index.ts` only if needed | Fixtures cover missing runtime, stopped runtime, preparation failure, boot/health failure and retry. One owned runtime run then proves prepare → create → ready → stop → resume/recreate, with a file surviving in the durable workspace. Report download time/size and host dependencies separately. No real runtime setup is implied by rendering its steps. |
| 3. Inventory and recover per-bot desktops | New narrowly scoped inventory helper plus `container-computer.ts`, `server/index.ts`, Local VM inventory UI | Existing desktops remain discoverable after destination changes and process restart; missing/unmanaged containers are distinguished; lifecycle cannot remove another owner's active desktop. Two owned targets prove separate files/viewers, cap enforcement and a deliberate port collision. Advance idle time through an injected clock, not an eight-hour blocking test. |
| 4. Make `/os` usable as a workspace | `os/DesktopShell.tsx`, `Window.tsx`, `CommandBar.tsx`, relevant state helper only | Open/focus/minimize/restore/close; reopen after reload if persistence is implemented; clamp geometry after viewport changes; compact single-window mode on phones; Escape/focus return. With two pending bots, attention and a command must target the exact bot/task. Halt controls act only on this fixture's owned work. |
| 5. Prove a shared human/agent browser session | Browser manager plus one explicit adapter boundary and focused panel controls | The agent and viewer observe the same target/profile. Human takeover obtains an actual ownership fence; in-flight/stale agent actions cannot continue; release resumes deliberately. Verify disconnect, target closure, stale element, navigation race and profile mismatch. Use isolated runtime fixtures; never attach the user's logged-in browser or count a boolean banner as success. |
| 6. Simplify remote-access selection | `CompanionSection.tsx`, pairing helpers and Electron companion bridge | Local workspace remains useful when remote setup fails/cancels. Clearly distinguish cloud account pairing, self-host claim and phone companion. Exact synthetic device identity, one-time expiry/reuse, reconnect and notification-to-task must pass locally before a physical off-network leg. No managed tunnel, new provider or paid service activation without the board's existing escalation process. |
| 7. Execute native acceptance in separate client slices | Electron first, then iOS, Watch and Android paths below | Each client reports core tests, build, UI interactions and physical-device results separately. Failure in one client does not halt independent local web work. Do not report an installed app's version as proof it contains current main. |
| 8. Add one durable `/os` work app | `os/app-manifests.ts` plus one bounded app backed by current server contracts | Start with an approvals/evidence desk or routine scorecard, not an SDK ecosystem. Persist its data, preserve exact thread targets and existing approval requirements, and demonstrate the interface remains useful after chat/reload. A broader app runtime or bundled Lima migration needs its own measured problem and ADR first. |

Commercial priority: reduce abandonment before the first useful task, prove
reliable recovery, and make repeated work inspectable. Measure setup phase
completion, time to first successful owned task, retries and reconnect success
with clear denominators. Proposed metrics are not collected outcomes or a
license to enable telemetry. Live pricing, checkout, new provider wiring,
public launch and spending decisions remain with the board.

## Native execution prerequisites and smallest credible runs

The earlier read-only inventory in `ui-e2e-program.md` found Xcode 26.6,
Swift 6.3.3, XcodeGen, available shutdown iOS/watchOS simulators, Java 17,
Android SDK/images and an AVD. This research did not repeat or execute them.

| Client | Preparation and paths | First credible acceptance run |
| --- | --- | --- |
| Electron | `electron/main.mjs`, `preload.cjs`, `capabilities.cjs`, `cua.mjs`, `companion.mjs`, `electron-builder.yml`. Establish an exact build SHA and a launch wrapper that isolates both Electron `userData` **and** `OMB_DATA_DIR` before credentials are loaded. The prior audit found the development Electron executable missing; installed `/Applications/Muster.app` freshness is unverified. Resolve that prerequisite deliberately rather than accidentally downloading a runtime by probing it. | Owned profile launch/relaunch, auth/pairing, fake-engine conversation/approval, native external-link/dialog behavior, then capability-denied and capability-ready paths. Screen Recording/Accessibility/dictation permissions and actual host control require separate native evidence. macOS-only host control in current `capabilities.cjs` must not be advertised as Windows/Linux parity. |
| iOS | `ios/Package.swift`, `ios/project.yml`, `ios/Sources/CompanionCore`, `ios/App`, `ios/TESTING.md`; exact simulator/build destination and isolated companion server. `swift test --package-path ios` covers core contracts; app build is a separate XcodeGen/Xcode stage. | Simulator pairing, roster/task/chat/approval, keyboard/safe areas and reconnect; then a physical phone for camera QR, Bonjour/network permissions, background delivery and exact notification target. Do not reuse old captured fixtures as evidence of current live transport. |
| Watch | `ios/Watch/WatchViews.swift`, `WatchSession.swift`, `MusterWatchApp.swift` and project targets; paired simulator/device topology and a disposable account/device record. Verify the actual target names in `project.yml` when executing. No UI test target was found in the earlier inventory. | Approval appears once, Allow/Deny reaches the exact thread, stale/duplicate decision has a readable result, reconnect preserves pending work. Simulator navigation and actual watch delivery are separate reports. |
| Android | `android-companion/App.tsx`, `src/screens/`, `app.json`, `package.json`, `eas.json`. Repair the previously observed missing icon/splash/adaptive-icon assets and absent `jest-expo` preset; validate the EAS config against the selected CLI before use. Prefer a local build/emulator for the first slice. No EAS cloud job is authorized by this document. | Pairing → roster → chat and approval, IME/safe areas, permission denial, background/reconnect and unpair on disposable state. A phone browser passing is not React Native passing; the current root navigator does not declare a separate Settings screen. |

No simulator boot, native installation, runtime image download, new network
listener or physical-device mutation occurred in this research. When the next
slice needs one, act only within its authorized owned fixture scope and leave
the existing demo on `127.0.0.1:8845` untouched. Production checks remain GET
only; never use production sessions to test revocation or teardown.

## Licensing and implementation handoff

Rome's pinned root [LICENSE](https://github.com/rome-os/rome/blob/2f79d9158982851608d97d305984fe7a10ab5b7f/LICENSE)
is **MIT**, not missing. The notice requires retention in copies/substantial
portions. This is an observed repository term, not a completed legal review of
all bundled assets or dependencies. No Rome code, image, mascot, font or
binary was transplanted. For any later reuse, identify the exact file and SHA,
its applicable notice and third-party exceptions, preserve required notices,
and review bundled Lima/guest/native dependencies separately. A root license
does not make every embedded asset or trademark interchangeable.

OpenMausBot's pinned [licensing document](https://github.com/milind-soni/OpenMausBot/blob/ca61118787f687749eb1251bc3007e4d7d7bdd93/LICENSING.md)
states Apache 2.0 outside `enterprise/`, a separate enterprise license inside
it, and separate third-party terms. Keep its enterprise implementation and
branding out of Muster unless the applicable rights are established. Current
research supplies behavioral references and original acceptance contracts;
it does not authorize copying restricted code. Muster remains private under
its existing BSL terms. Product UI should use Muster-owned names/art and
documentation destinations, not GitHub links.

Handoff procedure: read `AGENTS.md`, the CEO mandate, the latest CEO log and
the relevant row above; inspect git status; confirm which root-owned slice is
active; claim a bounded file set. Reproduce the specified failure before
changing its behavior. Record expected versus observed evidence, test counts,
fixture/real-runtime distinction and retained limitations. Pull/rebase and
commit/push through the existing one-slice discipline. Do not widen this
roadmap into simultaneous browser, VM, native and app-runtime rewrites.
