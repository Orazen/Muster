import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupParticipants } from "./GroupParticipants";

const members = [
  { id: "scout", name: "Scout", character: "flower" as const, color: "orange" as const, busy: true },
  { id: "editor", name: "The long-named editor & reviewer", character: "blob" as const, color: "blue" as const },
];

afterEach(() => vi.unstubAllGlobals());

describe("room participant identity", () => {
  it("marks only this room's worker, even when another member is busy elsewhere", () => {
    const markup = renderToStaticMarkup(createElement(GroupParticipants, { members, busyBotId: "editor" }));
    const rows = markup.match(/<li\b[\s\S]*?<\/li>/g)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Scout");
    expect(rows[0]).toContain('data-bot-paused="true"');
    expect(rows[0]).not.toContain("Working here");
    expect(rows[1]).toContain("The long-named editor &amp; reviewer");
    expect(rows[1]).toContain("Working here");
    expect(rows[1]).toContain('data-state="working"');
    expect(rows[1]).not.toContain('data-bot-paused="true"');
  });

  it("does not invent a worker when the room has no matching active member", () => {
    for (const busyBotId of [null, "removed-member"]) {
      const markup = renderToStaticMarkup(createElement(GroupParticipants, { members, busyBotId }));
      expect(markup).not.toContain("Working here");
      expect(markup.match(/data-bot-paused="true"/g)).toHaveLength(2);
    }
  });

  it("keeps the working label but pauses every avatar under reduced motion", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const markup = renderToStaticMarkup(createElement(GroupParticipants, { members, busyBotId: "editor" }));
    expect(markup).toContain("Working here");
    expect(markup.match(/data-bot-paused="true"/g)).toHaveLength(2);
  });

  it("names every member in the welcome composition instead of hiding everyone after the third", () => {
    const room = [...members, ...members.map((member) => ({ ...member, id: `${member.id}-2`, name: `${member.name} II` }))];
    const markup = renderToStaticMarkup(createElement(GroupParticipants, { members: room, variant: "welcome" }));
    expect(markup).toContain('aria-label="Agents in this room"');
    expect(markup.match(/<li\b/g)).toHaveLength(4);
    expect(markup).toContain("Scout II");
    expect(markup).toContain("The long-named editor &amp; reviewer II");
  });
});
