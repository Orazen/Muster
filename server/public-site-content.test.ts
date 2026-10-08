/** Typography, mascot/runtime assets and legal bodies stay locked. The owner
 * approved M-outline removal/orange on 7 October and the four crew costumes
 * on 8 October 2026. Only the approved entry/host/controller/styles/new crew
 * asset pins advance; existing fonts, rig, expression and vendor pins stay exact.
 * This portable contract does not need git at runtime. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { legalPageFor } from "./legal-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const LOCKED = {
  "www/index.html": "654e6a561d03da6fcf2418f655649f7e2bde80b6a78f76ff7935e89d3bd996f2",
  "www/landing-workroom/v1/NOTICE.txt": "b71df88ab87bd4fa50342afb115a3a86f682b1aa1dcba94a44e3d1a17c9c407d",
  "www/landing-workroom/v1/app.js": "8c2c852f195c91bad37c0b5e85313b3153cbeb4b74340bc5fc21cb18d58c8cf0",
  "www/landing-workroom/v1/favicon.svg": "28505c526c1631827136b006819490358388f267af99232ef0c96b8676cdcf63",
  "www/landing-workroom/v1/fonts/body-OFL.txt": "9e27a72ed30eb49a08678f6a5d6ed98ec7ba5368f541637ee0683ec9134ef966",
  "www/landing-workroom/v1/fonts/body.woff2": "2ee17598a98d8a59e4df8152d015bec9ab8e4d5672cc0ab42bef806b568e3971",
  "www/landing-workroom/v1/fonts/display-OFL.txt": "4b5a7d8f37f5602621c8a8d7358a6a2e71317e6c231c661e15aef0275d3e07ba",
  "www/landing-workroom/v1/fonts/display.woff2": "a79fdb52d4a5c76552452f69202add96e287401fff03d3e8c0e38b4dcb5a99cd",
  "www/landing-workroom/v1/handoff.mjs": "abe82be98db1624b6bcec2ddd7d612c7d0d9e3def2f13c188352e0e99a85984e",
  "www/landing-workroom/v1/mascot-stage.js": "1a21d021baeab560e8b781e28c6617b5fdb179fac5178314f8c9b7c0ac152d13",
  "www/landing-workroom/v1/mascot/companion.js": "7662202091fecea1f8fc1dba012fe371f66453b26158f2faeedd3196ff839294",
  "www/landing-workroom/v1/mascot/effects.js": "3fb08bbdd0469622067c850b22697da3117fd67da96f5353633f1be05d83292a",
  "www/landing-workroom/v1/mascot/expressions.js": "19c374beb4e41a3b8465d90b7b59a40deeacb64ac9de40cdd5d195f9fdb8f4fa",
  "www/landing-workroom/v1/mascot/fallback.png": "486930fbb21ffae4f04de6d89c7f8b3b00f7df14d3c2cdfecace7ee6d8c6c07e",
  "www/landing-workroom/v1/mascot/sculpt.js": "c98d75031d24d5107b1f5d9c57454862e868623d8dbed39691792f6cd58ddbb0",
  "www/landing-workroom/v1/mascot/vendor/MarchingCubes.js": "7480453d4ab7acfb6f8372db762ef6556bc4fbe19cd4f7461ba85facc0150249",
  "www/landing-workroom/v1/mascot/vendor/THREE-LICENSE.txt": "bfe119ea4fd413f5f7ca3fcd63adb0c4a073ed39daa2fe7d3e6b769e21272601",
  "www/landing-workroom/v1/mascot/vendor/three.core.js": "eb077d2417f61d3e6d9264c317cabc4ea35769ed6b0ab533067292a550784c20",
  "www/landing-workroom/v1/mascot/vendor/three.module.js": "c8211c69345d2e9949dc7a8ac969380497aa0600a5a8ac6a459c8cd02dd9cb8a",
  "www/landing-workroom/v1/social.jpg": "904d06b4be8b19fc4f208eb50bede54359c554dd614b940ac76af72d7eab18a3",
  "www/landing-workroom/v1/style.css": "4381475c350302af5afcc71c43e856258c10ec247821e6b2ccad22e00b99ef24",
  "www/landing-workroom/v1/mascot/role-outfits.js": "5cb00ec157035e74788159d07c9e205f7077b60747b41d5873643adfec516285",
  "www/landing-workroom/v1/mascot/crew.js": "198ada2121c9e861fd9889db4e59975f08261b2680c96df7b2ec214b76e55b24",
  "www/landing-workroom/v1/mascot/posters/designer.png": "d5c7db650f96f0bb2d2055de792ed8c08f099527b6fba74340cda2d1aef562e7",
  "www/landing-workroom/v1/mascot/posters/developer.png": "7b7d81811425f9114ca836d01279c912e6fe0b6413046e07729a7df497d68404",
  "www/landing-workroom/v1/crew.css": "d64c24b4613f10d646b6cf626371c2a74591a35a26433eddf67105aa820dfd7f",
  "www/landing-workroom/v1/mascot/posters/coordinator.png": "bffb1b67588e7914f5e324887422d36d061ccbab7aceaa9cdddd39c8bb903e03",
  "www/landing-workroom/v1/crew-stage.js": "bc958640b5190a4bc2f1555a531645bcfc2b23821ef2ae27e69beede5ffc3740",
  "www/landing-workroom/v1/mascot/posters/researcher.png": "1e590c5d7413b05279c7cf7dfbb0655890d43c97754039f992b7d8df378eef1d"
} as const;
const LEGAL_BODIES = {
  "privacyPolicy": "e42d6b6614762a0f570ce9d77fccbd5deb3aff52ade7e58296d0e86c02d61697",
  "termsOfService": "06b2420b7ec577b375a9749d6e7067bcdf4f64ab3566cd16a8104e95b864fd07"
} as const;
const DOC_PAGES = ["index", "quick-start", "install", "setup", "engines", "goals", "automation", "approvals", "agents", "security"];
const SUPPORT_PAGES = ["download", "teams", "switch", "templates"];
function files(path: string): string[] {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    expect(entry.isSymbolicLink(), `Public asset is a normal file: ${child}`).toBe(false);
    return entry.isDirectory() ? files(child) : [child];
  });
}
function resourceLinks(html: string) {
  return [...html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)].flatMap(([tag]) => {
    if (/^<link/i.test(tag) && !/rel=["'](?:stylesheet|icon|preload|modulepreload)["']/i.test(tag)) return [];
    const value = /(?:src|href)=["']([^"']+)["']/i.exec(tag)?.[1];
    return value && !value.startsWith("data:") ? [value] : [];
  });
}

describe("public-site presentation boundaries", () => {
  it("keeps approved typography, mascot/runtime assets and the current presentation bundle locked", () => {
    expect(["www/index.html", ...files("www/landing-workroom/v1")].sort()).toEqual(Object.keys(LOCKED).sort());
    for (const [path, expected] of Object.entries(LOCKED)) expect(digest(readFileSync(join(ROOT, path))), path).toBe(expected);
  });
  it("removes the retired outline mark from every public brand while retaining named home links", () => {
    const pages = ["www/index.html", ...DOC_PAGES.map((name) => `www/docs/${name}.html`), ...SUPPORT_PAGES.map((name) => `www/${name}.html`)];
    const retired = /<path\b[^>]*d=["']M4 26V6l12 13L28 6v20["']/;
    for (const path of pages) {
      const html = read(path);
      expect(html, path).not.toMatch(retired);
      expect(html, path).toContain('aria-label="Muster home"');
    }
    for (const route of ["/privacy-policy", "/terms-of-service"]) expect(legalPageFor(route)).not.toMatch(retired);
    expect(read("www/landing-workroom/v1/favicon.svg")).not.toContain("M14 46V18l18 18 18-18v28");
  });
  it("preserves every byte of the privacy and terms document templates outside their shared shell", () => {
    const source = read("server/legal-pages.ts");
    for (const [name, expected] of Object.entries(LEGAL_BODIES)) {
      const body = new RegExp(`function ${name}\\(\\): string \\{\\s*return legalShell\\("[^" ]+(?: [^" ]+)*", \x60([\\s\\S]*?)\x60\\);\\s*\\}`).exec(source)?.[1];
      expect(body, `${name} remains an identifiable unchanged document`).toBeDefined();
      expect(digest(body ?? ""), name).toBe(expected);
    }
  });
  it("keeps legal dates, contact and alias identities while permitting a new presentation shell", () => {
    for (const [canonical, aliases] of [
      ["privacy-policy", ["/privacy-policy", "/PRIVACY-POLICY", "/privacy-policy/"]],
      ["terms-of-service", ["/terms-of-service", "/Terms-of-Service", "/Terms-of-Service/"]],
    ] as const) {
      const page = legalPageFor(aliases[0])!;
      for (const path of aliases) expect(legalPageFor(path)).toBe(page);
      expect(page).toContain(`href="https://muster.today/${canonical}"`);
      expect(page).toContain("Last updated: 12 September 2026");
      expect(page).toContain("mailto:ramagiritharun@gmail.com");
      expect(page).not.toContain('id="root"');
    }
  });
  it("keeps all docs and support documents readable and their runtime dependencies local", () => {
    const pages = [...DOC_PAGES.map((name) => `www/docs/${name}.html`), ...SUPPORT_PAGES.map((name) => `www/${name}.html`)];
    for (const path of pages) {
      const html = read(path).replace(/<!--[\s\S]*?-->/g, "");
      expect(html, path).toMatch(/<html[^>]+lang=["']en["']/);
      expect(html.match(/<h1\b/gi), path).toHaveLength(1);
      expect(html, path).toMatch(/<title>[^<]+<\/title>/);
      expect(html, path).toMatch(/name=["']description["'][^>]+content=["'][^"']+/);
      for (const resource of resourceLinks(html)) {
        expect(resource, `${path} avoids external runtime dependencies`).toMatch(/^\/(?!\/)/);
        expect(resource).not.toMatch(/^\/(?:app\.js|assets\/|api\/)/);
        const asset = resolve(ROOT, "www", `.${resource.split(/[?#]/)[0]}`);
        expect(asset.startsWith(join(ROOT, "www") + "/"), resource).toBe(true);
        expect(() => readFileSync(asset), `${path}: ${resource}`).not.toThrow();
      }
      expect(html, path).not.toContain('/landing-workroom/v1/app.js');
    }
  });
  it("retains every current docs destination and one current-page navigation marker", () => {
    for (const page of DOC_PAGES) {
      const html = read(`www/docs/${page}.html`);
      const current = [...html.matchAll(/<a\b[^>]*aria-current=["']page["'][^>]*>/gi)];
      expect(current, page).toHaveLength(1);
      expect(current[0][0], page).toContain(`href="${page === "index" ? "/docs" : `/docs/${page}`}"`);
      for (const target of DOC_PAGES) expect(html).toContain(`href="${target === "index" ? "/docs" : `/docs/${target}`}"`);
    }
  });
});
