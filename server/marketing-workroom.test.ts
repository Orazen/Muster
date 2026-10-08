// Contracts for the approved marketing bundle. These inspect shipped source and
// execute its pure handoff model; browser interaction needs separate e2e checks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it, it as test } from "vitest";
import { z } from "zod";
// @ts-expect-error This standalone browser module is deliberately plain ESM.
import { createHandoff as createSampleHandoff, SCENARIOS as sampleScenarios } from "../www/landing-workroom/v1/handoff.mjs";

type Scenario = {
  label: string; role: string; title: string; brief: string;
  inputs: readonly string[]; steps: readonly string[]; draft: readonly string[];
  draftTitle: string; approvalTitle: string; approvalDetail: string;
  approveLabel: string; receiptApproved: string; receiptDraft: string;
};
type Snapshot = {
  scenarioKey: string; scenario: Scenario;
  phase: "ready" | "preparing" | "review" | "complete";
  outcome: null | "approved" | "draft";
  cue: string; status: string; receipt: string | null; disclaimer: string;
};
type HandoffController = {
  getSnapshot(): Snapshot; selectScenario(key: HandoffInput): Snapshot;
  start(): Snapshot; advance(): Snapshot; decide(choice: HandoffInput): Snapshot;
  reset(): Snapshot;
};
// The invalid members are deliberate fixtures for the plain ESM input guards.
type HandoffInput = string | number | boolean | null | undefined | Record<string, never>;
// SAFETY: this is the local controller's declared API; the transition and invalid
// input tests below exercise every exposed method and verify its snapshots.
const createHandoff = createSampleHandoff as (initial?: HandoffInput) => HandoffController;
// SAFETY: the presentation-data test checks all required scenario fields, array
// lengths and runtime immutability before the scenario-driven contract tests.
const SCENARIOS = sampleScenarios as Readonly<Record<string, Scenario>>;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WWW = join(ROOT, "www");
const PREFIX = "/landing-workroom/v1/";
const BUNDLE = join(WWW, "landing-workroom", "v1");
const html = readFileSync(join(WWW, "index.html"), "utf8");
const css = readFileSync(join(BUNDLE, "style.css"), "utf8");

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
}
function plain(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, number: string) => String.fromCodePoint(number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number)))
    .replace(/&(amp|nbsp|quot|apos|lt|gt);/g, (_, key: string) => ({ amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">" })[key]!)
    .replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}
function bundleFile(url: string, from = join(WWW, "index.html")): string {
  assert.ok(!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url), `Remote or non-file dependency: ${url}`);
  const clean = url.split(/[?#]/)[0];
  const path = clean.startsWith("/") ? resolve(WWW, `.${clean}`) : resolve(dirname(from), clean);
  const rel = relative(BUNDLE, path);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel), `Dependency escapes versioned bundle: ${url}`);
  assert.ok(existsSync(path), `Missing shipped asset: ${url}`);
  return path;
}
function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink(), `Public asset must not be a symlink: ${entry.name}`);
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}
const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
const linkedStyles = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);

// SHA-256 values from the owner's 2026-10-07 APPROVED-V4 freeze. The source
// manifest is private; the shipped test is portable and needs no external path.
const LOCKED_MASCOT = {
  "sculpt.js": "c98d75031d24d5107b1f5d9c57454862e868623d8dbed39691792f6cd58ddbb0",
  "companion.js": "7662202091fecea1f8fc1dba012fe371f66453b26158f2faeedd3196ff839294",
  "expressions.js": "19c374beb4e41a3b8465d90b7b59a40deeacb64ac9de40cdd5d195f9fdb8f4fa",
  "effects.js": "3fb08bbdd0469622067c850b22697da3117fd67da96f5353633f1be05d83292a",
};

describe("approved public workroom bundle", () => {
  it("loads its versioned entry and styles without colliding with app routes", () => {
    const body = /<body\b[^>]*>/i.exec(html)?.[0] ?? "";
    expect(attr(body, "data-muster-landing")).toBe("workroom-v1");
    const entries = scripts.map((tag) => ({ src: attr(tag, "src"), type: attr(tag, "type") })).filter((tag) => tag.src);
    expect(entries).toEqual([{ src: `${PREFIX}app.js`, type: "module" }]);
    for (const entry of entries) bundleFile(entry.src!);
    const styles = linkedStyles.filter((tag) => attr(tag, "rel") === "stylesheet").map((tag) => attr(tag, "href"));
    expect(styles).toContain(`${PREFIX}style.css`);
    for (const style of styles) bundleFile(style!);
    expect(html).not.toMatch(/(?:src|href)=["']\/?(?:app\.js|style\.css)["']/);
  });

  it("resolves every static and lazy module import inside the public bundle", () => {
    // The actual parser follows lazy imports too, without executing DOM/WebGL
    // code. write:false guarantees this audit cannot modify public artifacts.
    const result = buildSync({
      entryPoints: [bundleFile(`${PREFIX}app.js`)], absWorkingDir: ROOT,
      bundle: true, write: false, metafile: true, platform: "browser",
      format: "esm", treeShaking: false, logLevel: "silent",
      logOverride: { "unsupported-dynamic-import": "error" },
    });
    const visited = new Set(Object.keys(result.metafile!.inputs).map((path) => resolve(ROOT, path)));
    for (const [input, metadata] of Object.entries(result.metafile!.inputs)) {
      const path = resolve(ROOT, input);
      bundleFile(`${PREFIX}${relative(BUNDLE, path).split(sep).join("/")}`);
      expect([".js", ".mjs"]).toContain(extname(path));
      for (const dependency of metadata.imports) {
        expect(dependency.external, dependency.path).not.toBe(true);
        expect(dependency.original?.startsWith(".") || dependency.original?.startsWith(PREFIX), dependency.path).toBe(true);
      }
    }
    for (const output of Object.values(result.metafile!.outputs)) expect(output.imports).toEqual([]);
    // Pins reachability: a removed lazy import must not silently omit the actor.
    for (const required of ["handoff.mjs", "mascot-stage.js", "mascot/sculpt.js", "mascot/expressions.js", "mascot/effects.js", "mascot/companion.js", "mascot/vendor/three.module.js", "mascot/vendor/three.core.js", "mascot/vendor/MarchingCubes.js"]) {
      expect(visited.has(join(BUNDLE, required)), required).toBe(true);
    }
  });

  it("ships local font bytes and a real static mascot fallback", () => {
    const fontPaths = [...css.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)].map((match) => bundleFile(match[1], join(BUNDLE, "style.css")));
    expect(fontPaths).toContain(join(BUNDLE, "fonts", "body.woff2"));
    expect(fontPaths).toContain(join(BUNDLE, "fonts", "display.woff2"));
    for (const path of fontPaths.filter((path) => extname(path) === ".woff2")) {
      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
      expect(bytes.length).toBeGreaterThan(1000);
    }
    const fallbackSrc = `${PREFIX}mascot/posters/designer.png`;
    const fallback = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]).find((tag) =>
      attr(tag, "src") === fallbackSrc && attr(tag, "class")?.split(/\s+/).includes("mascot-fallback"));
    expect(fallback).toBeTruthy();
    expect(attr(fallback!, "alt")?.trim().length).toBeGreaterThan(10);
    for (const path of [fallbackSrc, `${PREFIX}mascot/fallback.png`]) {
      expect(readFileSync(bundleFile(path)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  });

  for (const [file, hash] of Object.entries(LOCKED_MASCOT)) {
    it(`preserves the approved character module ${file}`, () => {
      expect(createHash("sha256").update(readFileSync(join(BUNDLE, "mascot", file))).digest("hex")).toBe(hash);
    });
  }

  it("retains the font and Three redistribution licenses beside their assets", () => {
    for (const [file, family] of [["body-OFL.txt", "Instrument Sans"], ["display-OFL.txt", "Bricolage Grotesque"]]) {
      const license = readFileSync(join(BUNDLE, "fonts", file), "utf8");
      expect(license).toContain(family);
      expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(license).toContain("PERMISSION & CONDITIONS");
    }
    const license = readFileSync(join(BUNDLE, "mascot/vendor/THREE-LICENSE.txt"), "utf8");
    expect(license).toContain("The MIT License");
    expect(license).toContain("three.js authors");
    expect(license).toContain("The above copyright notice and this permission notice shall be included");
    expect(readFileSync(join(BUNDLE, "NOTICE.txt"), "utf8")).toContain("BSL 1.1");
  });

  it("excludes private review, export, local-server and research material", () => {
    const files = filesBelow(BUNDLE);
    expect(files.length).toBeGreaterThan(10);
    const allowed = new Set([".js", ".mjs", ".css", ".woff2", ".png", ".jpg", ".svg", ".txt"]);
    const licenses = new Set(["NOTICE.txt", "fonts/body-OFL.txt", "fonts/display-OFL.txt", "mascot/vendor/THREE-LICENSE.txt"]);
    for (const path of files) {
      const rel = relative(BUNDLE, path).split(sep).join("/");
      expect(allowed.has(extname(path)), rel).toBe(true);
      expect(rel.split("/").some((part) => part.startsWith(".")), rel).toBe(false);
      expect(rel).not.toMatch(/(?:^|\/)(?:\.|research|reference|exports?|evidence|screenshots|node_modules|__pycache__|test)(?:\/|$)|\.(?:test|spec)\.|portrait|APPROVED/i);
      if (extname(path) === ".txt") expect(licenses.has(rel), rel).toBe(true);
    }
    const firstParty = [html, css, ...files.filter((path) => /\.(?:m?js)$/.test(path) && !path.includes(`${sep}vendor${sep}`)).map((path) => readFileSync(path, "utf8"))].join("\n");
    expect(firstParty).not.toMatch(/127\.0\.0\.1|localhost|\/Users\/|save-portrait|href=["'][^"']*research\/|approved-mascot-v4\.zip|file:\/\//i);
  });

  it("includes a useful initial sample without requiring JavaScript", () => {
    const sample = /<div\b[^>]*id=["']demo-content["'][^>]*>([\s\S]*?)<div\b[^>]*class=["']demo-disclaimer/i.exec(html)?.[1];
    expect(sample).toBeTruthy();
    const text = plain(sample!);
    for (const note of SCENARIOS.update.inputs) expect(text).toContain(note);
    expect(text).toMatch(/fictional|sample/i);
    expect(text.length).toBeGreaterThan(150);
    expect(text).toMatch(/interactive when JavaScript is available/i);
  });

  it("keeps sample actions, provider costs and platform boundaries explicit", () => {
    const text = plain(html);
    expect(text).toMatch(/scripted[^.]*fictional sample data/i);
    expect(text).toMatch(/does not contact an AI provider[^.]*send anything/i);
    expect(text).toMatch(/(?:Free app|app is free)/i);
    expect(text).toMatch(/provider[^.]{0,140}(?:costs|usage)[^.]{0,80}separate/i);
    expect(text).toMatch(/approval behavior depend[s]? on the tool, engine, and setup/i);
    expect(text).toMatch(/hosted web workspace and a local desktop workspace are distinct/i);
    expect(text).toMatch(/signing in does not automatically merge/i);
    expect(text).toMatch(/Phone and Watch[^.]*beta/i);
  });

  it("retains canonical identity, Google verification and actual legal destinations", () => {
    expect(linkedStyles.filter((tag) => attr(tag, "rel") === "canonical").map((tag) => attr(tag, "href"))).toEqual(["https://muster.today/"]);
    const tokens = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]).filter((tag) => attr(tag, "name") === "google-site-verification").map((tag) => attr(tag, "content"));
    expect(tokens).toEqual(expect.arrayContaining(["x_3lnviKYxtXei8uUYOivK8iRCc9bsVF1FVpzT4Co9w", "2RLLlyWY664n4qsB2aThGpFi7uMl4iDMJT8y3VU3_cg"]));
    const links = [...html.matchAll(/<a\b[^>]*>/gi)].map((match) => attr(match[0], "href"));
    for (const href of ["/privacy-policy", "/Terms-of-Service", "/app", "/download.html"]) expect(links).toContain(href);
  });

  it("ships the images referenced by social metadata and the favicon", () => {
    const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
    const images = meta.filter((tag) => attr(tag, "property") === "og:image" || attr(tag, "name") === "twitter:image");
    expect(images).toHaveLength(2);
    for (const tag of images) {
      const url = new URL(attr(tag, "content")!);
      expect(url.origin).toBe("https://muster.today");
      const bytes = readFileSync(bundleFile(url.pathname));
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
      expect(bytes.length).toBeGreaterThan(1000);
    }
    const favicon = linkedStyles.find((tag) => attr(tag, "rel") === "icon");
    expect(favicon).toBeTruthy();
    expect(readFileSync(bundleFile(attr(favicon!, "href")!), "utf8")).toMatch(/<svg\b/);
  });

  it("preserves homepage anchor destinations linked from existing public pages", () => {
    const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
    const backlinks: Array<{ page: string; hash: string }> = [];
    for (const path of filesBelow(WWW).filter((path) => extname(path) === ".html" && path !== join(WWW, "index.html"))) {
      const page = readFileSync(path, "utf8");
      for (const match of page.matchAll(/<a\b[^>]*>/gi)) {
        const href = attr(match[0], "href");
        if (!href || !/^(?:https:\/\/muster\.today)?\/#.+/.test(href)) continue;
        const hash = decodeURIComponent(new URL(href, "https://muster.today").hash.slice(1));
        backlinks.push({ page: relative(WWW, path), hash });
      }
    }
    expect(backlinks.length).toBeGreaterThan(0);
    for (const { page, hash } of backlinks) expect(ids.has(hash), `${page} links to missing /#${hash}`).toBe(true);
  });

  it("publishes only FAQ structured answers that match visible questions and text", () => {
    const faqSection = /<section\b[^>]*id=["']questions["'][^>]*>([\s\S]*?)<\/section>/i.exec(html)?.[1];
    expect(faqSection).toBeTruthy();
    const visible = [...faqSection!.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)].map((match) => {
      const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(match[1]);
      assert.ok(summary);
      const name = plain(summary[1].replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, ""));
      const text = plain(match[1].slice(summary.index + summary[0].length));
      return { name, text };
    });
    const schemaNode = z.object({
      "@type": z.string(),
      mainEntity: z.array(z.object({
        "@type": z.literal("Question"), name: z.string(),
        acceptedAnswer: z.object({ "@type": z.literal("Answer"), text: z.string() }),
      })).optional(),
    });
    const schemaDocument = z.union([z.object({ "@graph": z.array(schemaNode) }), schemaNode]);
    const schemas = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map((match) => schemaDocument.parse(JSON.parse(match[1])));
    const faqs = schemas.flatMap((value) => "@graph" in value ? value["@graph"] : [value])
      .filter((value) => value["@type"] === "FAQPage");
    expect(faqs).toHaveLength(1);
    expect(visible.length).toBeGreaterThanOrEqual(4);
    expect(faqs[0].mainEntity?.map((entry) => ({ name: plain(entry.name), text: plain(entry.acceptedAnswer.text) }))).toEqual(visible);
  });
});

const keys = ['update', 'plan', 'research'];
const review = (controller: HandoffController) => { controller.start(); return controller.advance(); };

test('all sample jobs have complete, immutable presentation data', () => {
  assert.deepEqual(Object.keys(SCENARIOS), keys);
  for (const scenario of Object.values(SCENARIOS)) {
    for (const name of ['label', 'role', 'title', 'brief', 'draftTitle', 'approvalTitle', 'approvalDetail', 'approveLabel', 'receiptApproved', 'receiptDraft'] as const) {
      expect(scenario[name]).toBeTypeOf('string');
      assert.ok(scenario[name].trim().length > 5, name);
    }
    for (const name of ['inputs', 'steps', 'draft'] as const) {
      assert.equal(scenario[name].length, 3);
      for (const line of scenario[name]) {
        expect(line).toBeTypeOf('string');
        assert.ok(line.trim());
      }
      assert.ok(Object.isFrozen(scenario[name]));
    }
    assert.ok(Object.isFrozen(scenario));
    assert.notEqual(scenario.receiptApproved, scenario.receiptDraft);
  }
  assert.ok(Object.isFrozen(SCENARIOS));
});

test('default is a clearly labelled local demo with no decision or receipt', () => {
  const snapshot = createHandoff().getSnapshot();
  assert.equal(snapshot.scenarioKey, 'update');
  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.cue, 'idle');
  assert.equal(snapshot.outcome, null);
  assert.equal(snapshot.receipt, null);
  assert.match(snapshot.disclaimer, /Local scripted demo/);
  assert.match(snapshot.disclaimer, /no AI connection/);
});

for (const key of keys) {
  for (const decision of ['approve', 'draft']) {
    test(`${key}: ${decision} completes only after the explicit review step`, () => {
      const controller = createHandoff(key);
      const preparing = controller.start();
      assert.equal(preparing.phase, 'preparing');
      assert.equal(preparing.cue, 'thinking');
      assert.equal(preparing.receipt, null);
      const reviewing = controller.advance();
      assert.equal(reviewing.phase, 'review');
      assert.equal(reviewing.outcome, null);
      assert.equal(reviewing.cue, 'curious');
      const result = controller.decide(decision);
      assert.equal(result.phase, 'complete');
      assert.equal(result.scenarioKey, key);
      assert.equal(result.outcome, decision === 'approve' ? 'approved' : 'draft');
      assert.equal(result.cue, decision === 'approve' ? 'celebrate' : 'happy');
      assert.equal(result.receipt, decision === 'approve' ? SCENARIOS[key].receiptApproved : SCENARIOS[key].receiptDraft);
      assert.match(result.receipt, /sample/i);
    });
  }
}

test('lifecycle controls cannot skip preparing or review', () => {
  const controller = createHandoff();
  const ready = controller.getSnapshot();
  assert.deepEqual(controller.advance(), ready);
  assert.deepEqual(controller.decide('approve'), ready);
  assert.deepEqual(controller.decide('draft'), ready);
  const preparing = controller.start();
  assert.deepEqual(controller.start(), preparing);
  assert.deepEqual(controller.decide('approve'), preparing);
  assert.deepEqual(controller.decide('draft'), preparing);
  const reviewing = controller.advance();
  assert.deepEqual(controller.start(), reviewing);
  assert.deepEqual(controller.advance(), reviewing);
});

test('a completed choice is stable until reset or scenario selection', () => {
  const controller = createHandoff();
  review(controller);
  const approved = controller.decide('approve');
  assert.deepEqual(controller.decide('draft'), approved);
  assert.deepEqual(controller.decide('approve'), approved);
  assert.deepEqual(controller.start(), approved);
  assert.deepEqual(controller.advance(), approved);
});

const moveTo = (controller: HandoffController, phase: string) => {
  if (phase === 'ready') return;
  controller.start();
  if (phase === 'preparing') return;
  controller.advance();
  if (phase === 'review') return;
  controller.decide('approve');
};

for (const phase of ['ready', 'preparing', 'review', 'complete']) {
  test(`switching any job from ${phase} clears all prior task state`, () => {
    for (const from of keys) {
      for (const to of keys) {
        const controller = createHandoff(from);
        moveTo(controller, phase);
        const selected = controller.selectScenario(to);
        assert.deepEqual(selected, createHandoff(to).getSnapshot());
        // In-flight work from the old job cannot advance a freshly selected job.
        assert.deepEqual(controller.advance(), selected);
        assert.deepEqual(controller.decide('approve'), selected);
      }
    }
  });

  test(`reset from ${phase} retains the selected job and removes progress`, () => {
    for (const key of keys) {
      const controller = createHandoff(key);
      moveTo(controller, phase);
      assert.deepEqual(controller.reset(), createHandoff(key).getSnapshot());
      assert.equal(controller.start().phase, 'preparing');
    }
  });
}

test('reset after keeping a draft clears that result and permits a different decision', () => {
  const controller = createHandoff('plan');
  review(controller);
  controller.decide('draft');
  const reset = controller.reset();
  assert.equal(reset.outcome, null);
  assert.equal(reset.receipt, null);
  review(controller);
  assert.equal(controller.decide('approve').outcome, 'approved');
});

test('unknown scenario keys never expose prototype properties or corrupt current state', () => {
  const controller = createHandoff('research');
  review(controller);
  const original = controller.getSnapshot();
  for (const bad of ['', 'missing', 'toString', '__proto__', 'constructor', null, 1, {}]) {
    assert.throws(() => createHandoff(bad), RangeError);
    assert.throws(() => controller.selectScenario(bad), RangeError);
    assert.deepEqual(controller.getSnapshot(), original);
  }
});

test('unknown decisions fail without converting a review into a result', () => {
  const controller = createHandoff();
  review(controller);
  const original = controller.getSnapshot();
  for (const bad of ['', 'approved', 'deny', null, undefined, true, {}]) {
    assert.throws(() => controller.decide(bad), RangeError);
    assert.deepEqual(controller.getSnapshot(), original);
  }
});

test('snapshots and nested content cannot mutate shared definitions or the controller', () => {
  const controller = createHandoff();
  const snapshot = controller.getSnapshot();
  assert.ok(Object.isFrozen(controller));
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => { Object.assign(snapshot, { phase: 'complete' }); }, TypeError);
  assert.throws(() => { Object.assign(snapshot.scenario, { title: 'Tampered' }); }, TypeError);
  assert.throws(() => { Array.prototype.push.call(snapshot.scenario.inputs, 'Injected'); }, TypeError);
  assert.throws(() => { Object.assign(SCENARIOS, { update: {} }); }, TypeError);
  controller.start();
  assert.equal(snapshot.phase, 'ready');
  assert.equal(controller.getSnapshot().phase, 'preparing');
  assert.equal(snapshot.scenario.inputs.length, 3);
});

test('independent visitors never share task progress or outcomes', () => {
  const first = createHandoff('update');
  const second = createHandoff('research');
  review(first);
  first.decide('approve');
  assert.deepEqual(second.getSnapshot(), createHandoff('research').getSnapshot());
  second.selectScenario('plan');
  assert.equal(first.getSnapshot().scenarioKey, 'update');
  assert.equal(first.getSnapshot().outcome, 'approved');
});
