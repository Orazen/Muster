# Muster vs OpenMausBot — surface map (components and server modules)

Written 2026-09-17. Source-grounded comparison of the two working trees on this
machine:

- Muster webapp: `/Users/ramagiritharun/muster-audit` (this repo, `main` @ `075577d`)
- OpenMausBot: `/Users/ramagiritharun/OpenMausBot` (`github.com/milind-soni/OpenMausBot`,
  `main` @ `f0bd967`, app version 0.1.82 installed, README badge v0.1.37)

Method: read-only `ls`/`comm` of `src/components`, `src/lib`, and `server` in
both trees, plus the installed app's accessibility tree. **No OpenMausBot test
was executed and no OpenMausBot code was copied.** "Missing" below means *no
file with that name exists in Muster*, not that the behavior is absent —
several are likely renamed equivalents and are flagged as such.

This map supplements `docs/plans/openmausbot-parity-plan-2026-09-17.md`, which
sets the feature work; it does not replace or re-open that plan.

## 1. The headline finding

Muster is a **fork of OpenMausBot**, not a from-scratch app that happens to be
similar. The two share almost the entire internal surface:

- Chat core (`ChatView`, `Composer`, `ApprovalCard`, `OptionCard`, `ModelPicker`,
  `ComputerPanel`, `GroupView`, `GroupCallView`, `RoutinesPage`, `WebhooksPanel`,
  `TeamLibraryPanel`, `SettingsModal`, `Sidebar`, …) is present in both, usually
  byte-for-byte in name.
- Server subsystems the parity plan calls "parity" are confirmed present in both
  at the module level: `member-turn.ts`, `steer-queue.ts`, `repeat-detector.ts`,
  `turn-watchdog.ts`, `remote-computer.ts`, `vps-computer.ts`, `delegations.ts`,
  `chief-of-staff.ts`, `routines.ts`, `team-library.ts`, `team-manifest.ts`,
  `webhooks.ts`, `webhook-ingress.ts`, `composio.ts`, `box.ts`.

So the useful question is not "what does OMB have that Muster lacks" in the
abstract — it is "which OMB files have no Muster counterpart, and of those,
which represent a real user-facing gap versus a rename or a deliberate
divergence."

## 2. Components in OpenMausBot with no same-named file in Muster

22 files. Grouped by likely meaning:

| OpenMausBot component | Likely Muster status |
|---|---|
| `PhoneSetupFlow.tsx`, `SidebarPhoneButton.tsx` | **Real gap** — OMB's guided phone/companion handoff. Muster has `CompanionSection.tsx` and `pairing-flow.ts`; the in-shell "set up your phone" flow is not present. Matches parity-plan slice on phone handoff. |
| `SkillRecorderPage.tsx` | **Real gap** — OMB's skill-recorder page. No Muster counterpart. |
| `LocalScreenPreview.tsx`, `MacLocalControl.tsx`, `LinuxLocalControl.tsx`, `LocalComputerAutoWarning.tsx` | **Real gap** — OMB's local-computer control + preview surface. Muster has `LocalComputerSection.tsx` but not the platform-specific control panels. |
| `CloudBackendPicker.tsx` | **Likely gap** — OMB's cloud-computer backend chooser. Muster has `ComputerPanel.tsx`; verify whether the picker is folded in. |
| `SecretRequestCard.tsx` | **Likely gap** — OMB's credential-request card (the `request_credential` flow seen live in the app). Muster has `VaultSection.tsx`; verify. |
| `ManageMembersPanel.tsx`, `RoomTurnTimeoutSettings.tsx` | **Real gap** — OMB's channel/room member + turn-timeout UI. Muster has rooms only in `src/components/os/`. |
| `TeamMapPage.tsx` | **Likely gap** — OMB's team map page. Muster has `TeamLibraryPanel.tsx` but not the map page. |
| `ActivityRun.tsx` | **Likely rename** — OMB's grouped tool-step runs. Muster renders activity inline in `ChatView`/`TimelineStrip`; verify grouping parity. |
| `AttachmentPreview.tsx` | **Likely rename** — Muster has `ComposerAttachments.tsx`. |
| `TurnPresence.tsx` | **Likely rename** — Muster has `TimelineStrip.tsx` / `MusterMascot.tsx` presence work. |
| `ReplyQuote.tsx` | **Likely gap** — quote-reply. Muster's `ChatView` may inline it. |
| `TranscriptionSettings.tsx` | **Likely gap** — OMB transcription provider settings (AssemblyAI). Muster has `VoiceSettings.tsx`. |
| `BotPickerList.tsx`, `BotProfileAvatarCard.tsx` | **Likely rename** — Muster has `Avatar.tsx`, `bot-profile/`. |
| `ConnectionDetail.tsx`, `CursorMark.tsx`, `AndroidDevicePanel.tsx` | **Verify** — small presentation pieces; may be folded into Muster's larger components. |

## 3. Server modules in OpenMausBot with no same-named file in Muster

16 modules: `avatar-image`, `bot-directory`, `bot-package`, `bot-profile`,
`checkpoints`, `cloud-backend`, `installed-playbooks`, `local-routing`,
`package-export`, `replies`, `room-turn-timeout`, `section-context`,
`skill-fetch`, `skill-library`, `skills`, `vps-container-mcp`.

The notable ones:

- **`skills.ts`, `skill-library.ts`, `skill-fetch.ts`, `installed-playbooks.ts`**
  — OMB's skill system. Muster has `plugins/muster-engineering` and
  `ServerSkills`-adjacent work but no matching server modules. This is the
  largest server-side gap.
- **`bot-package.ts`, `package-export.ts`, `bot-directory.ts`, `bot-profile.ts`**
  — bot packaging/export. Muster has `TemplatesModal.tsx` and
  `workspace-bundle`/`team-library`; verify overlap.
- **`checkpoints.ts`** — conversation branching/checkpoints. Muster has
  `branching.test.ts` but no `checkpoints.ts`; verify.
- **`local-routing.ts`** — where a turn runs (local vs cloud). Muster has
  `profile-environment.ts`, `local-computer` control; verify.

## 4. `src/lib` helpers in OpenMausBot with no same-named file in Muster

19 files. The ones that look like real behavior rather than renames:
`activity-runs.ts`, `connected-apps-cache.ts`, `live-activity.ts`,
`local-computer.ts`, `replies.ts`, `room-members.ts`, `room-turn-timeout.ts`,
`screen-preview.ts`, `skill-recorder.ts`, `taskTimeline.ts`, `team-map.ts`,
`transcription-status.ts`, `unread.ts`, `vps-computer.ts`,
`assemblyai-transcription.ts`, `phone-setup.ts`, `feature-flags.ts`,
`compact-chip.ts`, `page-visible.ts`.

Several map to parity-plan slices directly: `phone-setup.ts` → phone handoff;
`connected-apps-cache.ts` → connected-apps catalog; `screen-preview.ts` →
computer panel preview; `room-*` → channels in `/app`.

## 5. Where Muster is deliberately ahead (do not regress)

Muster has ~76 server modules and ~40 components with no OMB counterpart —
auth, billing, vault, receipts, why-journal, approval history/rehearsal,
fleet-* (delegation/eval/evidence/mcp), social, telegram/whatsapp sync, license,
privacy-shield, portable backup v2, muse/musterbot. These are Muster's own
product surface and must be preserved, per the standing stability contract in
`AGENTS.md` and `docs/guides/web-app-stability.md`.

## 6. Recommended use of this map

Feed the "real gap" rows in §2 and the skill/system rows in §3 into the
already-ranked slices in `openmausbot-parity-plan-2026-09-17.md` rather than
opening new ones. The parity plan's ordering (remote-access client mode →
engines add-account → channels in `/app` → connected-apps catalog → tour
pacing → voice W1–W3 → mobile edges) still holds; this map only sharpens which
files each slice touches.

## 7. Not verified

- No OpenMausBot or Muster test suite was run for this map.
- "Likely rename" rows were inferred from file names, not from reading both
  implementations. Confirm by reading before treating any as missing.
- Component counts are file counts, not capability counts.
- The installed app inspection (accessibility tree only) does not prove runtime
  behavior of any listed feature.