# Launch film report

## Revision 2 — cinematic direction

The first render was rejected as too much like a slide deck. Revision 2 changes the visual grammar after inspecting Apple's current event presentation in the browser: one idea per beat, oversized type, long holds, continuous camera-like crops, restrained UI evidence, strong negative space, and no repeated browser-window cards. The exact Muster mascot SVG is now the reveal/end-card object; the UI is used as proof rather than as the composition itself.

## Result

Rendered three playable MP4 launch-film compositions from a package-local Remotion project:

- `out/muster-launch-16x9.mp4`: 1920×1080, H.264/AAC, 78.058667 seconds
- `out/muster-launch-9x16.mp4`: 1080×1920, H.264/AAC, 78.058667 seconds
- `out/muster-launch-1x1.mp4`: 1080×1080, H.264/AAC, 78.058667 seconds

## Verification

- `pnpm run typecheck`: passed.
- Offline narration generated with `say`, encoded to 48 kHz stereo WAV, measured at 47.609042 seconds.
- `pnpm run render`: passed for all three compositions.
- `ffprobe`: confirmed video and audio streams for every output.
- Representative frames were extracted from opening, proof, ecosystem, and close scenes and visually reviewed.

## Evidence used

All product visuals come from the repository and are listed in `assets.json`. The desktop/web scenes use `docs/screenshots/`; the mobile scene uses the App Store iPhone roster screenshot; the companion scenes use recorded acceptance clips from `.omb-scratch/verification/`. The mascot is rendered from the existing Muster orange flower family, with idle, curious, thinking, working, surprised, happy, proud, sleeping, and celebrate expressions represented in the film.

## Honesty boundary

The recorded Watch material includes pairing/companion UI and is presented as recorded acceptance evidence, not as proof that every Watch approval flow is generally available. The roadmap scene explicitly says **In progress / being verified** and names deeper Watch escalation, eval-as-a-product, cross-fleet delegation, engine parity, and native/deployment verification as ongoing work.

## URL policy

The only public URL in the film package and narration is `muster.today`.
