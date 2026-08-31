// Form-text helpers behind the MCP Servers section: arg/env textarea parsing
// and the redacted-env wire conversion. Pure functions, tested directly.
import { describe, expect, it } from "vitest";

import { buildWireEnv, parseArgLines, parseEnvLines } from "./McpServersSection";

describe("parseArgLines", () => {
  it("reads one arg per line, keeping spaces inside an argument", () => {
    expect(parseArgLines("  -y\n@scope/pkg --root /my dir\n")).toEqual(["-y", "@scope/pkg --root /my dir"]);
  });

  it("drops blank lines entirely", () => {
    expect(parseArgLines("\n\n")).toEqual([]);
  });
});

describe("parseEnvLines", () => {
  it("keeps everything after the first = as the value", () => {
    expect(parseEnvLines("API_TOKEN=abc=123\nREGION=eu")).toEqual({ API_TOKEN: "abc=123", REGION: "eu" });
  });

  it("ignores lines that name no variable rather than saving them empty", () => {
    expect(parseEnvLines("just some text\n=novalue\n\nOK=1\nBAD KEY=2")).toEqual({ OK: "1" });
  });
});

describe("buildWireEnv", () => {
  it("sends true for a redacted key left untouched, and real strings otherwise", () => {
    const wire = buildWireEnv({ TOKEN: "true", REGION: "", NEW: "v" }, new Set(["TOKEN", "REGION"]));
    expect(wire).toEqual({ TOKEN: true, REGION: true, NEW: "v" });
  });

  it("lets the user overwrite a redacted key by typing a fresh value", () => {
    expect(buildWireEnv({ TOKEN: "new-secret" }, new Set(["TOKEN"]))).toEqual({ TOKEN: "new-secret" });
  });
});
