import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, resolve, sep } from "node:path";
import { build } from "esbuild";
import { expect, test as baseTest, type Locator, type Page } from "@playwright/test";
import { z } from "zod";

const repository = resolve(import.meta.dirname, "..");
const root = resolve(import.meta.dirname, "../www");
const types = new Map([[".html", "text/html"], [".js", "text/javascript"], [".mjs", "text/javascript"], [".css", "text/css"], [".png", "image/png"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"]]);
const fixtureAssets = new Map<string, Uint8Array>();
const fixturePath = "/__crew_app";
// The fixture imports the real components. Controls change only this ephemeral
// React tree; no account, API, persisted state or private test file is involved.
const fixtureSource = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentAvatar } from './src/components/Avatar';
import { MusterCrewAvatar } from './src/components/MusterCrewAvatar';
import { CREW_CHARACTERS, CREW_STATES } from './src/lib/mascot/crew';
import { Button } from './src/components/ui/button';
import { Input } from './src/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './src/components/ui/card';
import { Badge } from './src/components/ui/badge';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from './src/components/ui/dialog';
import { Card as SettingsCard, CommandLine } from './src/components/SettingsPrimitives';
function FoundationFixture() {
  const [value, setValue] = useState('Crew');
  const [clicks, setClicks] = useState(0);
  const [submits, setSubmits] = useState(0);
  const [linkClicks, setLinkClicks] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null), buttonRef = useRef(null), linkRef = useRef(null);
  return <main data-testid="foundation-fixture"><h1>Foundation component contracts</h1>
    <form onSubmit={event => { event.preventDefault(); setSubmits(count => count + 1); }}>
      <label htmlFor="controlled-input">Crew label</label>
      <Input ref={inputRef} id="controlled-input" name="crew-label" type="text" value={value} onChange={event => setValue(event.target.value)} required maxLength={32} autoComplete="off" aria-describedby="input-help" className="fixture-input" />
      <p id="input-help">This value belongs only to the fixture.</p><output aria-label="Controlled value">{value}</output>
      <Button type="button" onClick={() => inputRef.current.focus()}>Focus input through ref</Button>
      <Button ref={buttonRef} type="button" onClick={() => setClicks(count => count + 1)}>Count action</Button>
      <Button type="button" variant="ghost" onClick={() => buttonRef.current.focus()}>Focus action through ref</Button>
      <Button type="button" disabled onClick={() => setClicks(count => count + 100)}>Disabled action</Button>
      <output aria-label="Action count">{clicks}</output><output aria-label="Form submits">{submits}</output>
      <Button asChild ref={linkRef} variant="link"><a href="#foundation-target" onClick={() => setLinkClicks(count => count + 1)}>Composed fixture link</a></Button>
      <Button type="button" variant="ghost" onClick={() => linkRef.current.focus()}>Focus link through ref</Button>
      <output aria-label="Link count">{linkClicks}</output>
    </form>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button type="button">Open crew details</Button></DialogTrigger>
      <DialogContent aria-describedby="dialog-description"><DialogHeader><DialogTitle>Crew details</DialogTitle><DialogDescription id="dialog-description">An isolated controlled dialog.</DialogDescription></DialogHeader>
        <Input aria-label="Dialog note" defaultValue="Keep this draft" />
        <DialogFooter><DialogClose asChild><Button type="button">Done with details</Button></DialogClose></DialogFooter>
      </DialogContent>
    </Dialog><output aria-label="Dialog controlled state">{open ? 'open' : 'closed'}</output>
    <Card id="foundation-card" className="fixture-card" aria-label="Crew summary">
      <CardHeader id="foundation-header"><CardTitle id="foundation-title">Ready for review</CardTitle><CardDescription id="foundation-description">A human makes the next decision.</CardDescription></CardHeader>
      <CardContent id="foundation-content"><Badge variant="secondary" role="status" aria-label="Approval status" className="fixture-badge">Waiting</Badge><p>Keep the draft.</p></CardContent>
      <CardFooter id="foundation-footer"><Button type="button" variant="outline">Review locally</Button></CardFooter>
    </Card>
    <section id="settings-titled"><SettingsCard title="Crew identity" subtitle="Choose a name without changing the conversation."><p id="settings-child">Saved conversation stays here.</p></SettingsCard></section>
    <section id="settings-subtitle"><SettingsCard subtitle="Only a description."><p>Description child</p></SettingsCard></section>
    <section id="settings-plain"><SettingsCard><p>Children only.</p></SettingsCard></section>
    <section id="command-fixture"><CommandLine command="muster status --json" /><button type="button" onClick={() => { document.documentElement.dataset.testClipboard = 'deny'; }}>Deny fixture clipboard</button></section>
    <div id="foundation-target">Same-document link destination</div>
  </main>;
}
function Fixture() {
  const [state, setState] = useState('idle');
  const [motion, setMotion] = useState('none');
  const [motionKey, setMotionKey] = useState(0);
  const [animated, setAnimated] = useState(true);
  const [mounted, setMounted] = useState(true);
  return <main data-testid="mounted-crew">
    <nav aria-label="Fixture controls">
      <label>Expression <select aria-label="Mounted expression" value={state} onChange={event => setState(event.target.value)}>{CREW_STATES.map(cue => <option key={cue} value={cue}>{cue}</option>)}</select></label>
      <button onClick={() => { setMotion('launch'); setMotionKey(key => key + 1); }}>Replay launch</button>
      <button onClick={() => setMotion('none')}>Clear reaction</button>
      <button onClick={() => setAnimated(false)}>Freeze animation</button>
      <button onClick={() => document.getElementById('offscreen-actor').scrollIntoView()}>Show offscreen actor</button>
      <button onClick={() => window.scrollTo(0, 0)}>Return to top</button>
      <button onClick={() => { document.getElementById('nested-viewport').scrollTop = 600; }}>Scroll nested away</button>
      <button onClick={() => { document.getElementById('nested-viewport').scrollTop = 0; }}>Restore nested actor</button>
      <button onClick={() => setMounted(false)}>Unmount actors</button>
    </nav>
    {mounted && <>
      <div id="crew-portraits">{CREW_CHARACTERS.map(character => <section key={character} data-role={character}><h2>{character}</h2>{[24,44,96].map(size => <MusterCrewAvatar key={size} character={character} size={size} state={state} animated={animated} label={character + ' ' + size} />)}</section>)}</div>
      <div id="motion"><AgentAvatar color="orange" character="designer" state="listening" size={96} motion={motion} motionKey={motionKey} animated={animated} /></div>
      <div id="nested-viewport"><div style={{height:1200}}><MusterCrewAvatar character="researcher" label="Nested actor" size={96} /></div></div>
      <div style={{height:1500}} /><div id="offscreen-actor"><MusterCrewAvatar character="researcher" size={96} label="Offscreen actor" /></div>
    </>}
  </main>;
}
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('foundation') ? <FoundationFixture /> : <Fixture />);
`;
const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/__crew_fixture__/fixture.css"><style>
body{margin:0;background:#faf8f0;color:#252e26;font-family:system-ui}main{padding:110px 16px 16px}nav{position:fixed;z-index:2;inset:0 0 auto;background:#fffef7;padding:8px;display:flex;flex-wrap:wrap;gap:6px}button,select{min-height:32px}#crew-portraits{display:flex;gap:16px}h2{font-size:15px}#nested-viewport{height:120px;width:130px;overflow:auto}
</style></head><body><div id="root"></div><script type="module" src="/__crew_fixture__/fixture.js"></script></body></html>`;
let origin = "";
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET") { response.writeHead(403).end(); return; }
    if (url.pathname === fixturePath) { response.writeHead(200, { "content-type": "text/html" }).end(fixtureHtml); return; }
    const fixture = fixtureAssets.get(url.pathname);
    if (fixture) { response.writeHead(200, { "content-type": types.get(extname(url.pathname)) }).end(fixture); return; }
    const file = resolve(root, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types.get(extname(file)) ?? "application/octet-stream" }).end(body);
  } catch { response.writeHead(404).end(); }
});
const test = baseTest.extend({
  page: async ({ browser }, use, info) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    console.log(JSON.stringify({ event: "CREW_CONTEXT_START", pid: process.pid, origin, test: info.title, owned: true }));
    try {
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== "GET" || url.pathname.startsWith("/api/")) {
          errors.push(`Unexpected crew request: ${request.method()} ${url.origin}${url.pathname}`);
          await route.abort("blockedbyclient"); return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await use(page);
      expect(errors, "Owned crew fixture makes no external/API writes or uncaught errors").toEqual([]);
    } finally {
      await context.close();
      console.log(JSON.stringify({ event: "CREW_CONTEXT_END", pid: process.pid, test: info.title, closed: true }));
    }
  },
});
test.describe.configure({ retries: 0 });
test.beforeAll(async () => {
  const compiled = await build({ stdin: { contents: fixtureSource, resolveDir: repository, sourcefile: "crew-fixture.jsx", loader: "jsx" },
    bundle: true, write: false, format: "esm", jsx: "automatic", platform: "browser",
    outfile: resolve(repository, "__crew_fixture__/fixture.js"), alias: { "@": resolve(repository, "src") },
    define: { "process.env.NODE_ENV": '"production"' } });
  for (const output of compiled.outputFiles) fixtureAssets.set(`/__crew_fixture__/${basename(output.path)}`, output.contents);
  if (!fixtureAssets.has("/__crew_fixture__/fixture.js") || !fixtureAssets.has("/__crew_fixture__/fixture.css")) throw new Error("Mounted fixture bundle must include real component styles");
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const { port } = z.object({ port: z.number().int().positive() }).parse(server.address());
  origin = `http://127.0.0.1:${port}`;
  console.log(JSON.stringify({ event: "CREW_SERVER_START", pid: process.pid, port, origin, backend: "none", bundle: "memory-only" }));
});
test.afterAll(async () => {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
  fixtureAssets.clear();
  console.log(JSON.stringify({ event: "CREW_SERVER_END", pid: process.pid, origin, closed: true }));
});

test("four crew choices keep costumes, all forty expressions and independent controls", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const crew = page.locator("#crew");
  await crew.scrollIntoViewIfNeeded();
  await expect(crew.locator("#crew-expression option")).toHaveCount(40);
  for (const [role, cue] of [["designer", "writing"], ["researcher", "searching"], ["developer", "working"], ["coordinator", "listening"]]) {
    await crew.locator(`button[data-crew-role="${role}"]`).click();
    await expect(crew).toHaveAttribute("data-crew-role", role);
    await expect(crew).toHaveAttribute("data-crew-state", cue);
    await expect(crew.locator("#crew-name")).toHaveText(new RegExp(role, "i"));
    await expect(crew.locator("#crew-mascot img")).toHaveAttribute("src", new RegExp(`${role}\\.png$`));
  }
  await crew.getByRole("button", { name: "Emotions", exact: true }).click();
  await expect(crew.locator("#crew-expressions button")).toHaveCount(16);
  await crew.getByRole("button", { name: "Laughing", exact: true }).click();
  await expect(crew).toHaveAttribute("data-crew-state", "laughing");
  await expect(crew).toHaveAttribute("data-crew-paused", "false");
  await crew.locator("#crew-pause").click();
  await expect(crew).toHaveAttribute("data-crew-paused", "true");
  await expect(crew.locator("#crew-pause")).toHaveAttribute("aria-pressed", "true");
  const values = await crew.locator("#crew-expression option").evaluateAll(options => options.map(option => option.getAttribute("value") ?? ""));
  expect(values).toHaveLength(40);
  expect(new Set(values).size).toBe(40);
  expect(values).not.toContain("");
  for (const value of values) {
    await test.step(`Select crew expression ${value} while paused`, async () => {
      const started = Date.now();
      try {
        await crew.locator("#crew-expression").selectOption(value);
        await expect(crew).toHaveAttribute("data-crew-state", value);
        await expect(crew.locator("#crew-expression")).toHaveValue(value);
        await expect(crew).toHaveAttribute("data-crew-paused", "true");
      } finally {
        console.log(JSON.stringify({ event: "CREW_EXPRESSION_CASE", value, elapsedMs: Date.now() - started }));
      }
    });
  }
  await crew.locator("#crew-pause").click();
  await expect(crew).toHaveAttribute("data-crew-paused", "false");
  await expect(crew.locator("#crew-pause")).toHaveAttribute("aria-pressed", "false");
  await expect(crew).toHaveAttribute("data-crew-state", values.at(-1)!);
  await expect(crew.locator("#crew-expression")).toHaveValue(values.at(-1)!);
  expect(errors).toEqual([]);
});

test("story advances through teammates, pauses exactly and remains interruptible", async ({ page }) => {
  await page.goto(origin);
  const crew = page.locator("#crew"); await crew.scrollIntoViewIfNeeded();
  await crew.locator("#crew-story").click();
  await expect(crew).toHaveAttribute("data-crew-story", "1");
  await expect(crew).toHaveAttribute("data-crew-role", "coordinator");
  await expect(crew).toHaveAttribute("data-crew-story", "2", { timeout: 12000 });
  await crew.locator("#crew-pause").click();
  const before = await crew.getAttribute("data-crew-story");
  // Step two lasts 3.2 seconds: a shorter observation would also pass if it kept playing.
  await page.waitForTimeout(4000);
  await expect(crew).toHaveAttribute("data-crew-story", before!);
  await expect(crew).toHaveAttribute("data-crew-paused", "true");
  await crew.locator("#crew-expression").selectOption("thinking-dots");
  await expect(crew).toHaveAttribute("data-crew-story", "idle");
  await expect(crew).toHaveAttribute("data-crew-state", "thinking-dots");
  await expect(crew).toHaveAttribute("data-crew-paused", "true");
});

test("the selected 3D rig changes costume without losing expression or pause", async ({ page }) => {
  await page.goto(origin);
  const crew = page.locator("#crew"); await crew.scrollIntoViewIfNeeded();
  await expect(crew).toHaveAttribute("data-crew-ready", "true");
  await crew.locator("#crew-pause").click();
  await crew.locator('button[data-crew-role="developer"]').click();
  await crew.locator("#crew-expression").selectOption("progress");
  await expect(crew.locator("#crew-mascot")).toHaveAttribute("data-mascot-role", "developer");
  await expect(crew.locator("#crew-mascot")).toHaveAttribute("data-mascot-state", "progress");
  await expect(crew.locator("#crew-mascot")).toHaveAttribute("data-mascot-paused", "true");
  await expect(crew.locator("#crew-mascot canvas")).toHaveCount(1);
});

test("portraits and expression controls survive a WebGL failure", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: function (this: HTMLCanvasElement, kind: string, options?: CanvasRenderingContext2DSettings | WebGLContextAttributes) {
      return /webgl/i.test(kind) ? null : original.call(this, kind, options);
    } });
  });
  await page.goto(origin); const crew = page.locator("#crew"); await crew.scrollIntoViewIfNeeded();
  await expect(crew).toHaveAttribute("data-crew-ready", "false");
  await crew.locator('button[data-crew-role="researcher"]').click();
  await crew.locator("#crew-expression").selectOption("happy");
  await expect(crew).toHaveAttribute("data-crew-state", "happy");
  await expect(crew.locator("#crew-mascot img")).toBeVisible();
});

for (const width of [320, 1440]) test(`crew fits ${width}px and obeys reduced motion`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(origin); const crew = page.locator("#crew"); await crew.scrollIntoViewIfNeeded();
  await expect(crew).toHaveAttribute("data-crew-paused", "true");
  await crew.locator("#crew-expression").selectOption("surprised");
  await expect(crew).toHaveAttribute("data-crew-state", "surprised");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(crew.locator("#crew-expression")).toBeVisible();
});

test("the complete crew portraits remain readable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 900 } });
  const unexpected: string[] = [];
  console.log(JSON.stringify({ event: "CREW_CONTEXT_START", pid: process.pid, origin, test: "no-JavaScript portraits", owned: true }));
  try {
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || request.method() !== "GET" || url.pathname.startsWith("/api/")) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort("blockedbyclient"); return;
      }
      await route.continue();
    });
    const page = await context.newPage(); await page.goto(origin);
    await expect(page.locator(".crew-lineup img")).toHaveCount(4);
    await expect(page.locator("#crew-title")).toHaveText("Different minds.Good company.");
    for (const image of await page.locator(".crew-lineup img").all()) {
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute("alt", /.+/);
      await expect.poll(() => image.evaluate(element => {
        if (!(element instanceof HTMLImageElement)) throw new Error("Portrait must be a real image");
        return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
      })).toBe(true);
    }
    expect(unexpected).toEqual([]);
  } finally { await context.close(); console.log(JSON.stringify({ event: "CREW_CONTEXT_END", pid: process.pid, test: "no-JavaScript portraits", closed: true })); }
});

async function openMounted(page: Page, withoutObserver = false) {
  if (withoutObserver) await page.addInitScript(() => { Reflect.deleteProperty(window, "IntersectionObserver"); });
  await page.addInitScript(() => {
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (this: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
      if (this.canvas instanceof HTMLCanvasElement) this.canvas.dataset.testPaints = String(Number(this.canvas.dataset.testPaints ?? 0) + 1);
      return fill.call(this, x, y, width, height);
    };
  });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto(`${origin}${fixturePath}`);
  await expect(page.getByTestId("mounted-crew")).toBeVisible();
  await page.clock.pauseAt(new Date("2026-01-01T00:05:00Z"));
}
const paints = (avatar: Locator) => avatar.locator("canvas").getAttribute("data-test-paints").then(value => Number(value ?? 0));
const actorScale = (actor: Locator) => actor.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);

test("mounted IO fallback pauses an offscreen actor without advancing its canvas", async ({ page }) => {
  await openMounted(page, true);
  expect(await page.evaluate(() => "IntersectionObserver" in window)).toBe(false);
  const avatar = page.getByRole("img", { name: "Offscreen actor", exact: true });
  await expect(avatar).toHaveAttribute("data-bot-paused", "true");
  const before = await paints(avatar);
  await page.clock.runFor(400);
  expect(await paints(avatar)).toBe(before);
});

test("mounted IO fallback resumes on scroll and observes nested scroll capture", async ({ page }) => {
  await openMounted(page, true);
  const avatar = page.getByRole("img", { name: "Offscreen actor", exact: true });
  await page.getByRole("button", { name: "Show offscreen actor", exact: true }).click();
  await page.clock.runFor(100);
  await expect(avatar).toHaveAttribute("data-bot-paused", "false");
  const before = await paints(avatar);
  await page.clock.runFor(300);
  expect(await paints(avatar)).toBeGreaterThan(before);
  await page.getByRole("button", { name: "Return to top", exact: true }).click();
  await page.clock.runFor(100);
  await expect(avatar).toHaveAttribute("data-bot-paused", "true");
  const nested = page.getByRole("img", { name: "Nested actor", exact: true });
  await expect(nested).toHaveAttribute("data-bot-paused", "false");
  await page.getByRole("button", { name: "Scroll nested away", exact: true }).click();
  await page.clock.runFor(100);
  await expect(nested).toHaveAttribute("data-bot-paused", "true");
  const paused = await paints(nested);
  await page.clock.runFor(250);
  expect(await paints(nested)).toBe(paused);
  await page.getByRole("button", { name: "Restore nested actor", exact: true }).click();
  await page.clock.runFor(100);
  await expect(nested).toHaveAttribute("data-bot-paused", "false");
  expect(await paints(nested)).toBeGreaterThan(paused);
});

test("mounted motionKey restarts an active launch before returning to actual activity", async ({ page }) => {
  await openMounted(page, true);
  const avatar = page.locator("#motion [data-crew-character]"), actor = avatar.locator(".muster-crew-avatar__body");
  await page.getByRole("button", { name: "Replay launch", exact: true }).click();
  await expect(avatar).toHaveAttribute("data-state", "spawning");
  await page.clock.runFor(750);
  expect(await actorScale(actor)).toBeGreaterThan(.85);
  await page.getByRole("button", { name: "Replay launch", exact: true }).click();
  await page.clock.runFor(32);
  expect(await actorScale(actor), "The entry scale restarts; extending only the timeout is insufficient").toBeLessThan(.4);
  await page.clock.runFor(750);
  await expect(avatar).toHaveAttribute("data-state", "spawning");
  expect(await actorScale(actor)).toBeGreaterThan(.85);
  await page.clock.runFor(700);
  await expect(avatar).toHaveAttribute("data-state", "listening");
});

test("mounted motion none restores underlying activity during an unfinished beat", async ({ page }) => {
  await openMounted(page, true);
  const avatar = page.locator("#motion [data-crew-character]");
  await page.getByRole("button", { name: "Replay launch", exact: true }).click();
  await expect(avatar).toHaveAttribute("data-state", "spawning");
  await page.clock.runFor(150);
  await page.getByRole("button", { name: "Clear reaction", exact: true }).click();
  await expect(avatar).toHaveAttribute("data-state", "listening");
  await page.clock.runFor(1500);
  await expect(avatar).toHaveAttribute("data-state", "listening");
});

test("mounted animated false restores activity and unmount stops retained canvas painting", async ({ page }) => {
  await openMounted(page, true);
  const avatar = page.locator("#motion [data-crew-character]");
  await page.getByRole("button", { name: "Replay launch", exact: true }).click();
  await expect(avatar).toHaveAttribute("data-state", "spawning");
  await page.getByRole("button", { name: "Freeze animation", exact: true }).click();
  await expect(avatar).toHaveAttribute("data-state", "listening");
  await expect(avatar).toHaveAttribute("data-bot-paused", "true");
  const before = await paints(avatar);
  await page.clock.runFor(400);
  expect(await paints(avatar)).toBe(before);
  // The nested actor is still animated; retain its real detached canvas to prove cleanup.
  const canvas = await page.getByRole("img", { name: "Nested actor", exact: true }).locator("canvas").elementHandle();
  if (!canvas) throw new Error("Missing owned nested canvas");
  try {
    await page.getByRole("button", { name: "Unmount actors", exact: true }).click();
    await expect(page.locator("[data-crew-character]")).toHaveCount(0);
    const detachedPaints = await canvas.getAttribute("data-test-paints");
    await page.clock.runFor(400);
    expect(await canvas.getAttribute("data-test-paints")).toBe(detachedPaints);
  } finally { await canvas.dispose(); }
});

test("all forty crew expressions render in mounted real components at compact app sizes", async ({ page }) => {
  await openMounted(page);
  const select = page.getByRole("combobox", { name: "Mounted expression", exact: true });
  const values = await select.locator("option").evaluateAll(options => options.map(option => option.getAttribute("value") ?? ""));
  expect(values).toHaveLength(40);
  expect(new Set(values).size).toBe(40);
  const portraits = page.locator("#crew-portraits [data-crew-character]");
  await expect(portraits).toHaveCount(12);
  for (const value of values) {
    await select.selectOption(value); await page.clock.runFor(48);
    for (const portrait of await portraits.all()) {
      await expect(portrait).toHaveAttribute("data-state", value);
      await expect(portrait).toHaveAttribute("data-face-ready", "true");
    }
  }
  for (const size of [24, 44]) {
    const avatar = page.getByRole("img", { name: `designer ${size}`, exact: true });
    const box = await avatar.boundingBox();
    expect(box?.width).toBe(size); expect(box?.height).toBe(size);
  }
});

test("reduced-motion crew retains readable static product signals and a true dots morph", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openMounted(page, true);
  const select = page.getByRole("combobox", { name: "Mounted expression", exact: true });
  const cues = ["sending", "receiving", "uploading", "alerting", "notifying", "dictating", "powering-down", "thinking-dots"];
  for (const cue of cues) {
    await select.selectOption(cue);
    for (const size of [24,44]) {
      const avatar = page.getByRole("img", { name: `designer ${size}`, exact: true });
      await expect(avatar).toHaveAttribute("data-bot-paused", "true");
      const signal = avatar.locator(`[data-cue="${cue}"]`);
      await expect(signal).toBeVisible();
      await expect(signal).toHaveCSS("opacity", "1");
      const extent = await signal.evaluate(element => {
        if (!(element instanceof SVGGraphicsElement)) throw new Error("Cue must contain rendered SVG geometry");
        const box = element.getBBox();
        return { width: box.width, height: box.height };
      });
      expect(Math.max(extent.width, extent.height) * size / 280, "A compact cue has actual visible geometry").toBeGreaterThan(6);
      expect(Math.min(extent.width, extent.height) * size / 280).toBeGreaterThan(1.5);
      if (cue === "thinking-dots") {
        await expect(avatar.locator("[data-dot]")).toHaveCount(3);
        await expect(avatar.locator(".muster-crew-avatar__body")).toHaveCSS("visibility", "hidden");
      }
      const before = await paints(avatar);
      const still = await signal.innerHTML();
      await page.clock.runFor(100);
      expect(await paints(avatar)).toBe(before);
      expect(await signal.innerHTML()).toBe(still);
    }
  }
});

test("Gaia input and button composition retain controlled values, native props and forwarded refs", async ({ page }) => {
  await page.goto(`${origin}${fixturePath}?foundation`);
  await expect(page.getByTestId("foundation-fixture")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Crew label", exact: true });
  await expect(input).toHaveValue("Crew");
  await expect(input).toHaveAttribute("name", "crew-label");
  await expect(input).toHaveAttribute("maxlength", "32");
  await expect(input).toHaveAttribute("required", "");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("aria-describedby", "input-help");
  await expect(input).toHaveClass(/\bfixture-input\b/);
  await input.fill("Research companion");
  await expect(page.getByLabel("Controlled value", { exact: true })).toHaveText("Research companion");
  await page.getByRole("button", { name: "Focus input through ref", exact: true }).click();
  await expect(input).toBeFocused();
  const action = page.getByRole("button", { name: "Count action", exact: true });
  await expect(action).toHaveAttribute("type", "button");
  await action.click();
  await expect(page.getByLabel("Action count", { exact: true })).toHaveText("1");
  await page.getByRole("button", { name: "Focus action through ref", exact: true }).click();
  await expect(action).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Action count", { exact: true })).toHaveText("2");
  await expect(page.getByLabel("Form submits", { exact: true })).toHaveText("0");
  await expect(page.getByRole("button", { name: "Disabled action", exact: true })).toBeDisabled();
  const link = page.getByRole("link", { name: "Composed fixture link", exact: true });
  expect(await link.evaluate(element => element.tagName)).toBe("A");
  await expect(link).toHaveAttribute("href", "#foundation-target");
  await page.getByRole("button", { name: "Focus link through ref", exact: true }).click();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${origin}${fixturePath}?foundation#foundation-target`);
  await expect(page.getByLabel("Link count", { exact: true })).toHaveText("1");
  await expect(page.getByLabel("Form submits", { exact: true })).toHaveText("0");
});

test("Gaia controlled dialog closes with Escape and restores its trigger focus", async ({ page }) => {
  await page.goto(`${origin}${fixturePath}?foundation`);
  const trigger = page.getByRole("button", { name: "Open crew details", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Crew details", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription("An isolated controlled dialog.");
  await expect(page.getByLabel("Dialog controlled state", { exact: true })).toHaveText("open");
  await expect(dialog.getByRole("textbox", { name: "Dialog note", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Dialog controlled state", { exact: true })).toHaveText("closed");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Done with details", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Gaia card and badge preserve content while settings cards retain their existing spacing contract", async ({ page }) => {
  await page.goto(`${origin}${fixturePath}?foundation`);
  const card = page.locator("#foundation-card");
  await expect(card).toHaveAttribute("aria-label", "Crew summary");
  await expect(card).toHaveClass(/\bfixture-card\b/);
  await expect(card.locator("#foundation-title")).toHaveText("Ready for review");
  await expect(card.locator("#foundation-description")).toHaveText("A human makes the next decision.");
  await expect(card.locator("#foundation-header")).toHaveClass(/\bp-6\b/);
  await expect(card.locator("#foundation-content")).toHaveClass(/\bpt-0\b/);
  await expect(card.locator("#foundation-footer").getByRole("button", { name: "Review locally", exact: true })).toBeVisible();
  const badge = card.getByRole("status", { name: "Approval status", exact: true });
  await expect(badge).toHaveText("Waiting");
  await expect(badge).toHaveClass(/\bfixture-badge\b/);
  expect(await badge.evaluate(element => element.tagName)).toBe("SPAN");
  const settings = page.locator("#settings-titled > .workspace-settings-card");
  await expect(settings).toHaveCount(1);
  await expect(settings).toHaveClass(/\bp-4\b/);
  await expect(settings.locator(":scope > div")).toHaveCount(3);
  const title = settings.locator(":scope > div").nth(0);
  await expect(title).toHaveText("Crew identity");
  await expect(title).toHaveAttribute("class", "workspace-settings-card-title text-[15px] font-medium text-ink");
  await expect(settings.locator(":scope > div").nth(1)).toHaveText("Choose a name without changing the conversation.");
  await expect(settings.locator(":scope > div").nth(1)).toHaveAttribute("class", "mt-0.5 text-[13px] leading-relaxed text-ink-secondary");
  await expect(settings.locator(":scope > div").nth(2)).toHaveAttribute("class", "mt-4");
  await expect(settings.locator("#settings-child")).toHaveText("Saved conversation stays here.");
  const subtitleOnly = page.locator("#settings-subtitle .workspace-settings-card");
  await expect(subtitleOnly.locator(":scope > div").nth(0)).toHaveAttribute("class", "text-[13px] leading-relaxed text-ink-secondary");
  await expect(subtitleOnly.locator(":scope > div").nth(1)).toHaveAttribute("class", "mt-4");
  const plain = page.locator("#settings-plain .workspace-settings-card");
  await expect(plain.locator(":scope > div")).toHaveCount(1);
  await expect(plain.locator(":scope > div")).not.toHaveAttribute("class");
  await expect(plain).toHaveText("Children only.");
});

test("Gaia settings copy action preserves successful feedback, timed reset and clipboard denial", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => {
        const root = document.documentElement;
        root.dataset.testCopyAttempts = String(Number(root.dataset.testCopyAttempts ?? 0) + 1);
        if (root.dataset.testClipboard === "deny") throw new DOMException("Owned fixture denied clipboard access", "NotAllowedError");
        root.dataset.testCopied = value;
      },
    } });
  });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto(`${origin}${fixturePath}?foundation`);
  await expect(page.getByTestId("foundation-fixture")).toBeVisible();
  await page.clock.pauseAt(new Date("2026-01-01T00:05:00Z"));
  const copy = page.locator("#command-fixture").getByRole("button", { name: "Copy command", exact: true });
  await expect(copy).toHaveAttribute("type", "button");
  await expect(copy).toHaveClass(/\bgaia-button\b/);
  // This memory bundle has no generated Tailwind stylesheet: assert the authored
  // 13px glyph attributes and override contract, not a fictional computed size.
  await expect(copy).toHaveClass(/\[&_svg\]:size-\[13px\]/);
  await expect(copy.locator("svg.lucide-copy")).toHaveAttribute("width", "13");
  await expect(copy.locator("svg.lucide-copy")).toHaveAttribute("height", "13");
  await copy.click();
  await expect(page.locator("html")).toHaveAttribute("data-test-copied", "muster status --json");
  await expect(page.locator("html")).toHaveAttribute("data-test-copy-attempts", "1");
  await expect(copy.locator("svg.lucide-check")).toHaveCount(1);
  await page.clock.runFor(1199);
  await expect(copy.locator("svg.lucide-check")).toHaveCount(1);
  await page.clock.runFor(2);
  await expect(copy.locator("svg.lucide-copy")).toHaveCount(1);
  await page.getByRole("button", { name: "Deny fixture clipboard", exact: true }).click();
  await copy.click();
  await expect(page.locator("html")).toHaveAttribute("data-test-copy-attempts", "2");
  await expect(copy.locator("svg.lucide-copy")).toHaveCount(1);
  await expect(copy.locator("svg.lucide-check")).toHaveCount(0);
  await page.clock.runFor(1300);
  await expect(copy.locator("svg.lucide-copy")).toHaveCount(1);
  await expect(page.locator("html")).toHaveAttribute("data-test-copied", "muster status --json");
});
