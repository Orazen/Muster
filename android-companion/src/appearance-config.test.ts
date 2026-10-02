import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { getPrebuildConfigAsync } from "@expo/prebuild-config";
import { compileModsAsync } from "expo/config-plugins";

describe("Android appearance configuration", () => {
  it("generates system-following appearance through the installed native plugin", async () => {
    const projectRoot = path.resolve(__dirname, "..");
    const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ["android"] });
    // Introspection evaluates native configuration in memory. It does not
    // generate android/, compile a binary, or establish device behavior.
    const config = await compileModsAsync(exp, {
      projectRoot,
      platforms: ["android"],
      introspect: true,
      assertMissingModProviders: false,
    });
    const strings = config._internal?.modResults?.android?.strings as {
      resources: { string: Array<{ $: { name: string }; _: string }> };
    };
    expect(strings.resources.string.find(item => item.$.name === "expo_system_ui_user_interface_style"))
      .toEqual(expect.objectContaining({ _: "automatic" }));
    expect(config._internal?.pluginHistory?.["expo-system-ui"]?.version).not.toBe("UNVERSIONED");
    expect(config._internal?.pluginHistory?.["expo-system-ui"]?.version).toBeDefined();
  });
});
