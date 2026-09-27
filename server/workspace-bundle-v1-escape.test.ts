// A v1 restore must not write outside the data directory.
//
// Sweep 4, item 3. `restoreBundle` built its write targets with
// `join(dataDir, "memory", key)` where `key` came straight out of the bundle,
// checking only that it ended in `.md`. A key carrying `..` therefore landed
// outside the data directory entirely, and the topics branch validated neither
// the botId nor the topic filename. The sibling `workspaces/<botId>/MEMORY.md`
// branch DID validate its id, and v2 already had the right rule —
// `confinedTarget` — which is exactly what the portable-backup contract asks for
// at docs/plans/portable-backup-contract-2026-09-12.md:46 ("must not be reused
// blindly"). The fix runs both v1 branches through the rule v2 already uses
// rather than inventing a third one.
//
// The threat model is bounded and worth stating plainly: the v1 bundle key is
// the deployment signing secret, so this is not "anyone on the internet". It is
// exactly the case the contract names — a bundle produced elsewhere, or altered
// in transit, must not be trusted to name its own write targets.
//
// The assertions are about the FILESYSTEM, not a return value: a fix that
// reported "skipped" while still having written the file would satisfy a status
// check and fail here.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
let root = "";
let dataDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muster-v1-escape-"));
  roots.push(root);
  dataDir = join(root, "data");
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every file the restore created, as absolute paths. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** A v1 workspace envelope, as the parts these cases vary. */
interface MemoryWorkspace {
  memory?: Record<string, string>;
  topics?: Record<string, Record<string, string>>;
}

async function restore(parts: MemoryWorkspace): Promise<{ memoryFilesRestored: number }> {
  const { restoreBundle } = await import("./workspace-bundle.ts");
  const { Store } = await import("./store.ts");
  // Annotated rather than asserted: the literal is built field-for-field from
  // the parameter type, so the compiler checks it instead of being told to
  // believe it, and there is no `as unknown as` chain to justify.
  const envelope: Parameters<typeof restoreBundle>[2] = {
    bots: [],
    groups: [],
    memory: parts.memory ?? {},
    topics: parts.topics ?? {},
    exportedAt: 0,
    // The restore path never reads counts; it is part of the envelope because
    // buildBundle emits it, and the type is the contract.
    counts: { bots: 0, groups: 0, memoryFiles: 0 },
  };
  return restoreBundle(new Store(() => ({ instanceId: "", model: "" })), dataDir, envelope);
}

describe("a v1 restore cannot write outside the data directory", () => {
  it("refuses a contaminated memory branch, then restores a clean bundle", async () => {
    // The target directory exists, so the write SUCCEEDS rather than throwing
    // ENOENT. Without that the case would pass by accident: an earlier draft
    // did exactly that, and proved nothing.
    mkdirSync(join(root, "outside"), { recursive: true });
    const result = await restore({
      memory: {
        "../../outside/planted.md": "planted by a bundle",
        "legit.md": "a real memory file",
      },
    });

    // Nothing at all may appear outside the data directory.
    for (const file of filesUnder(root)) {
      expect(file.startsWith(resolve(dataDir) + sep), `${file} escaped the data directory`).toBe(true);
    }
    // The current restore policy refuses the entire global-memory branch
    // when it contains a bad name; it must not partially trust the payload.
    expect(existsSync(join(dataDir, "memory", "legit.md"))).toBe(false);
    expect(result.memoryFilesRestored).toBe(0);
    // Positive control: a clean bundle still restores through the same API.
    const clean = await restore({ memory: { "legit.md": "a real memory file" } });
    expect(existsSync(join(dataDir, "memory", "legit.md"))).toBe(true);
    expect(clean.memoryFilesRestored).toBe(1);
  });

  it("refuses a topics entry whose bot id or topic filename carries a traversal", async () => {
    // The topics branch validated neither half: `botId` builds a directory and
    // `name` builds a file inside it, and both came from the bundle.
    await restore({ topics: { "..": { "../planted2.md": "planted via a topic" } } });

    for (const file of filesUnder(root)) {
      expect(file.startsWith(resolve(dataDir) + sep), `${file} escaped the data directory`).toBe(true);
    }
  });
});
