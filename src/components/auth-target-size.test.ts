// Tap-target size for the auth page's link-styled BUTTONS.
//
// Found by driving the real page, not by reading the CSS: every control was
// measured with getBoundingClientRect and "Get a pairing code ↗" came back
// 121x18. That is a `button` wearing `.auth-link`, so WCAG 2.2 SC 2.5.8's
// 24x24 minimum applies and the inline-text exception — which covers a run of
// prose, not a control — does not. It is also the one control on the page a
// phone user has to hit to get unstuck, and 18px tall is a hard target.
//
// The rule is asserted against the stylesheet because the defect IS the
// stylesheet, and a class-name check fails the moment the box regresses
// without any browser being involved.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = join(dirname(fileURLToPath(import.meta.url)), "auth.css");
const rules = readFileSync(CSS, "utf8");

/** The declarations in the `button.auth-link` rule, as a map. */
function buttonLinkRule(): Map<string, string> {
  const match = /(^|\n)button\.auth-link\s*\{([^}]*)\}/.exec(rules);
  if (!match) throw new Error("no `button.auth-link` rule in auth.css");
  const out = new Map<string, string>();
  for (const decl of (match[2] ?? "").split(";")) {
    const [prop, value] = decl.split(":").map((part) => part.trim());
    if (prop && value) out.set(prop, value);
  }
  return out;
}

describe("auth page tap targets", () => {
  it("gives a link-styled button a 24px minimum target", () => {
    // 24px is the WCAG 2.2 SC 2.5.8 floor, and the number the browser then
    // measured: 121x24 against 121x18 before.
    expect(buttonLinkRule().get("min-height")).toBe("24px");
  });

  it("centres the label in the grown box instead of letting it sit at the top", () => {
    expect(buttonLinkRule().get("display")).toBe("inline-flex");
    expect(buttonLinkRule().get("align-items")).toBe("center");
  });

  it("does not change the type the control is drawn in", () => {
    // The whole point is that this still READS as a link. Growing the box must
    // not restyle it into a button, so no font-size/weight/color here — the
    // base `.auth-link` rule owns those and is unchanged.
    const rule = buttonLinkRule();
    for (const property of ["font-size", "font-weight", "color", "background", "border"]) {
      expect(rule.has(property), `${property} must stay on the base .auth-link rule`).toBe(false);
    }
  });

  it("leaves the inline TEXT links alone, which the standard exempts", () => {
    // `a.auth-link` renders at 12px and measures ~17-20px tall. That is correct:
    // SC 2.5.8 exempts targets "in a sentence or block of text", and these are
    // footer and inline links. Growing them would restyle prose, so this test
    // fails if a future change reaches for them with the same fix.
    expect(rules).not.toMatch(/(^|\n)a\.auth-link\s*\{[^}]*min-height/);
  });

  it("does not fake the size with a pseudo-element", () => {
    // A grown `::after` really does widen the clickable region, but it is
    // invisible to getBoundingClientRect, to Lighthouse and to switch-control
    // tooling — precisely the tools that have to be satisfied. Rejecting it
    // here keeps the fix honest about what it can be measured as.
    expect(rules).not.toMatch(/button\.auth-link::after/);
  });
});
