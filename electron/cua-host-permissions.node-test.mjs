// Embedded Cua is spawned by Electron main and inherits Muster's TCC grants.
// The default-socket CuaDriver daemon owns a different identity: its grants
// cannot permit or deny embedded startup. No native permission APIs run here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCuaRuntime, standalonePermissionFailureReason } from "./cua-runtime.mjs";

function harness({ standalone, embedded = true, sdkGranted = true, empirical = null }) {
  const counts = { standaloneReads: 0, prompts: 0, starts: 0 };
  const sdk = {
    requestMacOSPermissions: () => {
      counts.prompts++;
      return { accessibility: sdkGranted, screenRecording: sdkGranted };
    },
    hasRequiredMacOSPermissions: (read) => read.accessibility === true && read.screenRecording === true,
    EmbeddedCuaDriverHost: class {
      async start() { counts.starts++; return { socketPath: "/owned-fixture/embedded.sock" }; }
      async stop() {}
    },
  };
  const runtime = createCuaRuntime({
    connectionStore: { persist() {} },
    resolveDriverBinary: () => "/owned-fixture/cua-driver",
    loadEmbeddedSdk: async () => sdk,
    wantEmbedded: () => embedded,
    standaloneSocket: "/owned-fixture/standalone.sock",
    socketAlive: async () => true,
    platform: "darwin",
    requestDesktopPermissions: empirical === null ? null : async () => empirical,
    standalonePermissionStatus: async () => { counts.standaloneReads++; return standalone; },
  });
  runtime.initialize();
  return { runtime, counts };
}

const deniedStandalone = { bundleId: "com.trycua.driver", accessibility: false, screenRecording: false };
const allowedStandalone = { bundleId: "com.trycua.driver", accessibility: true, screenRecording: true };

describe("standalone permission repair", () => {
  it("names the standalone app, bundle and missing pane", () => {
    const reason = standalonePermissionFailureReason({ ...deniedStandalone, accessibility: true });
    assert.ok(reason.includes("Screen Recording must be granted to CuaDriver (com.trycua.driver)"));
    assert.match(reason, /Privacy & Security/);
    assert.match(reason, /add CuaDriver/);
  });
  it("lists both missing permissions", () => {
    assert.match(standalonePermissionFailureReason(deniedStandalone), /Accessibility and Screen Recording/);
  });
  it("returns no repair when both standalone grants are present", () => {
    assert.equal(standalonePermissionFailureReason(allowedStandalone), null);
  });
});

describe("embedded permission owner", () => {
  it("starts allowed embedded access without reading denied standalone grants", async () => {
    const { runtime, counts } = harness({ standalone: deniedStandalone });
    try {
      assert.equal((await runtime.start()).mode, "embedded");
      assert.deepEqual(counts, { standaloneReads: 0, prompts: 1, starts: 1 });
    } finally { await runtime.stop(); }
  });
  it("cannot use allowed standalone grants to enable denied Muster access", async () => {
    const { runtime, counts } = harness({ standalone: allowedStandalone, sdkGranted: false,
      empirical: { accessibility: false, screenRecording: false } });
    try {
      const connection = await runtime.start();
      assert.equal(connection.mode, "unavailable");
      assert.ok(connection.reason.includes("Accessibility and Screen Recording required for Muster (com.muster.app)"));
      assert.doesNotMatch(connection.reason, /CuaDriver/);
      assert.deepEqual(counts, { standaloneReads: 0, prompts: 2, starts: 0 });
    } finally { await runtime.stop(); }
  });
  it("keeps fresh Muster evidence authoritative despite an unavailable standalone reader", async () => {
    const { runtime, counts } = harness({ standalone: null, sdkGranted: false,
      empirical: { accessibility: true, screenRecording: true } });
    try {
      assert.equal((await runtime.start()).mode, "embedded");
      assert.deepEqual(counts, { standaloneReads: 0, prompts: 2, starts: 1 });
    } finally { await runtime.stop(); }
  });
  it("names CuaDriver only when the selected standalone daemon is denied", async () => {
    const { runtime, counts } = harness({ embedded: false, standalone: { ...deniedStandalone, accessibility: true } });
    try {
      const connection = await runtime.start();
      assert.equal(connection.mode, "unavailable");
      assert.match(connection.reason, /Screen Recording must be granted to CuaDriver/);
      assert.deepEqual(counts, { standaloneReads: 1, prompts: 0, starts: 0 });
    } finally { await runtime.stop(); }
  });
});
