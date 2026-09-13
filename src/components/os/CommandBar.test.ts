import { describe, expect, it } from "vitest";
import { parseCommand } from "./CommandBar";

const bots = [
  { id: "jarvis", name: "Jarvis" },
  { id: "orchard", name: "Orchard", chiefOfStaff: true },
];

describe("OS command parsing", () => {
  it("opens rooms from explicit command", () => {
    expect(parseCommand("open rooms", bots)).toMatchObject({
      openApp: "rooms",
      botId: null,
      targeted: false,
      text: "open rooms",
    });
  });

  it("targets by name with colon syntax", () => {
    expect(parseCommand("jarvis: summarize the repo", bots)).toMatchObject({
      botId: "jarvis",
      text: "summarize the repo",
      targeted: true,
    });
  });

  it("targets by @name syntax", () => {
    expect(parseCommand("@orchard run first pass", bots)).toMatchObject({
      botId: "orchard",
      text: "run first pass",
      targeted: true,
    });
  });

  it("surfaces a recoverable error for unknown targeted bot", () => {
    const parsed = parseCommand("unknown: do this", bots);
    expect(parsed.botId).toBeNull();
    expect(parsed.targeted).toBe(true);
    expect(parsed.targetError).toContain("Could not find teammate");
  });

  it("falls back to chief-of-staff when no target is available", () => {
    expect(parseCommand("status check", bots)).toMatchObject({
      botId: "orchard",
      targeted: false,
      text: "status check",
      openApp: null,
    });
  });
});
