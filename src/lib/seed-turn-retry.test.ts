import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { canRegenerateSavedTurn } from "./seed-turn-retry";

describe("ordinary regeneration around a saved welcome task", () => {
  it.each(["recorded", "starting", "not-started", "uncertain"] as const)("keeps %s recovery on the versioned card", status => {
    const messages: Pick<Message, "card">[] = [{ card: { title: "Welcome", subtitle: "", options: [], seedAnswer: { messageId: "saved-user", attempt: 1, status } } }];
    expect(canRegenerateSavedTurn(messages, "saved-user")).toBe(false);
    expect(canRegenerateSavedTurn(messages, "newer-user")).toBe(true);
  });

  it("allows explicit regeneration of a turn that already started", () => {
    expect(canRegenerateSavedTurn([{ card: { title: "Welcome", subtitle: "", options: [], seedAnswer: { messageId: "saved-user", attempt: 1, status: "started" } } }], "saved-user")).toBe(true);
  });

  it("leaves ordinary live cards and historical answers on their existing path", () => {
    expect(canRegenerateSavedTurn([{ card: { title: "Live", subtitle: "", options: [], requestId: "request-1" } }, { card: { title: "Old welcome", subtitle: "", options: [], answered: "Work" } }], "ordinary-user")).toBe(true);
    expect(canRegenerateSavedTurn([], undefined)).toBe(false);
  });
});
