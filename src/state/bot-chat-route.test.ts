import { describe, expect, it } from "vitest";
import { botChatRoute, resolveBotChatHandoff } from "./bot-chat-route";

const roster = [{ id: "first" }, { id: "chosen" }, { id: "hidden", hidden: true }];

describe("OS to chat route handoff", () => {
  it("encodes an exact target and preserves unrelated query values, including repeated ones", () => {
    const route = new URL(botChatRoute("bot/&?=# space", "?template=research&tag=a&bot=old&tag=b&empty="), "https://muster.example");
    expect(route.pathname).toBe("/app");
    expect(route.searchParams.getAll("bot")).toEqual(["bot/&?=# space"]);
    expect(route.searchParams.get("template")).toBe("research");
    expect(route.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(route.searchParams.get("empty")).toBe("");
  });

  it("waits for the authoritative roster even if earlier events already announced the bot", () => {
    expect(resolveBotChatHandoff("?bot=chosen", "account-a", false, roster)).toEqual({ kind: "wait" });
    expect(resolveBotChatHandoff("?bot=chosen", "account-a", true, roster)).toEqual({
      kind: "consume", selectedId: "chosen", search: "",
    });
  });

  it("does not use a roster without a resolved account identity", () => {
    expect(resolveBotChatHandoff("?bot=chosen", undefined, true, roster)).toEqual({ kind: "wait" });
  });

  it("leaves ordinary app navigation alone when there is no bot target", () => {
    expect(resolveBotChatHandoff("?template=research", "account-a", false, [])).toEqual({ kind: "none" });
  });

  it.each([
    "?bot=", "?bot=hidden", "?bot=removed", "?bot=group-id",
    "?bot=chosen&bot=first", "?bot=chosen&bot=chosen", "?bot=%20chosen%20",
    "?bot=https%3A%2F%2Fother.example%2Fchosen",
  ])("consumes invalid or ambiguous target %s without choosing a fallback bot", (search) => {
    expect(resolveBotChatHandoff(search, "account-a", true, roster)).toEqual({
      kind: "consume", selectedId: null, search: "",
    });
  });

  it("resolves a hydrated empty roster as unavailable instead of waiting forever", () => {
    expect(resolveBotChatHandoff("?bot=chosen", "empty-account", true, [])).toEqual({
      kind: "consume", selectedId: null, search: "",
    });
  });

  it("removes only the consumed handoff and preserves other parameters for downstream flows", () => {
    const result = resolveBotChatHandoff("?tag=a&bot=chosen&template=research&tag=b&empty=", "account-a", true, roster);
    expect(result).toEqual({ kind: "consume", selectedId: "chosen", search: "?tag=a&template=research&tag=b&empty=" });
    if (result.kind !== "consume") throw new Error("Expected handoff consumption");
    // A later roster update cannot replay the intent over a newer live choice.
    expect(resolveBotChatHandoff(result.search, "account-a", true, roster)).toEqual({ kind: "none" });
  });

  it("does not carry one account's bot into another account or activate it after a later roster change", () => {
    const search = "?bot=account-a-bot&template=research";
    expect(resolveBotChatHandoff(search, "account-a", true, [{ id: "account-a-bot" }])).toMatchObject({ selectedId: "account-a-bot" });
    const switched = resolveBotChatHandoff(search, "account-b", true, [{ id: "account-b-bot" }]);
    expect(switched).toEqual({ kind: "consume", selectedId: null, search: "?template=research" });
    if (switched.kind !== "consume") throw new Error("Expected stale handoff consumption");
    expect(resolveBotChatHandoff(switched.search, "account-b", true, [{ id: "account-a-bot" }])).toEqual({ kind: "none" });
  });
});
