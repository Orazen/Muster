import { describe, it, expect } from "vitest";
import { companionPairingLink } from "./companion-pairing";
import { carriedCodeInstruction, isPairingLinkInput, parseFragmentCode, parsePairingLink, planWorkspaceConnect, type CarriedCodeMode } from "./pairing-link";

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

  it("accepts Muster's own 8-character code, keyed and bare", () => {
    // server/pairing.ts and server/claim.ts issue 8 chars of this alphabet;
    // ABCD2345 is a run of the unambiguous cloud alphabet, so it is a cloud code
    expect(parsePairingLink("https://bots.example.com/pair#code=ABCD2345")).toEqual({
      ok: true,
      host: "bots.example.com",
      code: "ABCD2345",
      mode: "cloud",
    });
    expect(parsePairingLink("https://bots.example.com/pair#ABCD2345")).toEqual({
      ok: true,
      host: "bots.example.com",
      code: "ABCD2345",
      mode: "cloud",
    });
    // the grouped 12-character form (one key and two groups) round-trips too
    expect(parsePairingLink("https://bots.example.com/pair#ABCD-EFGH-IJKL")).toMatchObject({ ok: true, mode: "self-hosted" });
    expect(parsePairingLink("https://bots.example.com/pair#A234-BCDE-FGHJ")).toMatchObject({ ok: true, code: "A234-BCDE-FGHJ" });
  });

  it("reads a bare fragment as a code only on the /pair page", () => {
    // a plain anchor on any other path is not a code and not a mistake: the
    // address still connects (this is the regression the review caught)
    expect(parsePairingLink("https://muster.today/#pricing")).toMatchObject({ ok: false, missingCode: true });
    expect(parsePairingLink("https://bots.example.com/app#section")).toMatchObject({ ok: false, missingCode: true });
    // on /pair the fragment is the code by contract
    expect(parsePairingLink("https://bots.example.com/pair#482913")).toMatchObject({ ok: true, mode: "companion" });
  });

  it("treats an unusable fragment as no code at all, so the address still connects", () => {
    for (const link of ["https://bots.example.com/pair#step=1", "https://bots.example.com/pair#a.b", "https://bots.example.com/pair#code=%20"]) {
      const r = parsePairingLink(link);
      expect(r.ok, link).toBe(false);
      if (!r.ok) {
        expect(r.missingCode, link).toBe(true);
        expect(r.reason).toMatch(/no pairing code/i);
      }
    }
  });

  // The widened-shape regression: a 4-64 char free run accepted #code=short as
  // a code. The rule is Muster's own shapes, so a short fragment is no code.
  it("refuses short or underscore-bearing fragments as codes", () => {
    for (const link of ["https://bots.example.com/pair#code=short", "https://bots.example.com/pair#code=ab", "https://bots.example.com/pair#code=ab_cd", "https://bots.example.com/pair#short"]) {
      const r = parsePairingLink(link);
      expect(r.ok, link).toBe(false);
      if (!r.ok) expect(r.missingCode, link).toBe(true);
    }
  });

  it("returns a reason and never throws on malformed or empty input", () => {
    const bad = ["", "   ", "not a url", "https://", "://nope", "https://%"];
    for (const input of bad) {
      expect(() => parsePairingLink(input)).not.toThrow();
      const r = parsePairingLink(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("isPairingLinkInput", () => {
  it("recognises a /pair page or an explicitly keyed code, with or without a scheme", () => {
    expect(isPairingLinkInput("https://bots.example.com/pair#code=ABCD2345")).toBe(true);
    expect(isPairingLinkInput("https://bots.example.com/pair#ABCD2345")).toBe(true);
    expect(isPairingLinkInput("https://bots.example.com/pair?code=ABCD2345")).toBe(true);
    expect(isPairingLinkInput("https://bots.example.com/pair")).toBe(true);
    // the scheme can be lost in transit (paste, chat client) and must not
    // change which rules apply
    expect(isPairingLinkInput("bots.example.com/pair#code=482913")).toBe(true);
    expect(isPairingLinkInput("https://bots.example.com/app#code=ABCD2345")).toBe(true);
  });

  it("leaves plain addresses, plain anchors and the native deep link alone", () => {
    expect(isPairingLinkInput("https://bots.example.com")).toBe(false);
    expect(isPairingLinkInput("bots.example.com")).toBe(false);
    // a fragment with no code key is an anchor on a non-/pair path
    expect(isPairingLinkInput("https://muster.today/#pricing")).toBe(false);
    expect(isPairingLinkInput("https://bots.example.com/app#section")).toBe(false);
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

  // Regression pins: the first cut of this slice routed every URL containing a
  // '#' into the strict parser, which turned ordinary anchors into errors.
  it("still connects an address that merely carries an anchor", () => {
    expect(planWorkspaceConnect("https://muster.today/#pricing")).toEqual({
      kind: "address",
      origin: "https://muster.today",
      code: null,
    });
    expect(planWorkspaceConnect("https://bots.example.com/app#section")).toMatchObject({ kind: "address", code: null });
  });

  // Regression pins: a code Muster actually issues must round-trip, and losing
  // the scheme in transit must not change which rules apply.
  it("carries a real Muster code instead of refusing it", () => {
    expect(planWorkspaceConnect("https://bots.example.com/pair#code=ABCD2345")).toEqual({
      kind: "link",
      origin: "https://bots.example.com",
      code: "ABCD2345",
    });
    expect(planWorkspaceConnect("https://bots.example.com/pair#ABCD2345")).toMatchObject({ kind: "link", code: "ABCD2345" });
  });

  it("applies the same rules to a link pasted without its scheme", () => {
    expect(planWorkspaceConnect("bots.example.com/pair#code=482913")).toEqual({ kind: "desktop-code", code: "482913" });
    const query = planWorkspaceConnect("bots.example.com/pair?code=ABCD2345");
    expect(query.kind).toBe("error");
    if (query.kind === "error") expect(query.error).toMatch(/fragment/i);
  });

  it("recognises the desktop app's own deep link instead of failing it as a workspace", () => {
    const real = companionPairingLink({ address: "mac.local", port: 8810, code: "004209", token: `omb_pair_${"a".repeat(43)}` })!;
    expect(real).toContain("muster://pair");
    expect(planWorkspaceConnect(real)).toEqual({ kind: "desktop-code", code: "004209" });
    // a deep link whose code is not a companion code is still the desktop handoff
    const other = planWorkspaceConnect("muster://pair?address=mac.local:8810&code=XYZW123");
    expect(other.kind).toBe("error");
    if (other.kind === "error") expect(other.error).toMatch(/desktop/i);
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

// The /pair page reads the fragment of the URL it was opened with and shows
// the code instead of dropping it. It never redeems: POST /api/pair/verify is
// a device redeemer, and in-browser redemption would consume the code the
// desktop app needs.
describe("parseFragmentCode", () => {
  it("reads Muster's own 8-character cloud code, keyed and bare", () => {
    expect(parseFragmentCode("#code=ABCD2345")).toEqual({ code: "ABCD2345", mode: "cloud" });
    expect(parseFragmentCode("#ABCD2345")).toEqual({ code: "ABCD2345", mode: "cloud" });
  });

  it("reads a 6-digit desktop-companion code", () => {
    expect(parseFragmentCode("#code=482913")).toEqual({ code: "482913", mode: "companion" });
    expect(parseFragmentCode("#482913")).toEqual({ code: "482913", mode: "companion" });
  });

  it("reads the grouped 12-character self-hosted form", () => {
    expect(parseFragmentCode("#code=ABCD-EFGH-IJKL")).toEqual({ code: "ABCD-EFGH-IJKL", mode: "self-hosted" });
    expect(parseFragmentCode("#ABCD-EFGH-IJKL")).toEqual({ code: "ABCD-EFGH-IJKL", mode: "self-hosted" });
  });

  it("returns null for a normal anchor, empty or junk fragment", () => {
    for (const hash of ["", "#", "#pricing", "#section=1", "#step=1", "#code=", "#nope!", "#ab", "#!!!"]) {
      const parsed = parseFragmentCode(hash);
      expect(parsed === null, `fragment ${JSON.stringify(hash)} must not parse`).toBe(true);
    }
  });

  it("reads an 8-char lowercase fragment as self-hosted, not cloud (the cloud alphabet is uppercase)", () => {
    // lowercase cannot be the cloud alphabet; it is still a legal 8-char
    // self-hosted code, so it is classified there rather than dropped
    expect(parseFragmentCode("#abcd2345")).toEqual({ code: "abcd2345", mode: "self-hosted" });
  });

  // parseFragmentCode's parameter accepts null/undefined because real callers
  // pass window.location.hash, which can be absent in odd embeds; it must
  // return null rather than throw for any of these.
  it("never throws on malformed input, including a non-string hash", () => {
    const malformed: Array<string | null | undefined> = [null, undefined, "   ", "#", "#code=short", "#ab", "#!!!"];
    for (const hash of malformed) {
      expect(() => parseFragmentCode(hash)).not.toThrow();
      expect(parseFragmentCode(hash)).toBeNull();
    }
  });

  it("keeps the mode set to a known value for each issuer", () => {
    const modes = new Set<CarriedCodeMode>();
    for (const hash of ["#ABCD2345", "#482913", "#ABCD-EFGH-IJKL"]) {
      const r = parseFragmentCode(hash);
      if (r === null) throw new Error(`expected ${hash} to parse`);
      modes.add(r.mode);
    }
    expect(modes).toEqual(new Set(["cloud", "companion", "self-hosted"]));
  });
});

describe("carriedCodeInstruction", () => {
  it("names the desktop pairing field for a companion code", () => {
    const text = carriedCodeInstruction({ code: "482913", mode: "companion" }, "https://muster.example");
    expect(text).toMatch(/Muster Desktop/);
  });

  it("points a self-hosted code at the app connecting to that server", () => {
    const text = carriedCodeInstruction({ code: "ABCD-EFGH-IJKL", mode: "self-hosted" }, "https://bots.example.com");
    expect(text).toContain("https://bots.example.com");
    expect(text).toMatch(/server pairing code/);
  });

  it("gives the cloud redeem command for a cloud code", () => {
    const text = carriedCodeInstruction({ code: "ABCD2345", mode: "cloud" }, "https://muster.example");
    expect(text).toContain("muster pair --redeem ABCD2345 --cloud https://muster.example");
  });
});