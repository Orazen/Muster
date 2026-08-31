import { describe, expect, it } from "vitest";

import { teamImportPreview } from "./team-import";

describe("team import preview", () => {
  it.each([1, 2])("previews version %s team files", (version) => {
    const preview = teamImportPreview({
      format: "muster.team",
      version,
      team: {
        name: " Engineering ",
        description: " Ships software ",
        members: [{ name: " Ada ", title: " Tech Lead " }],
        // version 1 carries a room definition; version 2 dropped it
        ...(version === 1 && {
          room: { name: "Engineering", bulletin: "", defaultResponder: { kind: "everyone" } },
        }),
      },
    });

    expect(preview).toMatchObject({
      name: "Engineering",
      description: "Ships software",
      members: [{ name: "Ada", title: "Tech Lead" }],
    });
  });

  it("rejects unsupported and empty files", () => {
    expect(() => teamImportPreview({ format: "muster.team", version: 3, team: {} })).toThrow("not supported");
    expect(() =>
      teamImportPreview({ format: "muster.team", version: 2, team: { name: "Empty", members: [] } }),
    ).toThrow("no members");
  });
});
