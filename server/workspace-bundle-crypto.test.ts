// v1 workspace-bundle crypto decode: the auth-tag length gate.
//
// encryptBundle always seals with a full 16-byte GCM auth tag. Shorter tags
// are still legal GCM lengths — Node's createDecipheriv would happily MAC
// with a 15-byte tag — so the decode path rejects any tag whose byteLength
// is not exactly 16 before it ever reaches setAuthTag, failing with the
// standard wrong-passphrase error. These tests prove a hand-built envelope
// carrying a truncated tag cannot even reach MAC verification, while the
// untouched encrypt/decrypt round-trip still works (i.e. the gate never
// rejects data our own writer produced).
import { describe, expect, it } from "vitest";

import type { BundleWorkspace } from "./workspace-bundle.ts";

const { decryptBundle, encryptBundle } = await import("./workspace-bundle.ts");

const workspace: BundleWorkspace = {
  bots: [{ id: "bot-a", name: "A" }],
  groups: [],
  memory: {},
  topics: {},
  exportedAt: Date.UTC(2026, 9, 1, 9, 0, 0),
  counts: { bots: 1, groups: 0, memoryFiles: 0 },
};

const PASSPHRASE = "fixture-passphrase";
const SECRET = "test-secret-at-least-32-chars-long-ok";

const reassemble = (payload: string, mutate: (parts: string[]) => string[]): string => {
  const parts = payload.split(":");
  return mutate(parts).join(":");
};

describe("v1 decryptBundle auth-tag policy", () => {
  it("round-trips a bundle our own encrypt wrote", () => {
    const { payload } = encryptBundle(workspace, PASSPHRASE, SECRET);
    const { workspace: restored, counts } = decryptBundle(payload, PASSPHRASE, SECRET);
    expect(counts.bots).toBe(1);
    expect(restored.counts.bots).toBe(1);
  });

  it("rejects a truncated auth tag as wrong-passphrase, never reaching MAC", () => {
    const { payload } = encryptBundle(workspace, PASSPHRASE, SECRET);
    // 15-byte tag: a legal GCM length Node would MAC with if we passed it
    // through — the policy gate must refuse it structurally instead.
    const truncated = reassemble(payload, (parts) => {
      parts[4] = Buffer.from(parts[4]!, "base64").subarray(0, 15).toString("base64");
      return parts;
    });
    expect(() => decryptBundle(truncated, PASSPHRASE, SECRET)).toThrow(/wrong passphrase/);
  });

  it("rejects a truncated auth tag even with the correct passphrase", () => {
    const { payload } = encryptBundle(workspace, PASSPHRASE, SECRET);
    const truncated = reassemble(payload, (parts) => {
      parts[4] = Buffer.from(parts[4]!, "base64").subarray(0, 8).toString("base64");
      return parts;
    });
    expect(() => decryptBundle(truncated, PASSPHRASE, SECRET)).toThrow(/wrong passphrase/);
  });
});
