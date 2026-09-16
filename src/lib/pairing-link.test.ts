import { describe, it, expect } from "vitest";
import { isPairingLinkInput, parsePairingLink, planWorkspaceConnect } from "./pairing-link";

describe("parsePairingLink", () => {
  it("parses a valid self-hosted 12-char fragment link", () => {
    const r = parsePairingLink("https://bots.example.com/pair#code=ABCD-EFGH-IJKL");
    expect(r).toEqual({ ok: true, host: "bots.example.com", code: "ABCD-EFGH-IJKL", mode: "self-hosted" });
  });

  it("parses a valid 6-digit companion code", () => {
    const r = parsePairingLink("https://bots.example.com/pair#code=482913");
    expect(r).toEqual({ ok: true, host: "bots.example.com", code: "482913", mode: "companion" });
  });

  it("rejects a query-string code", () => {
    const r = parsePairingLink("https://bots.example.com/pair?code=ABCD-EFGH-IJKL");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/query|fragment/i);
  });

  it("rejects localhost, private and reserved hosts", () => {
    const links = [
      "https://localhost/pair#code=ABCD-EFGH-IJKL",
      "https://127.0.0.1/pair#code=ABCD-EFGH-IJKL",
      "https://10.0.0.5/pair#code=ABCD-EFGH-IJKL",
      "https://192.168.1.10/pair#code=ABCD-EFGH-IJKL",
      "https://172.16.0.1/pair#code=ABCD-EFGH-IJKL",
      "https://[::1]/pair#code=ABCD-EFGH-IJKL",
      "https://myserver/pair#code=ABCD-EFGH-IJKL",
      "https://bots.local/pair#code=ABCD-EFGH-IJKL",
    ];
    for (const link of links) {
      const r = parsePairingLink(link);
      expect(r.ok, link).toBe(false);
    }
  });

  // workspaces.ts is https-only, so an http public host is refused there and
  // therefore refused here too — matching, not contradicting, that idiom.
  it("rejects an http-but-public host, matching workspaces.ts https-only rule", () => {
    const r = parsePairingLink("http://bots.example.com/pair#code=ABCD-EFGH-IJKL");
    expect(r.ok).toBe(false);
  });

  it("rejects a non-http(s) scheme", () => {
    const r = parsePairingLink("ftp://bots.example.com/pair#code=ABCD-EFGH-IJKL");
    expect(r.ok).toBe(false);
  });

  it("accepts the bare-fragment form Muster's own switchTarget() emits", () => {
    expect(parsePairingLink("https://bots.example.com/pair#ABCD-EFGH-IJKL")).toEqual({
      ok: true,
      host: "bots.example.com",
      code: "ABCD-EFGH-IJKL",
      mode: "self-hosted",
    });
    expect(parsePairingLink("https://bots.example.com/pair#482913")).toEqual({
      ok: true,
      host: "bots.example.com",
      code: "482913",
      mode: "companion",
    });
  });

  it("marks a link that simply has no code, rather than calling it malformed", () => {
    for (const link of ["https://bots.example.com/pair", "https://bots.example.com/pair#", "https://bots.example.com/pair#step=1"]) {
      const r = parsePairingLink(link);
      expect(r.ok, link).toBe(false);
      if (!r.ok) {
        expect(r.missingCode, link).toBe(true);
        expect(r.reason).toMatch(/no pairing code/i);
      }
    }
  });

  it("keeps a present-but-wrong code an error, not a missing code", () => {
    const r = parsePairingLink("https://bots.example.com/pair#code=short");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missingCode).toBeUndefined();
      expect(r.reason).toMatch(/no valid pairing code/i);
    }
  });

  it("returns a reason and never throws on malformed or empty input", () => {
    const bad = ["", "   ", "not a url", "https://", "://nope", "https://bots.example.com/pair#code=short"];
    for (const input of bad) {
      expect(() => parsePairingLink(input)).not.toThrow();
      const r = parsePairingLink(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("isPairingLinkInput", () => {
  it("recognises http(s) links that carry a code or point at /pair", () => {
    expect(isPairingLinkInput("https://bots.example.com/pair#code=ABCD-EFGH-IJKL")).toBe(true);
    expect(isPairingLinkInput("https://bots.example.com/pair#ABCD-EFGH-IJKL")).toBe(true);
    expect(isPairingLinkInput("https://bots.example.com/pair?code=ABCD-EFGH-IJKL")).toBe(true);
    expect(isPairingLinkInput("https://bots.example.com/pair")).toBe(true);
  });

  it("leaves bare addresses and the native deep link on the address path", () => {
    expect(isPairingLinkInput("https://bots.example.com")).toBe(false);
    expect(isPairingLinkInput("bots.example.com")).toBe(false);
    // muster://pair is the desktop-companion handoff, parsed by workspaces.ts
    expect(isPairingLinkInput("muster://pair?address=https://bots.example.com&code=XYZW123")).toBe(false);
    expect(isPairingLinkInput("")).toBe(false);
  });
});

// The client role's decision, kept out of the component so it can be pinned
// here. Each case is one thing a person can actually paste into the field.
describe("planWorkspaceConnect", () => {
  it("connects to a self-hosted link and carries its code", () => {
    expect(planWorkspaceConnect("https://bots.example.com/pair#code=ABCD-EFGH-IJKL")).toEqual({
      kind: "link",
      origin: "https://bots.example.com",
      code: "ABCD-EFGH-IJKL",
    });
    // the bare form Muster itself emits resolves to the same plan
    expect(planWorkspaceConnect("https://bots.example.com/pair#ABCD-EFGH-IJKL")).toMatchObject({ kind: "link", code: "ABCD-EFGH-IJKL" });
  });

  it("keeps an explicit port when a link carries one", () => {
    const plan = planWorkspaceConnect("https://bots.example.com:8443/pair#code=ABCD-EFGH-IJKL");
    expect(plan).toEqual({ kind: "link", origin: "https://bots.example.com:8443", code: "ABCD-EFGH-IJKL" });
  });

  it("refuses a query-string code on the link path", () => {
    const plan = planWorkspaceConnect("https://bots.example.com/pair?code=ABCD-EFGH-IJKL");
    expect(plan.kind).toBe("error");
    if (plan.kind === "error") expect(plan.error).toMatch(/query|fragment/i);
  });

  it("routes a 6-digit code to the desktop app instead of switching workspace", () => {
    expect(planWorkspaceConnect("https://bots.example.com/pair#code=482913")).toEqual({ kind: "desktop-code", code: "482913" });
  });

  it("treats a /pair page with no code as an ordinary address", () => {
    expect(planWorkspaceConnect("https://bots.example.com/pair")).toEqual({ kind: "address", origin: "https://bots.example.com", code: null });
  });

  it("connects a bare address with no code", () => {
    expect(planWorkspaceConnect("bots.example.com")).toEqual({ kind: "address", origin: "https://bots.example.com", code: null });
  });

  it("keeps the native deep link working, code and all", () => {
    expect(planWorkspaceConnect("muster://pair?address=https://bots.example.com&code=XYZW123")).toEqual({
      kind: "address",
      origin: "https://bots.example.com",
      code: "XYZW123",
    });
  });

  it("refuses private, loopback and network-local hosts on every path", () => {
    for (const bad of ["https://127.0.0.1/pair#code=ABCD-EFGH-IJKL", "https://muster.local/pair#code=ABCD-EFGH-IJKL", "https://10.0.0.5"]) {
      expect(planWorkspaceConnect(bad).kind, bad).toBe("error");
    }
  });

  it("returns an error rather than throwing on empty input", () => {
    const plan = planWorkspaceConnect("   ");
    expect(plan.kind).toBe("error");
  });
});