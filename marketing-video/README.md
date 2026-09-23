# Muster launch film

An isolated Remotion production package for the Muster launch film. It does not change the root Vite app, server, routes, sessions, or marketing site.

## Outputs

- `out/muster-launch-16x9.mp4` — 1920×1080, 30 fps
- `out/muster-launch-9x16.mp4` — 1080×1920, 30 fps
- `out/muster-launch-1x1.mp4` — 1080×1080, 30 fps

All renders are approximately 78 seconds and include local AAC narration generated with macOS `say`.

## Render locally

```bash
cd marketing-video
pnpm install --ignore-workspace
pnpm run typecheck
pnpm run voice
pnpm run voice:encode
pnpm run render
```

The renderer is `src/index.tsx`; the shared film is `src/LaunchFilm.tsx`. `assets.json` records the source path and evidence status for every visual.

## Film language

The film uses the real Muster product vocabulary: persistent workers, per-bot memory/model/computer, human-owned approvals, receipts, approval history, desktop/web, MusterMobile, and companion/Watch evidence. The roadmap scene is deliberately titled **In progress / being verified**. It does not present deeper Watch escalation, the eval harness, cross-fleet delegation, engine parity, native verification, or deployment verification as shipped.

Only `muster.today` appears as the public URL in the film. No external product UI or stock media is used. Device frames are neutral presentation shells around repository-owned screenshots/recordings.

## Free tools

- Remotion: the render engine and composition system.
- Reframe: optional open-source local screen recorder for future clean captures.
- Keyloom: optional MIT Remotion scene reference for future component expansion.
- Vawe: optional later JSON/social-cutdown experiment; not required for these renders.

## Voice

`narration.txt` is the reviewed script. `public/voice.aiff` and `public/voice.wav` are local generated artifacts; no cloud voice provider or credentials are required.
