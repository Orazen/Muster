import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Tailwind scans the project root for class names unless told otherwise. The
// container build copies a fixed subset of the repository, so automatic
// scanning made two builds of one commit produce different stylesheets — nine
// utilities local emitted and the deployed one did not, five the other way.
// None of those classes are used by any component; the only effect was that a
// served build could never be shown to match a local one.
describe("web stylesheet source scanning", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

  it("disables automatic scanning", () => {
    expect(css).toMatch(/@import\s+"tailwindcss"\s+source\(none\)/);
  });

  it("names the application files the stylesheet is built from", () => {
    const sources = [...css.matchAll(/@source\s+(?!not\b)"([^"]+)"/g)].map((match) => match[1]);
    expect(sources.sort()).toEqual(["../index.html", "../src", "../tray.html"]);
  });

  it("keeps every declared source inside the application", () => {
    const sources = [...css.matchAll(/@source\s+(?!not\b)"([^"]+)"/g)].map((match) => match[1]);
    const outside = sources.filter((source) => !source.startsWith("../src") && !source.startsWith("../index.html") && !source.startsWith("../tray.html"));
    expect(outside).toEqual([]);
  });

  it("does not reintroduce automatic scanning by importing tailwindcss twice", () => {
    expect(css.match(/@import\s+"tailwindcss"/g) ?? []).toHaveLength(1);
  });
});
