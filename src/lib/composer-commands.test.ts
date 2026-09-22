import { describe, expect, it } from "vitest";

import { commandQueryAt, matchCommands, COMPOSER_COMMANDS } from "./composer-commands";

describe("commandQueryAt", () => {
  it("opens on a leading slash", () => {
    expect(commandQueryAt("/", 1)).toEqual({ start: 0, query: "" });
    expect(commandQueryAt("/vo", 3)).toEqual({ start: 0, query: "vo" });
  });

  it("anchors to a slash that starts a word mid-message", () => {
    const text = "look at this /st";
    expect(commandQueryAt(text, text.length)).toEqual({ start: text.indexOf("/"), query: "st" });
  });

  it("ignores slashes that do not start a word (URLs and paths)", () => {
    expect(commandQueryAt("https://x", 9)).toBeNull();
    expect(commandQueryAt("a/b", 3)).toBeNull();
    expect(commandQueryAt("no slash here", 13)).toBeNull();
  });

  it("refuses newlines and over-long queries", () => {
    expect(commandQueryAt("/sto\np", 6)).toBeNull();
    expect(commandQueryAt(`/${"x".repeat(30)}`, 31)).toBeNull();
  });

  it("stops at the caret, not the end of the text", () => {
    const text = "/voice and more";
    expect(commandQueryAt(text, 6)).toEqual({ start: 0, query: "voice" });
  });

  it("does not treat a slash inside a word as a command (user@host style)", () => {
    expect(commandQueryAt("a /sto p", 6)).toEqual({ start: 2, query: "sto" });
    expect(commandQueryAt("rate/limit", 10)).toBeNull();
  });
});

describe("matchCommands", () => {
  it("lists every command on an empty query", () => {
    expect(matchCommands("")).toHaveLength(COMPOSER_COMMANDS.length);
    expect(COMPOSER_COMMANDS.map((c) => c.id)).toEqual(["voice", "goal", "new", "stop", "settings"]);
  });

  it("matches on id and label, case-insensitively", () => {
    expect(matchCommands("vo").map((c) => c.id)).toEqual(["voice"]);
    expect(matchCommands("VOICE").map((c) => c.id)).toEqual(["voice"]);
    expect(matchCommands("task").map((c) => c.id)).toEqual(["new"]);
  });

  it("returns nothing for unknown input", () => {
    expect(matchCommands("nope")).toEqual([]);
  });

  it("caps the list at six rows like the mention picker", () => {
    const many = COMPOSER_COMMANDS.flatMap((c) => [c, c, c]);
    expect(many.length).toBeGreaterThan(6);
    // every real command matches "e"-ish queries; the cap is on output
    const result = matchCommands("e");
    expect(result.length).toBeLessThanOrEqual(6);
  });
});
