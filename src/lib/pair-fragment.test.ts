import { describe, it, expect } from "vitest";
import { parseFragmentCode, type CarriedCodeMode } from "./pair-fragment";

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

  it("refuses an 8-char lowercase fragment (the cloud alphabet is uppercase)", () => {
    expect(parseFragmentCode("#abcd2345")).toBeNull();
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
