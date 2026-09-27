// The desktop canvas tile's heading. One desktop is shared by every bot, and
// the tile used to name whichever teammate the server's dedupe happened to
// keep last — a label that is wrong for everyone and wrong differently each
// boot, so nobody reports it as obviously broken.
//
// Both halves of the contract are pinned here: the server must not claim a bot
// identity for a shared desktop, and the client must not invent one when the
// id is empty.

import { describe, expect, it } from "vitest";
import { SHARED_DESKTOP_LABEL, canvasTileTitle } from "./DesktopCanvas";

const bots = new Map([["bot-ada", "Ada"], ["bot-zoe", "Zoe"]]);
const nameOf = (id: string): string => bots.get(id) ?? "Desktop";

describe("canvasTileTitle", () => {
  it("names the bot on a per-bot tile", () => {
    expect(canvasTileTitle({ botId: "bot-ada", label: "9f2c1a0b4d5e6f70" }, nameOf)).toBe("Ada");
  });

  it("never names a teammate on the shared desktop", () => {
    // THE regression. The pre-fix build resolved botName(botId) here, and the
    // server had already reduced three bots to one entry with an arbitrary
    // botId, so this tile was captioned with a real teammate's name.
    const tile = { botId: "bot-ada", label: SHARED_DESKTOP_LABEL };
    expect(canvasTileTitle(tile, nameOf)).toBe("All bots");
    expect(canvasTileTitle(tile, nameOf)).not.toBe("Ada");
  });

  it("does not depend on the empty id to reach the shared answer", () => {
    // Belt and braces: the server now sends botId:"" for shared, but an older
    // server (or a cached response) still carries an id. The label alone must
    // be enough, or the bug returns on a version skew.
    for (const botId of ["", "bot-ada", "bot-zoe", "deleted-bot"]) {
      expect(canvasTileTitle({ botId, label: SHARED_DESKTOP_LABEL }, nameOf)).toBe("All bots");
    }
  });

  it("falls back to a neutral heading when a per-bot id no longer resolves", () => {
    expect(canvasTileTitle({ botId: "bot-gone", label: "abc123" }, nameOf)).toBe("Desktop");
    expect(canvasTileTitle({ botId: "", label: "abc123" }, nameOf)).toBe("Desktop");
  });

  it("keeps the shared label pinned to the wire value the server sends", () => {
    // A rename on either side of this boundary must fail here rather than
    // silently re-open the mislabeling.
    expect(SHARED_DESKTOP_LABEL).toBe("shared");
  });
});
