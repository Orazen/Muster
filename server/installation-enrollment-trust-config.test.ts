import { describe, expect, it } from "vitest";

import {
  ENROLLMENT_TRUST_CAPABILITIES,
  ENROLLMENT_TRUST_PLATFORM_FACTS,
  ENROLLMENT_TRUST_REQUIREMENTS,
  ENROLLMENT_CLIENT_REQUIREMENTS,
  IDENTITY_ISSUER_IS_NOT_ENROLLMENT_AUTHORITY,
  enrollmentTrustPlatforms,
  enrollmentTrustRedirectPolicyWire,
  inspectEnrollmentTrustConfiguration,
} from "./installation-enrollment-trust-config.ts";
import {
  canonicalIssuerWire,
  createEnrollmentEngine,
  enrollmentEnabled,
  enrollmentPlatformWire,
  isCanonicalIssuer,
} from "./installation-enrollment-contract.ts";

// The request document, checked against the real schemas. Every case here is a
// bound an owner's answer must satisfy; none of them supplies a value for
// production, and none enables enrollment.

describe("enrollment trust configuration — the request", () => {
  it("an empty candidate reports every question unanswered and nothing complete", () => {
    const report = inspectEnrollmentTrustConfiguration({});
    expect(report.complete).toBe(false);
    expect(report.values.map((value) => value.state)).toEqual([
      "unanswered", "unanswered", "unanswered", "unanswered", "unanswered",
    ]);
    // Every question contributes a blocked consequence, so the report is
    // actionable rather than a bare "false".
    expect(report.blockedBy.length).toBe(report.values.length);
  });

  it("every pending question carries file:line evidence", () => {
    expect(ENROLLMENT_TRUST_REQUIREMENTS.map((requirement) => requirement.question)).toEqual([
      "enrollmentIssuer", "identityClientId", "workspaceId", "cloudAuthority", "macosRedirect",
    ]);
    for (const requirement of ENROLLMENT_TRUST_REQUIREMENTS) {
      expect(requirement.ask.length).toBeGreaterThan(20);
      expect(requirement.evidence.length).toBeGreaterThan(0);
      for (const anchor of requirement.evidence) {
        expect(anchor, requirement.question).toMatch(/\S+\.(ts|plist):\d+/);
      }
    }
  });

  it("the platform list is read from the wire enum, all eight, with macos present", () => {
    expect(enrollmentTrustPlatforms).toEqual([
      "ios", "watchos", "android", "macos", "windows", "linux", "cli", "web",
    ]);
    expect(enrollmentTrustPlatforms).toEqual(enrollmentPlatformWire.options);
  });

  it("the redirect policy requires all eight keys and bounds each at 2048", () => {
    const parsed = enrollmentTrustRedirectPolicyWire.safeParse(
      Object.fromEntries(enrollmentTrustPlatforms.map((platform) => [platform, "https://x.invalid/cb"])),
    );
    expect(parsed.success).toBe(true);
    // A missing platform is refused: an absent key is not an empty redirect.
    const missing = enrollmentTrustRedirectPolicyWire.safeParse({ macos: "https://x.invalid/cb" });
    expect(missing.success).toBe(false);
    // An over-long redirect is refused.
    const long = enrollmentTrustRedirectPolicyWire.safeParse(
      Object.fromEntries(enrollmentTrustPlatforms.map((platform) => [platform, "x".repeat(2049)])),
    );
    expect(long.success).toBe(false);
  });

  describe("enrollment issuer bounds", () => {
    it("accepts a canonical HTTPS origin", () => {
      const report = inspectEnrollmentTrustConfiguration({ enrollmentIssuer: "https://enroll.example.invalid" });
      expect(report.values[0]).toEqual({ question: "enrollmentIssuer", state: "answered", reason: null });
    });

    it("refuses every non-canonical spelling and names the rule", () => {
      const refused = [
        "http://enroll.example.invalid",       // not https
        "https://Enroll.example.invalid",      // uppercase host
        "https://enroll.example.invalid/",     // trailing slash is not the origin
        "https://enroll.example.invalid/path", // non-empty path
        "https://enroll.example.invalid?q=1",  // query
        "https://enroll.example.invalid#frag", // fragment
        "https://user@enroll.example.invalid", // userinfo
        "https://enroll.example.invalid:443",  // default port spelled out
        "",                                    // empty
      ];
      for (const issuer of refused) {
        const report = inspectEnrollmentTrustConfiguration({ enrollmentIssuer: issuer });
        expect(report.values[0].state, issuer).toBe("refused");
        expect(report.values[0].reason).toContain("canonical HTTPS origin");
      }
    });

    it("refuses an issuer longer than the identity adapter's narrower 128 cap", () => {
      // The contract allows 256; the identity adapter allows 128. The stricter
      // cap is what a deployment must satisfy, and this proves it.
      const long = `https://${"a".repeat(130)}.invalid`;
      expect(canonicalIssuerWire.safeParse(long).success).toBe(true);
      const report = inspectEnrollmentTrustConfiguration({ enrollmentIssuer: long });
      expect(report.values[0].state).toBe("refused");
    });

    it("refuses a 128+ character issuer even though the contract alone would accept it", () => {
      // Documents the mismatch explicitly: passing the contract's own check is
      // not sufficient for the identity adapter's configuration.
      expect(isCanonicalIssuer(`https://${"a".repeat(120)}.invalid`)).toBe(true);
      expect(canonicalIssuerWire.safeParse(`https://${"a".repeat(120)}.invalid`).success).toBe(true);
      const report = inspectEnrollmentTrustConfiguration({
        enrollmentIssuer: `https://${"a".repeat(120)}.invalid`,
      });
      expect(report.values[0].state).toBe("refused");
    });

    it("keeps the identity issuer explicitly distinct from the enrollment authority", () => {
      expect(IDENTITY_ISSUER_IS_NOT_ENROLLMENT_AUTHORITY).toContain("not Muster's enrollment authority");
      // Google's identity issuer is a perfectly canonical origin, so the schema
      // CANNOT keep it out of the issuer slot — which is exactly why this is an
      // owner decision and not a validation rule.
      expect(canonicalIssuerWire.safeParse("https://accounts.google.com").success).toBe(true);
      const report = inspectEnrollmentTrustConfiguration({ enrollmentIssuer: "https://accounts.google.com" });
      expect(report.values[0].state).toBe("answered");
    });
  });

  describe("identity audience bounds", () => {
    it("accepts a bounded audience and refuses an empty or over-long one", () => {
      const accepted = inspectEnrollmentTrustConfiguration({ identityClientId: "1234-abc.apps.example.invalid" });
      expect(accepted.values[1].state).toBe("answered");
      expect(inspectEnrollmentTrustConfiguration({ identityClientId: "" }).values[1].state).toBe("refused");
      const long = "a".repeat(513);
      expect(inspectEnrollmentTrustConfiguration({ identityClientId: long }).values[1].state).toBe("refused");
    });
  });

  describe("identity audience canonical spacing", () => {
    it("uses the real audience schema even without an issuer answer", () => {
      for (const audience of [" ", "\t\n", " audience.example.invalid", "audience.example.invalid "]) {
        const report = inspectEnrollmentTrustConfiguration({ identityClientId: audience });
        expect(report.values[1].state).toBe("refused");
        expect(report.complete).toBe(false);
        expect(report.blockedBy.some((reason) => reason.includes("not-configured"))).toBe(true);
      }
    });

    it("refuses a whitespace audience in an otherwise complete candidate", () => {
      const report = inspectEnrollmentTrustConfiguration({
        enrollmentIssuer: "https://enroll.example.invalid", identityClientId: " ",
        workspaceId: "workspace-1", cloudAuthority: "https://enroll.example.invalid",
        macosRedirect: "https://enroll.example.invalid/macos/callback",
      });
      expect(report.complete).toBe(false);
      expect(report.values[1].state).toBe("refused");
      expect(report.blockedBy.length).toBeGreaterThan(0);
    });
  });

  describe("workspace and authority bounds", () => {
    it("refuses an over-long workspace id (max 128) and an over-long authority (max 128)", () => {
      expect(inspectEnrollmentTrustConfiguration({ workspaceId: "w".repeat(129) }).values[2].state).toBe("refused");
      expect(inspectEnrollmentTrustConfiguration({ workspaceId: "" }).values[2].state).toBe("refused");
      expect(inspectEnrollmentTrustConfiguration({ cloudAuthority: "a".repeat(129) }).values[3].state).toBe("refused");
      expect(inspectEnrollmentTrustConfiguration({ cloudAuthority: "" }).values[3].state).toBe("refused");
    });

    it("an authority longer than 128 is refused even though it may be a valid URL", () => {
      // A canonical origin is 14 characters; the authority cap is tighter than a
      // URL budget, so a long origin does not fit and must be refused.
      const authority = `https://${"a".repeat(130)}.invalid`;
      expect(canonicalIssuerWire.safeParse(authority).success).toBe(true);
      expect(inspectEnrollmentTrustConfiguration({ cloudAuthority: authority }).values[3].state).toBe("refused");
    });
  });

  describe("cross-field consistency", () => {
    it("reports the report incomplete while any question is unanswered", () => {
      const report = inspectEnrollmentTrustConfiguration({
        enrollmentIssuer: "https://enroll.example.invalid",
        identityClientId: "audience.example.invalid",
        workspaceId: "workspace-1",
        cloudAuthority: "https://enroll.example.invalid",
        // macosRedirect deliberately absent
      });
      expect(report.complete).toBe(false);
      const redirect = report.values[4];
      expect(redirect.question).toBe("macosRedirect");
      expect(redirect.state).toBe("unanswered");
      expect(report.blockedBy.some((entry) => entry.includes("macOS enrollment is refused as `redirect`"))).toBe(true);
    });

    it("a complete candidate reports complete and empty blockedBy", () => {
      const report = inspectEnrollmentTrustConfiguration({
        enrollmentIssuer: "https://enroll.example.invalid",
        identityClientId: "audience.example.invalid",
        workspaceId: "workspace-1",
        cloudAuthority: "https://enroll.example.invalid",
        macosRedirect: "https://enroll.example.invalid/macos/callback",
      });
      expect(report.complete).toBe(true);
      expect(report.blockedBy).toEqual([]);
    });

    it("refuses an individually valid authority that differs from the issuer", () => {
      const report = inspectEnrollmentTrustConfiguration({
        enrollmentIssuer: "https://enroll.example.invalid",
        identityClientId: "audience.example.invalid",
        workspaceId: "workspace-1",
        cloudAuthority: "https://foreign.example.invalid",
        macosRedirect: "https://enroll.example.invalid/macos/callback",
      });
      expect(report.complete).toBe(false);
      expect(report.values[3]).toEqual({ question: "cloudAuthority", state: "refused",
        reason: "The cloud authority must equal the trusted enrollment issuer." });
      expect(report.blockedBy.some((reason) => reason.includes("refused as `authority`"))).toBe(true);
      expect(JSON.stringify(report)).not.toContain("foreign.example.invalid");
      expect(JSON.stringify(report)).not.toContain("enroll.example.invalid");
    });

    it("reports authority mismatch before the other trust answers are available", () => {
      const report = inspectEnrollmentTrustConfiguration({
        enrollmentIssuer: "https://enroll.example.invalid", cloudAuthority: "other-authority",
      });
      expect(report.complete).toBe(false);
      expect(report.values[3].state).toBe("refused");
      expect(report.values[1].state).toBe("unanswered");
    });

    it("never echoes a supplied value back in a refusal reason", () => {
      const secretish = "https://enroll.example.invalid/very-distinctive-path-segment";
      const report = inspectEnrollmentTrustConfiguration({ cloudAuthority: "x".repeat(129) });
      const authority = report.values[3];
      expect(authority.reason).not.toContain(secretish);
      expect(authority.reason).not.toContain("x".repeat(20));
    });
  });

  describe("client request requirements", () => {
    it("states a bound and an evidence anchor for every documented field", () => {
      for (const requirement of ENROLLMENT_CLIENT_REQUIREMENTS) {
        expect(requirement.bound.length).toBeGreaterThan(10);
        expect(requirement.evidence).toMatch(/installation-enrollment-contract\.ts:\d+/);
      }
      const fields = ENROLLMENT_CLIENT_REQUIREMENTS.map((requirement) => requirement.field);
      expect(fields).toContain("clientKey");
      expect(fields).toContain("deviceConfirmed");
      expect(fields).toContain("redirect");
      expect(fields).toContain("credentialExpiresAt");
    });

    it("names only the capability scope that actually exists", () => {
      expect(ENROLLMENT_TRUST_CAPABILITIES).toEqual(["workspace"]);
    });
  });

  describe("platform facts", () => {
    it("records that macOS registers no callback scheme and iOS does", () => {
      expect(ENROLLMENT_TRUST_PLATFORM_FACTS.macos.registersCallbackScheme).toBe(false);
      expect(ENROLLMENT_TRUST_PLATFORM_FACTS.ios.registersCallbackScheme).toBe(true);
      expect(ENROLLMENT_TRUST_PLATFORM_FACTS.macos.evidence).toContain("Info.plist");
      expect(ENROLLMENT_TRUST_PLATFORM_FACTS.ios.evidence).toContain("muster://");
    });
  });

  describe("nothing here enables enrollment", () => {
    it("enrollment stays inert and the module constructs no engine", () => {
      expect(enrollmentEnabled).toBe(false);
      // The trust request exports no engine and no enabled policy: it is a
      // report, and the flag remains the single gate.
      const report = inspectEnrollmentTrustConfiguration({
        enrollmentIssuer: "https://enroll.example.invalid",
        identityClientId: "audience.example.invalid",
        workspaceId: "workspace-1",
        cloudAuthority: "https://enroll.example.invalid",
        macosRedirect: "https://enroll.example.invalid/macos/callback",
      });
      expect(report.complete).toBe(true);
      expect(enrollmentEnabled).toBe(false);
    });

    it("an enabled engine still refuses to construct without a canonical issuer", () => {
      // The request document does not relax this: an enabled engine with a
      // non-canonical issuer still throws at construction.
      expect(() => createEnrollmentEngine({
        enabled: true,
        trusted: {
          issuer: "not-a-url",
          approvedRedirects: {
            macos: "", ios: "", watchos: "", android: "",
            windows: "", linux: "", cli: "", web: "",
          },
        },
      })).toThrow("canonical HTTPS origin");
    });
  });
});
