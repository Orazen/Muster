import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { legalPageFor, withVerificationMeta } from "./legal-pages.ts";

beforeEach(() => {
  vi.stubEnv("GOOGLE_SITE_VERIFICATION", undefined);
  vi.stubEnv("GSC_VERIFICATION_TOKEN", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("legalPageFor", () => {
  it("serves readable privacy content and the full Limited Use disclosure", () => {
    const page = legalPageFor("/privacy-policy")!;
    const text = page.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
    expect(page).toContain("<!doctype html>");
    expect(page).toContain("mailto:ramagiritharun@gmail.com");
    expect(text).toContain("Muster's use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements.");
    for (const section of ["Information we collect", "How we use information", "Retention and deletion", "Your rights and choices"]) {
      expect(page).toContain(section);
    }
  });

  it("describes current limitations without unsupported guarantees", () => {
    const page = legalPageFor("/privacy-policy")!;
    expect(page).toContain("Self-service account deletion is not currently available");
    expect(page).toContain("not uniformly hashed or encrypted");
    expect(page).toContain("does not automatically erase credentials");
    expect(page).toContain("Separately configured integrations");
    expect(page).not.toContain("deleted within 30 days");
    expect(page).not.toContain("support@muster.today");
    expect(page).not.toContain("on-device engines never");
  });

  it("serves terms with privacy and contact links", () => {
    const page = legalPageFor("/terms-of-service")!;
    expect(page).toContain("Terms of service");
    expect(page).toContain('href="/privacy-policy"');
    expect(page).toContain("mandatory consumer");
  });

  it("matches capitalized consent-form paths", () => {
    expect(legalPageFor("/Terms-of-Service")).toBe(legalPageFor("/terms-of-service"));
    expect(legalPageFor("/PRIVACY-POLICY")).toBeTruthy();
  });

  it("leaves unrelated paths to other handlers", () => {
    expect(legalPageFor("/")).toBeUndefined();
    expect(legalPageFor("/privacy")).toBeUndefined();
  });

  it("links both legal pages from the public homepage", () => {
    const home = readFileSync(new URL("../www/index.html", import.meta.url), "utf8");
    expect(home).toContain('href="/privacy-policy"');
    expect(home).toContain('href="/Terms-of-Service"');
  });
});

describe("withVerificationMeta", () => {
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body></body></html>';

  it("injects a valid token inside the head", () => {
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", "abc123XYZ_-token");
    const out = withVerificationMeta(page);
    expect(out).toContain('<meta name="google-site-verification" content="abc123XYZ_-token" />');
    expect(out.indexOf("google-site-verification")).toBeLessThan(out.indexOf("<title>"));
  });

  it("uses the fallback only when the primary variable is absent", () => {
    vi.stubEnv("GSC_VERIFICATION_TOKEN", "fallback-token");
    expect(withVerificationMeta(page)).toContain('content="fallback-token"');
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", "primary-token");
    expect(withVerificationMeta(page)).toContain('content="primary-token"');
  });

  it("rejects malformed tokens instead of silently changing them", () => {
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", 'toke"n<script>alert(1)</script>');
    expect(withVerificationMeta(page)).toBe(page);
  });

  it("leaves HTML unchanged without a token", () => {
    expect(withVerificationMeta(page)).toBe(page);
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", "");
    expect(withVerificationMeta(page)).toBe(page);
  });

  it("does not double-inject or add a tag without a head", () => {
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", "tok");
    const tagged = page.replace("<head>", '<head><meta name="google-site-verification" content="old" />');
    expect(withVerificationMeta(tagged)).toBe(tagged);
    expect(withVerificationMeta("<body>text</body>")).toBe("<body>text</body>");
  });
});
