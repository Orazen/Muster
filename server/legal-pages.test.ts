import { afterEach, describe, expect, it, vi } from "vitest";

import { legalPageFor, withVerificationMeta } from "./legal-pages.ts";

const LIMITED_USE =
  "Muster's use and transfer to any other app of information received from Google APIs will adhere to the";
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legalPageFor", () => {
  it("serves a real privacy policy with the Google user-data disclosure", () => {
    const page = legalPageFor("/privacy-policy")!;
    expect(page).toContain("<!doctype html>");
    expect(page).toContain("Privacy policy");
    expect(page).toContain("support@muster.today");
    expect(page).toContain("Google API Services User Data Policy");
    // source wraps lines; compare on whitespace-normalized text
    expect(page.replace(/\s+/g, " ")).toContain(LIMITED_USE);
    // reviewers look for what is collected and how it is used
    expect(page).toContain("Information we collect");
    expect(page).toContain("How we use information");
    expect(page).toContain("Retention and deletion");
  });

  it("serves terms of service", () => {
    const page = legalPageFor("/terms-of-service")!;
    expect(page).toContain("<!doctype html>");
    expect(page).toContain("Terms of service");
    expect(page).toContain("Limitation of liability");
  });

  it("matches the consent form's capitalized /Terms-of-Service path", () => {
    expect(legalPageFor("/Terms-of-Service")).toBe(legalPageFor("/terms-of-service"));
    expect(legalPageFor("/PRIVACY-POLICY")).toBeTruthy();
  });

  it("returns undefined for any other path", () => {
    expect(legalPageFor("/")).toBeUndefined();
    expect(legalPageFor("/privacy")).toBeUndefined();
  });
});

describe("withVerificationMeta", () => {
  const page = "<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head><body></body></html>";

  it("injects the token right after <head> when GOOGLE_SITE_VERIFICATION is set", () => {
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", "abc123XYZ_-token");
    const out = withVerificationMeta(page);
    expect(out).toContain('<meta name="google-site-verification" content="abc123XYZ_-token" />');
    expect(out.indexOf("google-site-verification")).toBeGreaterThan(0);
    expect(out.indexOf("google-site-verification")).toBeLessThan(out.indexOf("<title>"));
  });

  it("falls back to GSC_VERIFICATION_TOKEN", () => {
    vi.stubEnv("GSC_VERIFICATION_TOKEN", "fallback-token");
    expect(withVerificationMeta(page)).toContain('content="fallback-token"');
  });

  it("strips characters that could break out of the attribute", () => {
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", 'toke"n<script>alert(1)</script>');
    const out = withVerificationMeta(page);
    expect(out).not.toContain("<script>");
    expect(out).toContain('content="tokenscriptalert1script"');
  });

  it("leaves the page untouched without any token", () => {
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", "");
    expect(withVerificationMeta(page)).toBe(page);
  });

  it("does not double-inject when the page already carries the tag", () => {
    vi.stubEnv("GOOGLE_SITE_VERIFICATION", "tok");
    const tagged = page.replace("<head>", '<head><meta name="google-site-verification" content="old" />');
    expect(withVerificationMeta(tagged)).toBe(tagged);
  });
});
