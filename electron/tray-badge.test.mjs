// Menu-bar status item (tiptour study, slice 5). The badge rules are pure,
// so what the tray icon reads is testable without an Electron runtime; the
// cross-check pins the main-process count to the tray window's own count
// (src/lib/mascot/tray-state.ts) over one payload, so the icon beside the
// menu bar and the mascot window can never disagree about who is waiting.
import { describe, expect, it } from "vitest";
import { badgeText, countWaitingOnYou, pendingMenuLabel, trayTooltip } from "./tray-badge.mjs";
import { countWaitingOnYou as countInWindow } from "../src/lib/mascot/tray-state";

function bot(activity, extra = {}) {
  return { id: `bot-${activity ?? "idle"}`, name: "Mimi", color: "#f08a24", activity, ...extra };
}

describe("pending count", () => {
  it("counts only bots waiting on a human, from either payload shape", () => {
    const payload = { bots: [bot("waiting-on-you"), bot("working"), bot("waiting-on-you"), bot()] };
    expect(countWaitingOnYou(payload)).toBe(2);
    expect(countWaitingOnYou(payload.bots)).toBe(2);
    expect(countWaitingOnYou({ bots: [bot("working")] })).toBe(0);
    expect(countWaitingOnYou({ bots: [] })).toBe(0);
  });

  it("excludes hidden bots and tolerates a malformed feed as 0", () => {
    expect(countWaitingOnYou({ bots: [bot("waiting-on-you"), bot("waiting-on-you", { hidden: true })] })).toBe(1);
    expect(countWaitingOnYou(null)).toBe(0);
    expect(countWaitingOnYou(undefined)).toBe(0);
    expect(countWaitingOnYou({})).toBe(0);
    expect(countWaitingOnYou({ bots: "nope" })).toBe(0);
    expect(countWaitingOnYou({ bots: [null, 42, { id: "x" }, "waiting-on-you"] })).toBe(0);
  });
});

describe("badge text", () => {
  it("is empty at zero and the plain count below ten", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
  });

  it("caps a pile-up so the menu bar cannot be shoved around", () => {
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(1_000)).toBe("9+");
  });

  it("reads a non-count as nothing rather than printing junk", () => {
    expect(badgeText(-3)).toBe("");
    expect(badgeText(Number.NaN)).toBe("");
    expect(badgeText("3")).toBe("");
    expect(badgeText(undefined)).toBe("");
  });
});

describe("tooltip and context-menu read-out", () => {
  it("says the count when someone waits and just the app when quiet", () => {
    expect(trayTooltip(0)).toBe("Muster");
    expect(trayTooltip(2)).toBe("Muster — 2 waiting on you");
    expect(pendingMenuLabel(0)).toBe("Nothing waiting on you");
    expect(pendingMenuLabel(1)).toBe("1 waiting on you");
  });
});

describe("same count as the tray window", () => {
  it("the menu-bar icon and the mascot window agree over one payload", () => {
    const payload = {
      bots: [
        bot("waiting-on-you"),
        bot("working"),
        bot("waiting-on-you", { id: "bot-hidden", hidden: true }),
        bot("waiting-on-you", { id: "bot-asked", busy: false }),
        bot(),
      ],
    };
    // The window filters hidden bots before render (src/tray-main.ts); the
    // main-process count filters them itself — same number either way.
    expect(countWaitingOnYou(payload)).toBe(
      countInWindow(payload.bots.filter((candidate) => !candidate.hidden)),
    );
    expect(countWaitingOnYou(payload)).toBe(2);
  });
});
