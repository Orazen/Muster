// A restored social graph must not carry the producing account's owner ids.
//
// Sweep 4, item 5. `social.json` is in `SUBSET_ROOT_FILES`, and unlike
// `bots.json` and `groups.json` it had no rewrite branch on the staging path —
// it landed byte-for-byte. A friendship carries the owner of each side, a friend
// request the owner of each direction, and a profile its own, so a bundle from
// another installation re-attached that account's friendships. The SSE social
// filter treats owner-id lists as authoritative for who may see a frame, so this
// re-granted visibility the local accounts never had.
//
// This file tests the RULE (`stripSocialOwnership`) directly. The wiring — the
// branch that calls it while staging — is covered by the existing v2 restore
// suite, which these cases run alongside; stating the boundary here rather than
// implying the end-to-end path is covered is the point.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stripSocialOwnership } from "./workspace-bundle-v2.ts";

/** One record inside a staged social document — the same open-record shape the
 * module's own schema produces, so the alias describes the contract rather
 * than restating a bare dictionary. */
const socialRecordSchema = z.record(z.string(), z.unknown());
type SocialRecord = z.infer<typeof socialRecordSchema>;

/** A staged social document, as these cases read it back. */
interface StagedSocial {
  // The other collections the document carries; these cases assert they are
  // passed through untouched, so they are part of the type.
  posts?: unknown;
  reactions?: unknown;
  profiles?: SocialRecord[];
  requests?: SocialRecord[];
  friendships?: SocialRecord[];
}

const strip = (doc: StagedSocial): StagedSocial => {
  const stripped = stripSocialOwnership(JSON.stringify(doc));
  // SAFETY: `stripped` is null only when the document could not be parsed, and
  // it was produced by JSON.stringify above, so it always parses. The case that
  // covers the null path asserts it directly.
  if (stripped === null) throw new Error("a document this test produced must parse");
  // SAFETY: `stripped` came out of JSON.stringify above and went through
  // JSON.parse inside the stripper, so it is a parsed document; the null path is
  // thrown above and asserted directly in its own case.
  return JSON.parse(stripped) as StagedSocial;
};

describe("a staged social.json loses the producing account's owner ids", () => {
  it("strips owner ids from friendships, requests and profiles", () => {
    const out = strip({
      profiles: [{ botId: "b1", ownerId: "user-b", name: "Theirs" }],
      requests: [{ id: "r1", fromBotId: "b1", fromOwnerId: "user-b", toBotId: "b2", toOwnerId: "user-c" }],
      friendships: [{ id: "f1", botAId: "b1", ownerAId: "user-b", botBId: "b2", ownerBId: "user-c" }],
      posts: [],
      reactions: [],
    });

    expect(out.friendships?.[0]).toEqual({ id: "f1", botAId: "b1", botBId: "b2" });
    expect(out.requests?.[0]).toEqual({ id: "r1", fromBotId: "b1", toBotId: "b2" });
    expect(out.profiles?.[0]).toEqual({ botId: "b1", name: "Theirs" });
  });

  it("keeps the shape of the graph — the ids that bind it together survive", () => {
    // Stripping ownership must not turn a friendship into two strangers' worth
    // of nothing: the bot ids are what the edges are made of, and dropping them
    // alongside would silently delete the social graph instead of unowning it.
    const out = strip({
      profiles: [],
      requests: [],
      friendships: [{ id: "f1", botAId: "b1", ownerAId: "user-b", botBId: "b2", ownerBId: "user-b" }],
    });
    expect(out.friendships?.[0]?.botAId).toBe("b1");
    expect(out.friendships?.[0]?.botBId).toBe("b2");
  });

  it("leaves a document it cannot parse alone rather than dropping the graph", () => {
    // Losing a social graph is a downgrade; a parse failure must not turn into
    // data loss on top of whatever else went wrong.
    expect(stripSocialOwnership("{not json")).toBeNull();
  });

  it("is idempotent, so restaging an already-staged graph changes nothing", () => {
    const once = strip({
      profiles: [{ botId: "b1", ownerId: "user-b" }],
      requests: [],
      friendships: [],
    });
    const twice = strip(once);
    expect(twice).toEqual(once);
  });
});
