import { describe, expect, it } from "vitest";

import { nextHeaderCollapse } from "./header-collapse";

describe("nextHeaderCollapse", () => {
  it("stays open near the top of the transcript", () => {
    expect(nextHeaderCollapse({ collapsed: false, previousScrollTop: 0, scrollTop: 40 })).toBe(false);
    // even an upward snap back to the top region reopens a collapsed header
    expect(nextHeaderCollapse({ collapsed: true, previousScrollTop: 300, scrollTop: 64 })).toBe(false);
  });

  it("collapses when scrolling down past the threshold", () => {
    expect(nextHeaderCollapse({ collapsed: false, previousScrollTop: 100, scrollTop: 220 })).toBe(true);
    expect(nextHeaderCollapse({ collapsed: false, previousScrollTop: 60, scrollTop: 65 })).toBe(true);
  });

  it("ignores a small first nudge that never reaches the threshold", () => {
    expect(nextHeaderCollapse({ collapsed: false, previousScrollTop: 0, scrollTop: 30 })).toBe(false);
  });

  it("expands on any real upward scroll", () => {
    expect(nextHeaderCollapse({ collapsed: true, previousScrollTop: 400, scrollTop: 300 })).toBe(false);
  });

  it("holds state through neutral jitter mid-list", () => {
    expect(nextHeaderCollapse({ collapsed: false, previousScrollTop: 400, scrollTop: 402 })).toBe(false);
    expect(nextHeaderCollapse({ collapsed: true, previousScrollTop: 400, scrollTop: 399 })).toBe(true);
  });
});
