// Tray window script — the desktop tray companion (plan slice D).
// Renders the mascot and the fleet's narrated lines from GET /api/bots,
// the same owned local feed the web app folds. One bot in focus (the one
// that needs you), the rest as face+line. No framework, no router, no new
// transports: a 3-second poll while visible, paused when hidden (the
// visibility-pausing rule from the character plan).
//
// The flower artwork imports the REAL body path and pose channels — the tray
// draws exactly the character the web app draws, one source of truth.
import { MUSTER_BODY } from "@/components/MusterMascot";
import { FLOWER_POSES, poseFor, type FlowerPose } from "@/lib/musterbot/flower";
import { resolveTrayView, type TrayBotInput } from "@/lib/mascot/tray-state";

/** Slim roster poll: the tray draws only names, status lines and focus
 * (src/lib/mascot/tray-state.ts), never transcripts — messages=0 keeps
 * the 3-second tick at KB scale instead of re-downloading the fleet's
 * history every pass while visible. */
export const TRAY_BOTS_URL = "/api/bots?messages=0";

const flowerBody = document.querySelector<SVGGElement>(".flower-body");
const flowerSvg = document.querySelector<SVGSVGElement>("#flower");
const flowerPath = document.querySelector<SVGPathElement>("#flower-path");
const statusEl = document.querySelector<HTMLDivElement>("#status");
const linesEl = document.querySelector<HTMLDivElement>("#lines");
const quietEl = document.querySelector<HTMLDivElement>("#quiet");
const eyes = document.querySelectorAll<SVGRectElement>(".flower-eye");

if (flowerPath && MUSTER_BODY) flowerPath.setAttribute("d", MUSTER_BODY);

type EyeChannels = Pick<FlowerPose, "edy" | "edx" | "tilt" | "esx" | "esy" | "edy2" | "esx2" | "esy2" | "tilt2">;

function eyeTransform(channels: EyeChannels): string {
  const dy = channels.edy ?? 0;
  const dx = channels.edx ?? 0;
  const tilt = channels.tilt ?? 0;
  const sx = channels.esx ?? 1;
  const sy = channels.esy ?? 1;
  return `translate(${dx}px, ${dy}px) rotate(${tilt}deg) scale(${sx}, ${sy})`;
}

let pollTimer: number | undefined;
let stopped = false;

function faceFor(view: { status: string; focus: boolean }): void {
  if (!flowerBody || !flowerSvg) return;
  // The focused bot's face carries the flower; a settled/error fleet face
  // comes from the status itself (success→happy, error→mad, working→focused).
  const moodFace =
    view.status === "error" ? "mad"
    : view.status === "finished" ? "happy"
    : view.status === "working" || view.status === "thinking" || view.status === "uploading" ? "focused"
    : "idle";
  // SAFETY: poseFor returns a FlowerPoseName and FLOWER_POSES is keyed by
  // exactly that union, so the lookup always yields a FlowerPose — the
  // assertion only narrows away the idle-record union member TS can't see.
  const pose = FLOWER_POSES[poseFor(moodFace)] as FlowerPose;
  const body = flowerBody.querySelector<SVGGElement>("g") ?? flowerBody;
  body.style.transform = `translate(0px, ${(pose.bdy ?? 0).toFixed(1)}px)`;
  eyes.forEach((eye, index) => {
    eye.style.transform = eyeTransform({
      edy: (pose.edy ?? 0) + (pose.edy2 ?? 0) * index,
      edx: (pose.edx ?? 0) * (index === 0 ? -1 : 1),
      tilt: ((pose.tilt ?? 0) * (index === 0 ? -1 : 1)) + (pose.tilt2 ?? 0) * index,
      esx: (pose.esx ?? 1) * (1 + (pose.esx2 ?? 0) * index),
      esy: (pose.esy ?? 1) * (1 + (pose.esy2 ?? 0) * index),
    });
  });
  flowerSvg.classList.toggle("breathe", view.status === "working" || view.status === "thinking");
}

function render(bots: TrayBotInput[]): void {
  const { bots: views, mood } = resolveTrayView(bots);
  const focus = views.find((view) => view.focus);
  faceFor(focus ?? { status: mood === "settled" ? "finished" : "idle", focus: false });
  if (statusEl) {
    statusEl.textContent =
      mood === "attention" ? "Waiting on you"
      : mood === "working" ? "Agents working"
      : mood === "settled" ? "Work settled"
      : "All quiet";
  }
  if (linesEl) {
    linesEl.replaceChildren(
      ...views
        .filter((view) => view.line)
        .slice(0, 4)
        .map((view) => {
          const row = document.createElement("div");
          row.className = "line";
          row.textContent = view.line;
          return row;
        }),
    );
  }
  if (quietEl) quietEl.hidden = bots.length > 0;
}

async function poll(): Promise<void> {
  if (stopped) return;
  try {
    const response = await fetch(TRAY_BOTS_URL, { headers: { accept: "application/json" } });
    if (response.ok) {
      // SAFETY: the /api/bots feed is our own local server's JSON; the tray
      // renders only the fields typed below and tolerates absence of the rest.
      const payload = (await response.json()) as { bots?: Array<TrayBotInput & { hidden?: boolean }> };
      render((payload.bots ?? []).filter((bot) => !bot.hidden));
    }
  } catch {
    // The embedded server restarts on update; a failed poll just waits for
    // the next tick. No error UI in a 320px window.
  }
}

function schedule(): void {
  if (stopped) return;
  pollTimer = window.setTimeout(async () => {
    await poll();
    schedule();
  }, 3_000);
}

document.addEventListener("visibilitychange", () => {
  // Visibility pausing: hidden tray polls nothing.
  if (document.hidden) {
    stopped = true;
    window.clearTimeout(pollTimer);
  } else if (stopped) {
    stopped = false;
    void poll();
    schedule();
  }
});

void poll();
schedule();
