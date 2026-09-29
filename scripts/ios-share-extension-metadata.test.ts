import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const validator = join(root, "scripts/ios-share-extension-metadata.py");
const fixtureDirectories: string[] = [];
const extensionSchema = z.object({
  NSExtensionPointIdentifier: z.string().optional(),
  NSExtensionPrincipalClass: z.string().optional(),
  NSExtensionMainStoryboard: z.string().optional(),
  NSExtensionAttributes: z.object({
    NSExtensionActivationRule: z.union([z.string(), z.record(z.string(), z.union([z.boolean(), z.number()]))]).optional(),
  }).strict().optional(),
}).strict();
type ShareMetadataFixture = {
  NSExtension?: z.infer<typeof extensionSchema>;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string;
};
const validExtension = {
  NSExtensionPointIdentifier: "com.apple.share-services",
  NSExtensionPrincipalClass: "MusterShareExtension.ShareViewController",
  NSExtensionAttributes: { NSExtensionActivationRule: {
    NSExtensionActivationSupportsText: true,
    NSExtensionActivationSupportsWebURLWithMaxCount: 1,
  } },
};

// Serialize binary plists with the platform-independent standard library;
// the validator must inspect real packaged data, not a source string match.
function writePlist(info: ShareMetadataFixture) {
  const directory = mkdtempSync(join(tmpdir(), "muster-share-info-"));
  fixtureDirectories.push(directory);
  const serialized = spawnSync("python3", ["-c", "import json,plistlib,sys; sys.stdout.buffer.write(plistlib.dumps(json.load(sys.stdin),fmt=plistlib.FMT_BINARY))"], {
    input: JSON.stringify({ CFBundleShortVersionString: "1.0.0", CFBundleVersion: "9", ...info }),
  });
  expect(serialized.error).toBeUndefined();
  expect(serialized.status, serialized.stderr.toString()).toBe(0);
  const path = join(directory, "Info.plist");
  writeFileSync(path, serialized.stdout);
  return path;
}
const check = (path: string, source = false, containingApp?: string) => spawnSync("python3", [validator, path,
  ...(source ? ["--source"] : []), ...(containingApp ? ["--containing-app", containingApp] : [])], { encoding: "utf8" });
afterEach(() => { for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("Share extension submission metadata", () => {
  it("registers the compiled ShareViewController and bounded handler inputs", () => {
    const result = check(writePlist({ NSExtension: validExtension }));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: true, kind: "packaged" });
    expect(readFileSync(join(root, "ios/ShareExtension/ShareViewController.swift"), "utf8"))
      .toMatch(/final class ShareViewController: UIViewController/);
  });

  it("keeps registration in the generator, which rewrites the source plist", () => {
    const properties = z.object({ targets: z.object({ MusterShareExtension: z.object({ info: z.object({
      properties: z.object({ NSExtension: extensionSchema,
        CFBundleShortVersionString: z.string(), CFBundleVersion: z.string() }),
    }) }) }) }).parse(parse(readFileSync(join(root, "ios/project.yml"), "utf8"))).targets.MusterShareExtension.info.properties;
    const result = check(writePlist(properties), true);
    expect(result.status, result.stderr).toBe(0);
    expect(check(join(root, "ios/ShareExtension/Info.plist"), true).status).toBe(0);
  });

  it("matches the actual containing app versions before submission", () => {
    const parent = writePlist({});
    const result = check(writePlist({ NSExtension: validExtension }), false, parent);
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["CFBundleShortVersionString", "CFBundleVersion"] as const)("rejects packaged %s mismatch", key => {
    const parent = writePlist({});
    const result = check(writePlist({ NSExtension: validExtension, [key]: "1" }), false, parent);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${key} must match the containing app`);
  });

  const invalid = [
    { name: "absent dictionary (build 660 rejection)", info: {} },
    { name: "absent extension point", info: { NSExtension: { ...validExtension, NSExtensionPointIdentifier: undefined } } },
    { name: "wrong extension point", info: { NSExtension: { ...validExtension, NSExtensionPointIdentifier: "com.apple.widgetkit-extension" } } },
    { name: "absent principal class", info: { NSExtension: { ...validExtension, NSExtensionPrincipalClass: undefined } } },
    { name: "unexpanded compiled module", info: { NSExtension: { ...validExtension, NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).ShareViewController" } } },
    { name: "conflicting storyboard", info: { NSExtension: { ...validExtension, NSExtensionMainStoryboard: "Main" } } },
    { name: "unbounded predicate", info: { NSExtension: { ...validExtension, NSExtensionAttributes: { NSExtensionActivationRule: "TRUEPREDICATE" } } } },
    { name: "unsupported images", info: { NSExtension: { ...validExtension, NSExtensionAttributes: { NSExtensionActivationRule: { ...validExtension.NSExtensionAttributes.NSExtensionActivationRule, NSExtensionActivationSupportsImageWithMaxCount: 1 } } } } },
    { name: "boolean URL limit", info: { NSExtension: { ...validExtension, NSExtensionAttributes: { NSExtensionActivationRule: { NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: true } } } } },
    { name: "expanded URL limit", info: { NSExtension: { ...validExtension, NSExtensionAttributes: { NSExtensionActivationRule: { NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: 2 } } } } },
  ];
  it.each(invalid)("rejects $name before submission", ({ info }) => {
    const result = check(writePlist(info));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Share extension metadata rejected:");
  });
});
