import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuildDiagnostics, observeBuild } from "./build-identity.ts";
const roots: string[] = [];
const declared = { schema: 1 as const, buildId: "12345678-1234-1234-1234-123456789012", source: { revision: null, dirty: null }, version: "1.12.0" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muster-identity-")); roots.push(root);
  writeFileSync(join(root, "index.html"), "workspace");
  const manifest = { ...declared, artifact: "web", files: [{ path: "index.html", sha256: createHash("sha256").update("workspace").digest("hex"), size: 9 }] };
  writeFileSync(join(root, "build-identity.json"), JSON.stringify(manifest));
  return { root, manifest };
}
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("build observations", () => {
  it("reports legacy output as unknown", () => { expect(observeBuild(null, "web").status).toBe("unknown"); });
  it("matches measured bytes but distinguishes changed content under the same source claim", () => {
    const { root } = fixture(); const first = observeBuild(root, "web");
    expect(first.status).toBe("matching");
    writeFileSync(join(root, "index.html"), "different");
    const next = observeBuild(root, "web");
    expect(next.status).toBe("mismatched"); expect("sha256" in next && next.sha256).not.toBe("sha256" in first && first.sha256);
  });
  it.each(["../escape", "/absolute", "index.html/../index.html"])("rejects manifest path %s", (path) => {
    const { root, manifest } = fixture(); manifest.files[0].path = path;
    writeFileSync(join(root, "build-identity.json"), JSON.stringify(manifest));
    expect(observeBuild(root, "web").status).toBe("unknown");
  });
  it("rejects symlink content", () => {
    const { root } = fixture(); rmSync(join(root, "index.html")); symlinkSync(join(root, "build-identity.json"), join(root, "index.html"));
    expect(observeBuild(root, "web").status).toBe("unknown");
  });
  it("rejects oversized manifests", () => {
    const { root } = fixture(); writeFileSync(join(root, "build-identity.json"), " ".repeat(1024 * 1024 + 1));
    expect(observeBuild(root, "web").status).toBe("unknown");
  });
  it("keeps backend startup observation fixed while refreshing web snapshots", () => {
    vi.useFakeTimers(); const { root } = fixture(); const diagnostics = createBuildDiagnostics(root, root, declared);
    const first = diagnostics(); writeFileSync(join(root, "index.html"), "different");
    expect(diagnostics().web).toEqual(first.web);
    vi.advanceTimersByTime(10_001);
    const next = diagnostics(); expect(next.backend).toEqual(first.backend); expect(next.web.status).toBe("mismatched");
    expect(JSON.stringify(next)).not.toContain(root); expect(next.attestation).toBe(false);
  });
});
