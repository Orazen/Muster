// The share extension stages input in the app's shared container. A build
// without the grant still compiles, but containerURL returns nil on device.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const groupKey = "com.apple.security.application-groups";
const targetSchema = z.object({
  entitlements: z.object({
    path: z.string(),
    properties: z.object({ [groupKey]: z.array(z.string()) }),
  }),
  settings: z.object({ base: z.object({
    PRODUCT_BUNDLE_IDENTIFIER: z.string(), DEVELOPMENT_TEAM: z.string(), CODE_SIGN_STYLE: z.string(),
  }) }),
});

describe("iOS share-extension container authorization", () => {
  it("the generator grants the embedded share target the same container its writer and app use", () => {
    const spec = z.object({ targets: z.object({
      MusterCompanion: targetSchema.extend({ dependencies: z.array(z.object({ target: z.string().optional(), embed: z.boolean().optional() })) }),
      MusterShareExtension: targetSchema,
    }) }).parse(parse(read("ios/project.yml")));
    const app = spec.targets.MusterCompanion;
    const share = spec.targets.MusterShareExtension;
    const group = /public static let appGroupId = "([^"]+)"/.exec(read("ios/Sources/CompanionCore/FleetSnapshot.swift"))?.[1];
    expect(group, "CompanionCore must declare the shared container").toBeTruthy();
    expect(share.entitlements.properties[groupKey]).toEqual([group]);
    expect(app.entitlements.properties[groupKey]).toContain(group);
    expect(app.dependencies).toContainEqual({ target: "MusterShareExtension", embed: true });
    expect(share.settings.base.DEVELOPMENT_TEAM).toBe(app.settings.base.DEVELOPMENT_TEAM);
    expect(share.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe(`${app.settings.base.PRODUCT_BUNDLE_IDENTIFIER}.share`);
    expect(share.settings.base.CODE_SIGN_STYLE).toBe("Automatic");
  });

  it("the checked-in entitlement retains the generator's narrowly scoped group grant", () => {
    const spec = z.object({ targets: z.object({ MusterShareExtension: targetSchema }) }).parse(parse(read("ios/project.yml")));
    const grant = spec.targets.MusterShareExtension.entitlements;
    expect(grant.path).toBe("ShareExtension/ShareExtension.entitlements");
    const plist = read(`ios/${grant.path}`);
    const array = /<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
    expect(array, "Share target must carry an app-group entitlement before signing").toBeDefined();
    const groups = [...(array ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
    expect(groups).toEqual(grant.properties[groupKey]);
  });
});
