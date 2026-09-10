import { describe, expect, it } from "vitest";
import { authDestination, authGateReturnPath } from "./auth-navigation";

describe("auth return destinations", () => {
  it("returns desktop root sign-in to the workspace instead of public marketing", () => {
    expect(authGateReturnPath({ pathname: "/", search: "", hash: "" })).toBe("/app");
  });
  it("retains a protected OS destination, template and fragment", () => {
    expect(authGateReturnPath({ pathname: "/os", search: "?template=research", hash: "#work" })).toBe("/os?template=research#work");
  });
  it("retains root query intent while targeting the app", () => {
    expect(authGateReturnPath({ pathname: "/", search: "?bot=fixture", hash: "#reply" })).toBe("/app?bot=fixture#reply");
  });
  it.each([null, "", "app", "https://example.org/app", "javascript:alert(1)"])(
    "falls back to the app for a nonlocal destination: %s", (value) => {
      expect(authDestination(value)).toBe("/app");
    },
  );

  it.each(["//example.org/app", "///example.org/app", "/\\example.org/app", "\\example.org/app", "/a/..//example.org/app", "/a/%2e%2e//example.org/app"])(
    "rejects browser-normalized external destinations: %s", (value) => {
      expect(authDestination(value)).toBe("/app");
    },
  );

  it.each(["/", "/app", "/app?view=approvals#latest", "/pair?return=%2Fapp&mode=desktop"])(
    "preserves a local pathname, query, and fragment: %s", (value) => {
      expect(authDestination(value)).toBe(value);
    },
  );
});
