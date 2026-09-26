import { afterEach, describe, expect, it, vi } from "vitest";
import { factHistory, listBrainFacts, restoreFact, revertFact, withdrawFact } from "./brain-facts";

afterEach(() => vi.unstubAllGlobals());

type WireFact = {
  id: string;
  text: string;
  kind: string;
  source: string;
  origin?: string;
  withdrawnAt?: string | number;
  createdAt: string | number;
};

type TestReply =
  | { facts: WireFact[] }
  | { ancestors: WireFact[]; fact?: WireFact; descendants: WireFact[] }
  | WireFact
  | { ok: true }
  | { error: string }
  // the malformed case under test: a list item that is only an id
  | { facts: Array<{ id: string }> };

function jsonResponse(body: TestReply, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const person: WireFact = {
  id: "f-person",
  text: "Ram prefers oat milk in everything",
  kind: "person",
  source: "intro call",
  origin: "user-edit",
  createdAt: "2026-09-01T10:00:00.000Z",
};

describe("brain fact client", () => {
  it("lists facts with provenance straight off the wire contract", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ facts: [person] }));
    vi.stubGlobal("fetch", transport);
    const facts = await listBrainFacts();
    expect(facts).toEqual([person]);
    expect(transport.mock.calls[0][0]).toBe("/api/brain/facts");
  });

  it("normalizes epoch-ms timestamps to ISO strings at the boundary", async () => {
    const epoch = { ...person, createdAt: 1788000000000, withdrawnAt: 1788086400000 };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ facts: [epoch] })));
    const facts = await listBrainFacts();
    expect(facts[0]?.createdAt).toBe(new Date(1788000000000).toISOString());
    expect(facts[0]?.withdrawnAt).toBe(new Date(1788086400000).toISOString());
  });

  it("rejects a list response that is not the contract", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ facts: [{ id: "f-1" }] })));
    await expect(listBrainFacts()).rejects.toThrow("unexpected shape");
  });

  it("returns the correction chain oldest first with the fact in the middle", async () => {
    const oldest = { ...person, id: "f-1", text: "Zed contracts through Northwind" };
    const current = { ...person, id: "f-2", text: "Zed works at Northwind" };
    const newest = { ...person, id: "f-3", text: "Zed leads Northwind" };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ ancestors: [oldest], fact: current, descendants: [newest] }),
    );
    vi.stubGlobal("fetch", transport);
    const history = await factHistory("f-2");
    expect(history).toEqual({ ancestors: [oldest], fact: current, descendants: [newest] });
    expect(transport.mock.calls[0][0]).toBe("/api/brain/facts/f-2/history");
  });

  it("surfaces a 404 history as the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "unknown fact" }, 404)));
    await expect(factHistory("ghost")).rejects.toThrow("unknown fact");
  });

  it("withdraws and restores by posting to the fact's own path", async () => {
    // two calls, so each must get its own Response — a body reads once
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", transport);
    await withdrawFact("f-person");
    await restoreFact("f-person");
    expect(transport.mock.calls.map(([path, init]) => `${init?.method} ${path}`)).toEqual([
      "POST /api/brain/facts/f-person/withdraw",
      "POST /api/brain/facts/f-person/restore",
    ]);
  });

  it("revert posts the replacement text and returns the new fact", async () => {
    const replacement = { ...person, id: "f-next", text: "Ram drinks black coffee now", source: "revert" };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(replacement));
    vi.stubGlobal("fetch", transport);
    const reverted = await revertFact("f-person", "Ram drinks black coffee now");
    const [path, init] = transport.mock.calls[0];
    expect(path).toBe("/api/brain/facts/f-person/revert");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ text: "Ram drinks black coffee now" }));
    expect(reverted).toEqual(replacement);
  });
});
