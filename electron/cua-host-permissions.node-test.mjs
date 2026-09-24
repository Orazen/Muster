// Loop201: the embedded host's failure message must name the app macOS
// actually keys the grant to.
//
// The bug this pins, with the evidence that produced it: the CuaDriver
// daemon runs as its own signed app (com.trycua.driver, TeamID YCK386LBJ7)
// and was refusing to serve with
// `--cua-internal-gate-missing-screen-recording`, while Muster
// (com.muster.app, TeamID 7375K23WFU) was reported as granted. A person
// granting Muster changed nothing for the driver, and the old message —
// "Accessibility and Screen Recording required" — never said which app had
// to be added in System Settings. Now the host's own status is read first,
// and the refusal names the app, the id, and the pane.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCuaRuntime, hostPermissionFailureReason } from "./cua-runtime.mjs";

/** The minimum the runtime needs; the permission path is what is under test. */
function harness({ host, sdkGranted = true, empirical = null }) {
  const store = { value: { mode: "unavailable", reason: "computer-access-off" }, persist(next) { this.value = next; } };
  const sdk = {
    requestMacOSPermissions: () => ({ accessibility: sdkGranted, screenRecording: sdkGranted }),
    hasRequiredMacOSPermissions: (read) => read.accessibility === true && read.screenRecording === true,
    EmbeddedCuaDriverHost: class {
      constructor() {}
      async start() { throw new Error("must not start without permissions"); }
      async stop() {}
    },
  };
  return createCuaRuntime({
    connectionStore: store,
    resolveDriverBinary: () => "/tmp/cua-driver",
    loadEmbeddedSdk: async () => sdk,
    wantEmbedded: () => true,
    standaloneSocket: "/tmp/socket",
    socketAlive: async () => false,
    platform: "darwin",
    requestDesktopPermissions: empirical === null ? null : async () => empirical,
    hostPermissionStatus: host === undefined ? null : async () => host,
  });
}

describe("hostPermissionFailureReason", () => {
  it("names the app, its bundle id and the pane when the host is missing a grant", () => {
    const reason = hostPermissionFailureReason({ bundleId: "com.trycua.driver", accessibility: true, screenRecording: false });
    assert.ok(reason !== null);
    assert.match(reason, /Screen Recording/);
    assert.match(reason, /CuaDriver/);
    assert.match(reason, /com\.trycua\.driver/);
    assert.match(reason, /add CuaDriver/);
  });

  it("lists both permissions when the host has neither", () => {
    const reason = hostPermissionFailureReason({ bundleId: "com.trycua.driver", accessibility: false, screenRecording: false });
    assert.match(reason ?? "", /Accessibility and Screen Recording/);
  });

  it("returns null when the host has both, so the normal path continues", () => {
    assert.equal(
      hostPermissionFailureReason({ bundleId: "com.trycua.driver", accessibility: true, screenRecording: true }),
      null,
    );
  });
});

describe("embedded host start", () => {
  it("fails with the named-app message when the host is denied, even though this process reads granted", async () => {
    const runtime = harness({
      host: { bundleId: "com.trycua.driver", accessibility: true, screenRecording: false },
      sdkGranted: true,
      empirical: { accessibility: true, screenRecording: true },
    });
    runtime.initialize();
    const connection = await runtime.start();
    assert.match(connection.reason, /embedded host failed/);
    assert.match(connection.reason, /com\.trycua\.driver/);
    assert.match(connection.reason, /Privacy & Security/);
  });

  it("keeps the legacy message when no host read is available", async () => {
    const runtime = harness({ host: undefined, sdkGranted: false, empirical: { accessibility: false, screenRecording: false } });
    runtime.initialize();
    const connection = await runtime.start();
    assert.match(connection.reason, /embedded host failed/);
    assert.match(connection.reason, /Accessibility and Screen Recording required/);
  });
});
