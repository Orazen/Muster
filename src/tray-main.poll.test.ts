// The tray's slim poll (performance-heavy-users-study, slice A2): the
// 3-second roster tick joins the proven `?messages=0` path the web
// reconcile and the fleet MCP already use, so a visible tray stops
// re-downloading the fleet's transcripts every pass. Per house pattern
// (teach-replay.test.ts), the wiring itself is pinned as source text — the
// module runs in a DOM (document/window at import time) and cannot be
// imported under the node test env — while the rendering contract is
// exercised on the pure tray-state view model with a payload shaped exactly
// like the slim feed: id/name/activity/hidden must all still arrive.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveTrayView, type TrayBotInput } from "./lib/mascot/tray-state";

const source = readFileSync(fileURLToPath(new URL("./tray-main.ts", import.meta.url)), "utf8");

describe("tray slim poll", () => {
  it("polls the roster without transcripts, through the shared constant", () => {
    expect(source).toContain('export const TRAY_BOTS_URL = "/api/bots?messages=0"');
    // the fetch reads that constant — one source of truth, nothing to drift
    expect(source).toMatch(/fetch\(\s*TRAY_BOTS_URL\b/);
    // and no second, literal URL to fall back to a fat poll
    expect(source).not.toMatch(/fetch\(\s*["'`]/);
    // nothing rendered ever comes out of a transcript
    expect(source).not.toMatch(/\.messages\b/);
  });

  it("still drops hidden bots before rendering", () => {
    // hidden is a roster field messages=0 keeps; the filter is what makes
    // the hidden-fleet tray stay quiet
    expect(source).toMatch(/\.filter\(\s*\(bot\)\s*=>\s*!bot\.hidden\s*\)/);
  });

  it("renders id, name and activity out of a messages-free payload", () => {
    // exactly the fields the slim feed still carries — no transcript, no
    // leaf history, nothing derived from messages
    const payload: Array<TrayBotInput & { hidden?: boolean }> = [
      { id: "bot-ada", name: "Ada", color: "#e06000", busy: true, streaming: "step", activity: "working" },
      { id: "bot-bo", name: "Bo", color: "#3050e0", unread: true, activity: "waiting-on-you" },
      { id: "bot-cy", name: "Cy", color: "#20a060", hidden: true },
    ];

    // same pipeline the poll callback runs: filter, then resolve
    const { bots, mood } = resolveTrayView(payload.filter((bot) => !bot.hidden));

    expect(bots.map((view) => view.id)).toEqual(["bot-ada", "bot-bo"]);
    expect(bots.some((view) => view.id === "bot-cy")).toBe(false);

    // activity survives: waiting-on-you takes both focus and the mood
    expect(mood).toBe("attention");
    const focus = bots.find((view) => view.focus);
    expect(focus?.id).toBe("bot-bo");
    expect(focus?.name).toBe("Bo");
    expect(focus?.line).toBe("Done — Bo has news");

    // the busy/streaming facts the tray narrates arrive without messages
    expect(bots[0]?.status).toBe("thinking");
    expect(bots[0]?.line).toBe("Thinking about Ada's next step");
  });
});
