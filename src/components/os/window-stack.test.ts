import { describe, expect, it } from "vitest";
import { revealWindow, windowId, type WindowTarget } from "./window-stack";

const first: WindowTarget = { kind: "agent", botId: "first" };
const second: WindowTarget = { kind: "agent", botId: "second" };

describe("OS window intent", () => {
  it("repeated show requests keep exactly one visible window", () => {
    const opened = revealWindow([], first);
    const repeated = revealWindow(revealWindow(opened, first), first);
    expect(repeated).toHaveLength(1);
    expect(repeated[0].minimized).toBe(false);
    expect(repeated[0].cascade).toBe(opened[0].cascade);
  });

  it("a decision click reveals a minimized window and keeps its geometry slot", () => {
    const opened = revealWindow([], first);
    const minimized = revealWindow(opened, first, "dock");
    expect(minimized[0].minimized).toBe(true);
    expect(revealWindow(minimized, first)[0]).toEqual(opened[0]);
    expect(opened[0].minimized).toBe(false);
  });

  it("dock clicks focus an obscured window before minimizing it", () => {
    const two = revealWindow(revealWindow([], first), second);
    const focused = revealWindow(two, first, "dock");
    expect(focused.map((item) => item.id)).toEqual([windowId(second), windowId(first)]);
    expect(focused.every((item) => !item.minimized)).toBe(true);
    const minimized = revealWindow(focused, first, "dock");
    expect(minimized.find((item) => item.id === windowId(first))?.minimized).toBe(true);
    expect(minimized.find((item) => item.id === windowId(second))?.minimized).toBe(false);
  });

  it("distinguishes a bot from an app with the same identifier", () => {
    const bot: WindowTarget = { kind: "agent", botId: "rooms" };
    const app: WindowTarget = { kind: "app", appId: "rooms" };
    expect(revealWindow(revealWindow([], bot), app)).toHaveLength(2);
    expect(windowId(bot)).not.toBe(windowId(app));
  });

  it("showing a focused window never changes it into a minimized window", () => {
    let current = revealWindow(revealWindow([], first), second);
    for (let i = 0; i < 4; i += 1) current = revealWindow(current, second);
    expect(current).toHaveLength(2);
    expect(current.at(-1)?.minimized).toBe(false);
  });
});
