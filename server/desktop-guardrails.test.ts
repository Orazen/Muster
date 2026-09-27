// Pins for the This-Mac action guardrails: the four-stop vocabulary and its
// messages, the 12-action ledger (count/reset/settle, exhaustion at the
// limit), the tool predicate's prefix/argument spellings, and the one rule
// that matters — a spent budget REMOVES an unattended answer and never
// grants, keeps, or rewrites one. Pure — no I/O.
import { describe, expect, it } from "vitest";

import {
  DESKTOP_ACTION_BUDGET,
  DESKTOP_BUDGET_HELD,
  DESKTOP_STOP_REASONS,
  DesktopActionBudget,
  STOP_MESSAGES,
  appChanged,
  budgetStop,
  isDesktopActionTool,
  stopNote,
} from "./desktop-guardrails.ts";

describe("stop vocabulary", () => {
  it("ports exactly the four reasons the study names, each with a message", () => {
    expect([...DESKTOP_STOP_REASONS]).toEqual(["step_budget", "app_changed", "cancelled", "target_absent"]);
    for (const reason of DESKTOP_STOP_REASONS) {
      expect(STOP_MESSAGES[reason]).toBeTruthy();
      expect(stopNote(reason)).toBe(`${reason}: ${STOP_MESSAGES[reason]}`);
    }
  });

  it("keeps upstream's step_budget message honest about the 12 ceiling", () => {
    expect(DESKTOP_ACTION_BUDGET).toBe(12);
    expect(STOP_MESSAGES.step_budget).toBe("Stopped after 12 actions.");
  });

  it("reuses grounding's StopReason rather than inventing a second one", () => {
    const reason: Parameters<typeof stopNote>[0] = "target_absent";
    expect(reason).toBe("target_absent");
  });
});

describe("app_changed helper", () => {
  it("compares case-insensitively and refuses to guess on missing evidence", () => {
    expect(appChanged("Safari", "Safari")).toBe(false);
    expect(appChanged("safari", "SAFARI")).toBe(false);
    expect(appChanged("Finder", "Safari")).toBe(true);
    expect(appChanged(undefined, "Safari")).toBe(false);
    expect(appChanged("Safari", undefined)).toBe(false);
    expect(appChanged("  ", "Safari")).toBe(false);
  });
});

describe("isDesktopActionTool", () => {
  // the verbs ACTION_TOOLS must match, spelled the way a driver reports them
  const ACTION_NAMES = [
    "click",
    "type_text",
    "press_key",
    "scroll",
    "hotkey",
    "drag",
    "invoke_menu",
    "open_url",
    "computer_batch",
    "computer",
  ];

  it("counts the local and cloud screen-action verbs", () => {
    for (const tool of ACTION_NAMES) {
      expect(isDesktopActionTool(tool)).toBe(true);
      // the MCP spelling the permission fold actually carries
      expect(isDesktopActionTool(`mcp__computer__${tool}`)).toBe(true);
    }
  });

  it("counts a screen action behind a server name containing an underscore", () => {
    // a user-registered MCP server may be named with an underscore
    // (server/custom-mcp.ts) and mounts as `mcp__<name>__<tool>`
    // (server/drivers/claude.ts) — reading the prefix with `mcp__[^_]+__`
    // left these uncounted, so the budget silently stopped applying
    for (const tool of ACTION_NAMES) {
      expect(isDesktopActionTool(`mcp__cua_driver__${tool}`)).toBe(true);
      expect(isDesktopActionTool(`mcp__my_server__${tool}`)).toBe(true);
      expect(isDesktopActionTool(`mcp__cua-driver-2__${tool}`)).toBe(true);
    }
  });

  it("keeps the spellings that already counted, and the ones that never did", () => {
    expect(isDesktopActionTool("mcp__cua__click")).toBe(true);
    expect(isDesktopActionTool("mcp__ogb__computer_batch")).toBe(true);
    expect(isDesktopActionTool("mcp__muster-computer__click")).toBe(true);
    expect(isDesktopActionTool("mcp__cua__click 412, 88")).toBe(true);
    expect(isDesktopActionTool("type_text Send the draft")).toBe(true);
    expect(isDesktopActionTool("CLICK")).toBe(true);
    // and an underscore in the SERVER segment must not turn a read into a write
    for (const tool of ["screenshot", "get_desktop_state", "computer_exec", "browser_click", "Bash", "Read"]) {
      expect(isDesktopActionTool(`mcp__my_server__${tool}`)).toBe(false);
      expect(isDesktopActionTool(`mcp__cua_driver__${tool}`)).toBe(false);
    }
  });

  it("degrades a malformed mount name to 'not a screen action', never to garbage", () => {
    for (const name of ["mcp__", "mcp__cua", "mcp___click", "mcp__my_server__", "__click", "mcp", "", "   "]) {
      expect(isDesktopActionTool(name)).toBe(false);
    }
    // no mount prefix means the whole name is the tool name, separator or not
    expect(isDesktopActionTool("some__click")).toBe(false);
  });

  it("reads only the first token of an ACP title that carries arguments", () => {
    expect(isDesktopActionTool("click 412, 88")).toBe(true);
    expect(isDesktopActionTool("type_text Send the draft")).toBe(true);
    expect(isDesktopActionTool("mcp__computer__press_key Return")).toBe(true);
  });

  it("does not count observations, the box shell, or semantic browser actions", () => {
    for (const tool of ["screenshot", "get_desktop_state", "computer_exec", "browser_click", "browser_fill", "Bash", "Read src/x.ts", ""]) {
      expect(isDesktopActionTool(tool)).toBe(false);
    }
  });
});

describe("DesktopActionBudget", () => {
  it("counts to the limit, exhausts exactly there, and never before", () => {
    const budget = new DesktopActionBudget();
    for (let i = 1; i <= DESKTOP_ACTION_BUDGET; i += 1) {
      expect(budget.record("t1")).toBe(i);
      expect(budget.count("t1")).toBe(i);
      expect(budget.exhausted("t1")).toBe(i >= DESKTOP_ACTION_BUDGET);
    }
    expect(budget.count("t1")).toBe(DESKTOP_ACTION_BUDGET);
    expect(budget.exhausted("t1")).toBe(true);
  });

  it("keeps threads independent and treats an unseen thread as empty", () => {
    const budget = new DesktopActionBudget();
    expect(budget.exhausted("t2")).toBe(false);
    budget.record("t1");
    expect(budget.count("t2")).toBe(0);
    expect(budget.exhausted("t1")).toBe(false);
  });

  it("reset (new turn) and settle (turn over) both clear the count", () => {
    const budget = new DesktopActionBudget();
    budget.record("t1");
    budget.record("t1");
    expect(budget.count("t1")).toBe(2);
    budget.reset("t1");
    expect(budget.count("t1")).toBe(0);
    budget.record("t1");
    budget.settle("t1");
    expect(budget.count("t1")).toBe(0);
    expect(budget.exhausted("t1")).toBe(false);
  });

  it("honours a custom limit and rejects a nonsensical one", () => {
    const budget = new DesktopActionBudget({ limit: 1 });
    budget.record("t1");
    expect(budget.exhausted("t1")).toBe(true);
    expect(() => new DesktopActionBudget({ limit: 0 })).toThrow();
    expect(() => new DesktopActionBudget({ limit: 1.5 })).toThrow();
  });
});

describe("budgetStop", () => {
  it("leaves every decision alone while the budget is unspent", () => {
    expect(budgetStop({ autoApproved: "auto-approved click", desktopAsk: true, exhausted: false })).toEqual({
      settled: "auto-approved click",
    });
    expect(budgetStop({ autoApproved: null, desktopAsk: true, exhausted: false })).toEqual({ settled: null });
  });

  it("spends the budget only on an unattended desktop action", () => {
    const verdict = budgetStop({ autoApproved: "auto-approved click", desktopAsk: true, exhausted: true });
    expect(verdict.settled).toBeNull();
    expect(verdict.held).toBe(DESKTOP_BUDGET_HELD);
    // a non-desktop ask (a file read, a command) is not this guard's business
    expect(budgetStop({ autoApproved: "auto-approved Read", desktopAsk: false, exhausted: true })).toEqual({
      settled: "auto-approved Read",
    });
  });

  it("never rewrites a refusal: `autoDecision`'s own null stays null with no budget line", () => {
    const verdict = budgetStop({ autoApproved: null, desktopAsk: true, exhausted: true });
    expect(verdict).toEqual({ settled: null });
    expect(verdict.held).toBeUndefined();
  });

  it("carries no wording that implies the action ran", () => {
    expect(DESKTOP_BUDGET_HELD).not.toMatch(/approved|allowed|executed|performed/i);
    expect(DESKTOP_BUDGET_HELD).toContain(String(DESKTOP_ACTION_BUDGET));
  });
});
