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
      expect(parseFragmentCode(hash), hash).toBeNull();
    }
  });

  it("refuses an 8-char lowercase fragment (the cloud alphabet is uppercase)", () => {
    expect(parseFragmentCode("#abcd2345")).toBeNull();
  });

  it("never throws on malformed input", () => {
    for (const hash of [null as unknown as string, undefined as unknown as string, "   "]) {
      expect(() => parseFragmentCode(hash)).not.toThrow();
      expect(parseFragmentCode(hash)).toBeNull();
    }
  });

  it("keeps the mode set to a known value for each issuer", () => {
    const modes = new Set<CarriedCodeMode>();
    for (const hash of ["#ABCD2345", "#482913", "#ABCD-EFGH-IJKL"]) {
      const r = parseFragmentCode(hash);
      expect(r).not.toBeNull();
      modes.add(r!.mode);
    }
    expect(modes).toEqual(new Set(["cloud", "companion", "self-hosted"]));
  });
});
