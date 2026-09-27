import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { UsageAllowance } from "./usage-allowance.ts";

const dirs: string[] = [];
const now = () => Date.UTC(2026, 8, 28);
const cap = { monthlyUsd: 1 };

function file() {
  const dir = mkdtempSync(join(tmpdir(), "muster-allowance-persistence-"));
  dirs.push(dir);
  return join(dir, "allowance.json");
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("usage allowance persistence", () => {
  it("keeps reported spend after reconstruction", () => {
    const path = file();
    const ledger = new UsageAllowance(cap, now, path);
    expect(ledger.reserve("account-a", 1).ok).toBe(true);
    ledger.reconcile("account-a", 1, 1);
    const recovered = new UsageAllowance(cap, now, path);
    expect(recovered.state("account-a").used).toBe(1);
    expect(recovered.reserve("account-a", 1).reason).toBe("cap-reached");
  });

  it("keeps unreported settled spend as unknown after reconstruction", () => {
    const path = file();
    const ledger = new UsageAllowance(cap, now, path);
    ledger.reserve("account-a", 1);
    ledger.reconcile("account-a", null, 1);
    const recovered = new UsageAllowance(cap, now, path);
    expect(recovered.state("account-a").usedUnknown).toBe(1);
    expect(recovered.reserve("account-a", 1).reason).toBe("cap-reached");
  });

  it("holds interrupted pending spend as unknown across repeated reconstruction", () => {
    const path = file();
    expect(new UsageAllowance(cap, now, path).reserve("account-a", 1).ok).toBe(true);
    for (let i = 0; i < 2; i++) {
      const recovered = new UsageAllowance(cap, now, path);
      expect(recovered.state("account-a")).toMatchObject({ used: 0, reserved: 0, usedUnknown: 1 });
      expect(recovered.reserve("account-a", 1).reason).toBe("cap-reached");
    }
  });

  it("does not turn a durable pre-dispatch release into unknown spend", () => {
    const path = file();
    const ledger = new UsageAllowance(cap, now, path);
    ledger.reserve("account-a", 1);
    ledger.release("account-a", 1);
    const recovered = new UsageAllowance(cap, now, path);
    expect(recovered.state("account-a").usedUnknown).toBe(0);
    expect(recovered.reserve("account-a", 1).ok).toBe(true);
  });

  it("reads an older settled-only version-one ledger", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, months: { "2026-09": { "account-a": { used: 0.75 } } } }));
    const recovered = new UsageAllowance(cap, now, path);
    expect(recovered.state("account-a")).toMatchObject({ used: 0.75, usedUnknown: 0 });
    expect(recovered.reserve("account-a", 0.5).reason).toBe("cap-reached");
  });

  it("refuses new spend and preserves a malformed ledger for repair", () => {
    const path = file();
    writeFileSync(path, "{broken");
    const recovered = new UsageAllowance(cap, now, path);
    expect(recovered.reserve("account-a", 1).reason).toBe("ledger-unavailable");
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });

  it("refuses an existing ledger that cannot be read as a file", () => {
    const path = file();
    mkdirSync(path);
    expect(new UsageAllowance(cap, now, path).reserve("account-a", 1).reason).toBe("ledger-unavailable");
  });

  it.each(["used", "usedUnknown", "reserved"])("rejects a negative persisted %s balance", (field) => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, months: { "2026-09": { "account-a": { used: 0, [field]: -100 } } } }));
    expect(new UsageAllowance(cap, now, path).reserve("account-a", 1).reason).toBe("ledger-unavailable");
  });

  it("refuses dispatch and rolls back memory if the reservation write fails", () => {
    const path = file();
    const ledger = new UsageAllowance(cap, now, path);
    mkdirSync(path);
    expect(ledger.reserve("account-a", 1).reason).toBe("ledger-unavailable");
    expect(ledger.state("account-a").reserved).toBe(0);
  });

  it("keeps the last durable hold when settlement cannot be written", () => {
    const path = file();
    const ledger = new UsageAllowance(cap, now, path);
    expect(ledger.reserve("account-a", 1).ok).toBe(true);
    // Preserve the last durable bytes while forcing atomic rename to fail.
    renameSync(path, `${path}.saved`);
    mkdirSync(path);
    ledger.reconcile("account-a", 1, 1);
    expect(ledger.reserve("account-a", 1).reason).toBe("ledger-unavailable");
    rmSync(path, { recursive: true });
    renameSync(`${path}.saved`, path);
    const recovered = new UsageAllowance(cap, now, path);
    expect(recovered.state("account-a")).toMatchObject({ used: 0, reserved: 0, usedUnknown: 1 });
    expect(recovered.reserve("account-a", 1).reason).toBe("cap-reached");
  });

  it("serializes synchronous holds per account while preserving other accounts' allowance", () => {
    const ledger = new UsageAllowance(cap, now, file());
    expect(ledger.reserve("account-a", 0.6).ok).toBe(true);
    expect(ledger.reserve("account-a", 0.6).reason).toBe("cap-reached");
    expect(ledger.reserve("account-b", 0.6).ok).toBe(true);
  });
});
