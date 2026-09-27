// Browser-chip facts: what a browser tool call shows in the chat, and the
// page the human's Browser panel can open. These are two separate facts —
// the title is cropped to fit a chip, the URL is not — so a chip carries
// both, and the page travels whole no matter how long the URL is.
import { describe, expect, it } from "vitest";

import { browserChip } from "./core.ts";

describe("browserChip", () => {
  it("puts the page in the title for a browser chip", () => {
    expect(browserChip({ title: "browser_browser_navigate", rawInput: { url: "https://example.com/a" } })).toEqual({
      title: "browser_browser_navigate → https://example.com/a",
      page: { tool: "browser_browser_navigate", url: "https://example.com/a" },
    });
  });

  it("keeps the page whole when the URL is longer than the chip title allows", () => {
    // the chip is cropped to 200 chars by the emit site; the page must not be
    const url = `https://example.com/search?q=${"z".repeat(400)}&page=2`;
    const chip = browserChip({ title: "browser_browser_navigate", rawInput: { url } });
    expect(chip.page?.url).toBe(url);
    expect(chip.title.length).toBeGreaterThan(200);
    expect(chip.title.slice(0, 200).length).toBe(200);
  });

  it("reads the address from address/target as well as url", () => {
    for (const key of ["url", "address", "target"]) {
      expect(browserChip({ title: "browser_browser_navigate", rawInput: { [key]: "https://example.com/x" } }).page)
        .toEqual({ tool: "browser_browser_navigate", url: "https://example.com/x" });
    }
  });

  it("reports no page for a non-browser chip, however it is addressed", () => {
    expect(browserChip({ title: "read_file", rawInput: { url: "https://example.com/a" } })).toEqual({
      title: "read_file",
      page: null,
    });
  });

  it("reports no page when a browser chip carries no URL", () => {
    expect(browserChip({ title: "browser_browser_screenshot" })).toEqual({
      title: "browser_browser_screenshot",
      page: null,
    });
  });

  it("refuses a page URL that is not http/https or is unbounded", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", `https://e.com/${"x".repeat(9000)}`]) {
      expect(browserChip({ title: "browser_browser_navigate", rawInput: { url } }).page).toBeNull();
    }
  });

  it("survives an absent, null or array rawInput", () => {
    expect(browserChip({ title: "browser_browser_navigate" }).page).toBeNull();
    expect(browserChip({ title: "browser_browser_navigate", rawInput: null }).page).toBeNull();
    expect(browserChip({ title: "browser_browser_navigate", rawInput: ["https://example.com"] }).page).toBeNull();
  });

  it("prefers a command over the raw title, as the tool itself reported it", () => {
    expect(browserChip({ title: "browser_browser_navigate", rawInput: { command: "browser_browser_navigate" } })).toEqual({
      title: "browser_browser_navigate",
      page: null,
    });
  });
});
