// Validate the source-map package resolved by the declared Vite and Tailwind
// consumers. Fixtures are bounded: no server, network, or native process is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

interface FlatMap {
  version: number;
  file?: string;
  sources: string[];
  sourcesContent?: string[];
  names: string[];
  mappings: string;
}
interface IndexedMap {
  version: number;
  file?: string;
  sections: { offset: { line: SectionOffset; column: SectionOffset }; map: InputMap }[];
}
type SectionOffset = number | string | null | undefined | Record<string, never>;
type InputMap = FlatMap | IndexedMap;
interface Position { line: number; column: number }
interface OriginalPosition {
  source: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
}
interface Consumer {
  sources: string[];
  _sections?: { consumer: Consumer }[];
  originalPositionFor(position: Position): OriginalPosition;
  sourceContentFor(source: string): string | null;
  eachMapping(callback: (mapping: { generatedLine: number }) => void): void;
}
interface ConsumerConstructor { new (map: InputMap | string): Consumer }
interface Generator {
  addMapping(mapping: { generated: Position; original?: Position; source?: string }): void;
  toJSON(): FlatMap;
}
interface SourceNodeValue {
  children: (string | SourceNodeValue)[];
  toString(): string;
  toStringWithSourceMap(options: { file: string }): { code: string; map: Generator };
}
interface SourceMapAPI {
  SourceMapConsumer: ConsumerConstructor;
  SourceMapGenerator: {
    new (options?: { file?: string }): Generator;
    fromSourceMap(consumer: Consumer): Generator;
  };
  SourceNode: {
    fromStringWithSourceMap(code: string, consumer: Consumer): SourceNodeValue;
  };
}
interface ParsedCSS {
  source: { input: { map: { consumer(): Consumer } } };
}
interface Declaration { prop: string; value: string }
interface PostCSSAPI {
  (plugins: { postcssPlugin: string; Declaration(declaration: Declaration): void }[]): {
    process(css: string, options: {
      from: string; to: string; map: { prev: InputMap; inline: boolean; annotation: boolean };
    }): { css: string; map: Generator };
  };
  parse(css: string, options: { from: string; map: { prev: InputMap } }): ParsedCSS;
}
const packageManifest = z.object({
  name: z.string(), version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
const dependencyLock = z.object({
  overrides: z.record(z.string(), z.string()),
  packages: z.record(z.string(), z.object({ resolution: z.object({ integrity: z.string().optional() }) })),
  snapshots: z.record(z.string(), z.object({ dependencies: z.record(z.string(), z.string()).optional() })),
});

const root = fileURLToPath(new URL("..", import.meta.url));
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const viteRequire = createRequire(rootRequire.resolve("vite/package.json"));
const postcssEntry = viteRequire.resolve("postcss");
const postcssRequire = createRequire(postcssEntry);
const tailwindViteEntry = rootRequire.resolve("@tailwindcss/vite");
const tailwindViteRequire = createRequire(tailwindViteEntry);
// @tailwindcss/node does not export package.json. Resolve its real runtime entry.
const tailwindNodeEntry = tailwindViteRequire.resolve("@tailwindcss/node");
const tailwindNodeRequire = createRequire(tailwindNodeEntry);

const reviewedHashes = {
  "source-map-consumer.js": "9ad10db386da13c1f95e6a680d6298dbb306c77f57a9a3539e4595b723a7654b",
  "source-map-generator.js": "07894c9ea1e674263e2e7694d43d4fb935e98549b93946205b9536c1420696c0",
  "source-node.js": "d1a0ef136bf0e974ba956506c88e91fef5d8681bbf10c486ff9566a7d6d76f3c",
};
const integrity = "sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==";
const chains = [
  { name: "Vite -> PostCSS", require: postcssRequire },
  { name: "Tailwind Vite -> Tailwind node", require: tailwindNodeRequire },
];

function manifest(require: ReturnType<typeof createRequire>, name: string) {
  return packageManifest.parse(JSON.parse(readFileSync(require.resolve(name + "/package.json"), "utf8")));
}

function assertOwnedEntry(entry: string) {
  const local = relative(realpathSync(join(root, "node_modules")), realpathSync(entry));
  assert.ok(!isAbsolute(local) && local !== ".." && !local.startsWith(".." + sep), entry);
}

function verifiedAPI(require: ReturnType<typeof createRequire>): SourceMapAPI {
  assert.equal(manifest(require, "source-map-js").version, "1.2.2");
  for (const [name, hash] of Object.entries(reviewedHashes)) {
    const entry = require.resolve("source-map-js/lib/" + name);
    assertOwnedEntry(entry);
    assert.equal(createHash("sha256").update(readFileSync(entry)).digest("hex"), hash);
  }
  // SAFETY: The exact published 1.2.2 runtime bytes were verified above.
  return require("source-map-js") as SourceMapAPI;
}

// SAFETY: PostCSS's fixed 8.5.28 API and declared dependency are checked below.
const postcss = viteRequire("postcss") as PostCSSAPI;
const css = ".card { color: red; }";
function flatMap(): FlatMap {
  return { version: 3, file: "generated.css", sources: ["original.css"],
    sourcesContent: [css], names: [], mappings: "AAAA" };
}
function indexedMap(line: SectionOffset, column: SectionOffset = 0, map: InputMap = flatMap()): IndexedMap {
  return { version: 3, file: "generated.css", sections: [{ offset: { line, column }, map }] };
}
function nestedMap(depth: number, line: number): InputMap {
  let map: InputMap = flatMap();
  for (let index = 0; index < depth; index++) map = indexedMap(line, 0, map);
  return map;
}
function parsePrevious(map: InputMap): ParsedCSS {
  return postcss.parse(css, { from: "generated.css", map: { prev: map } });
}

describe("declared installed source-map consumer graph", () => {
  it("binds PostCSS and Tailwind to their compatible declared ranges", () => {
    assertOwnedEntry(postcssEntry);
    assertOwnedEntry(tailwindNodeEntry);
    expect(manifest(viteRequire, "postcss").version).toBe("8.5.28");
    expect(manifest(viteRequire, "postcss").dependencies?.["source-map-js"]).toBe("^1.2.1");
    const tailwindManifestPath = join(dirname(tailwindNodeEntry), "..", "package.json");
    assertOwnedEntry(tailwindManifestPath);
    const tailwind = packageManifest.parse(JSON.parse(readFileSync(tailwindManifestPath, "utf8")));
    expect(tailwind.name).toBe("@tailwindcss/node");
    expect(tailwind.version).toBe("4.3.3");
    expect(tailwind.dependencies?.["source-map-js"]).toBe("^1.2.1");
  });

  it("binds the sole override, package integrity, and both locked consumer snapshots", () => {
    const lock = dependencyLock.parse(parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")));
    expect(lock.overrides["source-map-js@<1.2.2"]).toBe("1.2.2");
    expect(lock.packages["source-map-js@1.2.2"].resolution.integrity).toBe(integrity);
    expect(lock.packages["source-map-js@1.2.1"]).toBeUndefined();
    expect(lock.snapshots["postcss@8.5.28"].dependencies?.["source-map-js"]).toBe("1.2.2");
    expect(lock.snapshots["@tailwindcss/node@4.3.3"].dependencies?.["source-map-js"]).toBe("1.2.2");
  });

  for (const chain of chains) {
    it(chain.name + " loads the exact published fix", () => {
      const api = verifiedAPI(chain.require);
      expect(api.SourceMapConsumer).toBeInstanceOf(Function);
      expect(api.SourceMapGenerator).toBeInstanceOf(Function);
      expect(api.SourceNode.fromStringWithSourceMap).toBeInstanceOf(Function);
    });
  }
});

describe("bounded indexed source-map input validation", () => {
  it("rejects an excessive offset through the actual PostCSS previous-map input", () => {
    verifiedAPI(postcssRequire);
    expect(() => parsePrevious(indexedMap(10_000_001))).toThrow(/must not exceed/);
  });

  const invalidOffsets: SectionOffset[] = [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, {}];
  for (const [index, value] of invalidOffsets.entries()) {
    for (const field of ["line", "column"] as const) {
      it("rejects invalid " + field + " fixture " + index + " before mapping work", () => {
        const api = verifiedAPI(postcssRequire);
        const map = indexedMap(0);
        map.sections[0].offset[field] = value;
        expect(() => new api.SourceMapConsumer(map)).toThrow();
        expect(() => parsePrevious(map)).toThrow();
      });
    }
  }

  it("rejects nested offsets whose total exceeds the limit", () => {
    const api = verifiedAPI(postcssRequire);
    expect(() => new api.SourceMapConsumer(nestedMap(3, 5_000_000))).toThrow(/including offsets of nested sections/);
    expect(() => parsePrevious(nestedMap(3, 5_000_000))).toThrow(/including offsets of nested sections/);
  });

  it("accepts the exact line boundary without flattening or serializing it", () => {
    const api = verifiedAPI(postcssRequire);
    const consumer = new api.SourceMapConsumer(nestedMap(2, 5_000_000));
    expect(consumer.originalPositionFor({ line: 10_000_001, column: 1 }).source).toBe("original.css");
    expect(consumer.sources).toEqual(["original.css"]);
  });

  it("accepts a large valid column because columns do not amplify line padding", () => {
    const api = verifiedAPI(postcssRequire);
    const consumer = new api.SourceMapConsumer(indexedMap(0, 5_000_000));
    expect(consumer.originalPositionFor({ line: 1, column: 5_000_001 }).source).toBe("original.css");
  });
});

describe("ordinary permitted source-map behavior", () => {
  for (const chain of chains) {
    it(chain.name + " preserves a flat mapping and source content", () => {
      const api = verifiedAPI(chain.require);
      const consumer = new api.SourceMapConsumer(flatMap());
      expect(consumer.originalPositionFor({ line: 1, column: 0 })).toEqual({
        source: "original.css", line: 1, column: 0, name: null,
      });
      expect(consumer.sourceContentFor("original.css")).toBe(css);
    });

    it(chain.name + " preserves indexed offsets and ordinary flat map generation", () => {
      const api = verifiedAPI(chain.require);
      const consumer = new api.SourceMapConsumer(indexedMap(2));
      const generatedLines: number[] = [];
      consumer.eachMapping(mapping => generatedLines.push(mapping.generatedLine));
      expect(generatedLines).toEqual([3]);
      expect(consumer.originalPositionFor({ line: 3, column: 1 }).source).toBe("original.css");
      const generated = api.SourceMapGenerator.fromSourceMap(new api.SourceMapConsumer(flatMap())).toJSON();
      const restored = new api.SourceMapConsumer(generated);
      expect(restored.originalPositionFor({ line: 1, column: 0 }).source).toBe("original.css");
      expect(restored.sourceContentFor("original.css")).toBe(css);
    });
  }

  it("PostCSS preserves a valid previous flat map while a plugin changes a declaration", () => {
    verifiedAPI(postcssRequire);
    const result = postcss([{
      postcssPlugin: "owned-source-map-policy-fixture",
      Declaration(declaration) {
        if (declaration.prop === "color") declaration.value = "blue";
      },
    }]).process(css, {
      from: "generated.css", to: "output.css",
      map: { prev: flatMap(), inline: false, annotation: false },
    });
    expect(result.css).toBe(".card { color: blue; }");
    const consumer = new (verifiedAPI(postcssRequire).SourceMapConsumer)(result.map.toJSON());
    expect(consumer.sources.some(source => source.endsWith("original.css"))).toBe(true);
    expect(consumer.sourceContentFor(consumer.sources[0])).toBe(css);
    expect(consumer.originalPositionFor({ line: 1, column: 8 }).line).toBe(1);
  });

  it("PostCSS parses an ordinary indexed previous map", () => {
    verifiedAPI(postcssRequire);
    const parsed = parsePrevious(indexedMap(0));
    expect(parsed.source.input.map.consumer().sources).toEqual(["original.css"]);
  });

  it("reads a nested source getter once rather than repeating work", () => {
    const api = verifiedAPI(postcssRequire);
    const consumer = new api.SourceMapConsumer(nestedMap(5, 1));
    let innermost = consumer;
    for (let index = 0; index < 5; index++) {
      assert.ok(innermost._sections?.[0]);
      innermost = innermost._sections[0].consumer;
    }
    let reads = 0;
    const sources = innermost.sources;
    Object.defineProperty(innermost, "sources", { get() { reads++; return sources; } });
    expect(consumer.sources).toEqual(["original.css"]);
    expect(reads).toBe(1);
  });

  it("serializes a bounded valid generated line gap exactly", () => {
    const api = verifiedAPI(tailwindNodeRequire);
    const generator = new api.SourceMapGenerator({ file: "generated.css" });
    generator.addMapping({ generated: { line: 1, column: 0 } });
    generator.addMapping({ generated: { line: 3, column: 0 } });
    generator.addMapping({ generated: { line: 1003, column: 0 } });
    expect(generator.toJSON().mappings).toBe("A" + ";".repeat(2) + "A" + ";".repeat(1000) + "A");
  });

  it("ends SourceNode padding once actual code is exhausted", () => {
    const api = verifiedAPI(postcssRequire);
    // A thousand lines is deliberately bounded even if the installed bytes regress.
    const node = api.SourceNode.fromStringWithSourceMap("var x;\n", new api.SourceMapConsumer(indexedMap(1000)));
    expect(node.toString()).toBe("var x;\n");
    expect(node.children.length).toBeLessThan(10);
  });

  it("SourceNode preserves normal code and mapped content", () => {
    const api = verifiedAPI(postcssRequire);
    const node = api.SourceNode.fromStringWithSourceMap(css, new api.SourceMapConsumer(flatMap()));
    const result = node.toStringWithSourceMap({ file: "generated.css" });
    expect(result.code).toBe(css);
    const restored = new api.SourceMapConsumer(result.map.toJSON());
    expect(restored.originalPositionFor({ line: 1, column: 0 }).source).toBe("original.css");
    expect(restored.sourceContentFor("original.css")).toBe(css);
  });
});
