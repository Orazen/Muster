// The OMB-parity chat affordances: transcript export shaping and reply-quote
// collapsing. Pure functions — the export's bytes and the prefill's shape are
// the contract the UI and the downloaded file both ride on.
import { describe, expect, it, vi } from "vitest";
import { downloadTranscript, replyQuote, transcriptHeader, transcriptLine, type TranscriptMessage } from "./chat-affordances";

const at = new Date("2026-09-23T14:03:00");

/** The structural slice the lib exports — the server's Message satisfies it
 * by shape; tests build minimal stand-ins without touching server modules. */
const msg = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
  kind: "text",
  ...over,
});

describe("replyQuote", () => {
  it("quotes the original as a blockquote with room to type under", () => {
    const out = replyQuote("Fix the login flow");
    expect(out).toBe("> Fix the login flow\n\n");
  });

  it("collapses long messages to the first lines plus an ellipsis", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = replyQuote(long);
    // 4 quoted lines + an ellipsis line (then the reply gap)
    expect(out.split("\n")).toHaveLength(4 + 1 + 2); // 4 quoted + "…" + blank + trailing
    expect(out).toContain("> line 4");
    expect(out).not.toContain("> line 5");
  });

  it("caps the quoted characters so a wall of text cannot dwarf the reply", () => {
    const wall = "x".repeat(400);
    const out = replyQuote(wall);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(400);
  });

  it("skips blank lines and never returns an empty quote", () => {
    const out = replyQuote("\n\n\n   \nonly line\n");
    expect(out).toBe("> only line\n\n");
  });
});

describe("transcriptLine", () => {
  it("renders text with role and clock", () => {
    const message = msg({ kind: "text", text: "hello" });
    expect(transcriptLine(message, at, "You")).toBe("You · 02:03 PM —\n\nhello\n");
  });

  it("collapses an activity chip to an italic tool line including failure", () => {
    const ok = msg({ kind: "activity", tool: { name: "bash" } });
    const failed = msg({ kind: "activity", tool: { name: "bash", ok: false } });
    expect(transcriptLine(ok, at, "Bot")).toContain("*Bot · 02:03 PM — bash*");
    expect(transcriptLine(failed, at, "Bot")).toContain("bash (failed)");
  });

  it("reduces interactive cards to their existence, not their bytes", () => {
    const card = msg({ kind: "options" });
    expect(transcriptLine(card, at, "Bot")).toBe("*Bot · 02:03 PM — options card*\n");
  });

  it("returns null for an empty text message (nothing to export)", () => {
    const empty = msg({ kind: "text", text: "   " });
    expect(transcriptLine(empty, at, "You")).toBeNull();
  });
});

describe("transcriptHeader + downloadTranscript", () => {
  it("carries the bot name, task and exported timestamp", () => {
    const header = transcriptHeader("Scout", "Weekly report", new Date("2026-09-23T10:00:00"));
    expect(header).toContain("# Conversation with Scout");
    expect(header).toContain("**Task:** Weekly report");
    expect(header).toMatch(/\*\*Exported:\*\* /);
  });

  it("omits an empty task line instead of printing an empty label", () => {
    const header = transcriptHeader("Scout", "");
    expect(header).not.toContain("Task:");
  });

  it("downloads a Markdown file named after the bot and date", () => {
    // node environment: stub the two DOM touchpoints the download needs —
    // an anchor element that records its own assignment, and the blob URL.
    let clicked = 0;
    const anchor = { href: "", download: "", click: () => void clicked++ };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.stubGlobal("Blob", class {
      constructor(public parts: string[]) {}
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:mock", revokeObjectURL: vi.fn() });
    downloadTranscript("# hi", "Weekly Scout!");
    expect(clicked).toBe(1);
    expect(anchor.download).toMatch(/^Weekly-Scout-\d{4}-\d{2}-\d{2}\.md$/);
    expect(anchor.href).toBe("blob:mock");
    vi.unstubAllGlobals();
  });
});
