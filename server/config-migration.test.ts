import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const run = promisify(execFile);
const configUrl = new URL("./config.ts", import.meta.url).href;
const resultSchema = z.object({ dataDir: z.string(), eventsDir: z.string(), nativeDir: z.string(), home: z.string() });
let scratch: string, fixtureHome: string, legacy: string, current: string, sentinel: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "muster-config-migration-"));
  fixtureHome = join(scratch, "home");
  legacy = join(fixtureHome, ".opengrokbot");
  current = join(fixtureHome, ".muster");
  sentinel = randomUUID();
  mkdirSync(fixtureHome);
  writeFileSync(join(fixtureHome, "keep-home.txt"), sentinel);
});

afterEach(() => {
  expect(readFileSync(join(fixtureHome, "keep-home.txt"), "utf8")).toBe(sentinel);
  rmSync(scratch, { recursive: true, force: true });
});

function seed(path: string, marker: string) {
  mkdirSync(join(path, "events"), { recursive: true });
  mkdirSync(join(path, "native"), { recursive: true });
  writeFileSync(join(path, "fleet.json"), JSON.stringify({ marker, bots: [{ id: "owned-bot", name: "Fixture" }] }));
  writeFileSync(join(path, "config.json"), JSON.stringify({ profile: { name: marker } }));
  writeFileSync(join(path, "events", "turn.jsonl"), marker + "\n");
  writeFileSync(join(path, "native", "keep.txt"), marker);
}

function expectSeed(path: string, marker: string) {
  expect(JSON.parse(readFileSync(join(path, "fleet.json"), "utf8"))).toEqual({ marker, bots: [{ id: "owned-bot", name: "Fixture" }] });
  expect(JSON.parse(readFileSync(join(path, "config.json"), "utf8"))).toEqual({ profile: { name: marker } });
  expect(readFileSync(join(path, "events", "turn.jsonl"), "utf8")).toBe(marker + "\n");
  expect(readFileSync(join(path, "native", "keep.txt"), "utf8")).toBe(marker);
}

async function ensure(dataDir?: string) {
  const env: NodeJS.ProcessEnv = { HOME: fixtureHome, USERPROFILE: fixtureHome, EXPECT_FIXTURE_HOME: fixtureHome, TMPDIR: scratch, TEMP: scratch, TMP: scratch };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
  if (dataDir !== undefined) env.OMB_DATA_DIR = dataDir;
  // The guard runs before importing config, so even the legacy path constant
  // is derived from the owned HOME. No inherited hooks or provider env exists.
  const script = `
    import { homedir } from 'node:os';
    if (homedir() !== process.env.EXPECT_FIXTURE_HOME) throw new Error('Fixture HOME was not applied');
    const { ensureDirs, DATA_DIR, EVENTS_DIR, NATIVE_DIR } = await import(${JSON.stringify(configUrl)});
    ensureDirs();
    console.log(JSON.stringify({ dataDir: DATA_DIR, eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, home: homedir() }));
  `;
  const result = await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: scratch, env, timeout: 10000, maxBuffer: 1024 * 1024 });
  return resultSchema.parse(JSON.parse(result.stdout));
}

describe("legacy data-directory migration in owned child processes", () => {
  it.each(["custom", "explicit-default", "default-looking-alias", "relative"])("leaves the legacy fleet intact for an explicit %s directory", async (kind) => {
    seed(legacy, sentinel);
    const explicit = kind === "custom" ? join(scratch, "selected profile")
      : kind === "explicit-default" ? current
        : kind === "default-looking-alias" ? `${fixtureHome}${sep}.${sep}.muster`
          : "relative-profile";
    const result = await ensure(explicit);
    expect(result.dataDir).toBe(explicit);
    expect(result.home).toBe(fixtureHome);
    expectSeed(legacy, sentinel);
    const created = resolve(scratch, explicit);
    expect(readdirSync(created).sort()).toEqual(["events", "native"]);
    expect(existsSync(join(created, "fleet.json"))).toBe(false);
  });

  it("migrates all legacy data only when the override is unset and the default does not exist", async () => {
    seed(legacy, sentinel);
    const result = await ensure();
    expect(result).toEqual({ dataDir: current, eventsDir: join(current, "events"), nativeDir: join(current, "native"), home: fixtureHome });
    expect(existsSync(legacy)).toBe(false);
    expectSeed(current, sentinel);
    await ensure();
    expectSeed(current, sentinel);
  });

  it("preserves both fleets when the implicit default directory already exists", async () => {
    seed(legacy, "legacy-" + sentinel);
    seed(current, "current-" + sentinel);
    await ensure();
    expectSeed(legacy, "legacy-" + sentinel);
    expectSeed(current, "current-" + sentinel);
  });

  it("creates an empty implicit default when no legacy fleet exists", async () => {
    await ensure();
    expect(readdirSync(current).sort()).toEqual(["events", "native"]);
    expect(existsSync(legacy)).toBe(false);
  });

  it.each(["", "   ", "\t\n"])("rejects the explicit blank override %j without migration or cwd writes", async (blank) => {
    seed(legacy, sentinel);
    await expect(ensure(blank)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("OMB_DATA_DIR must be a nonempty directory path when set") });
    expectSeed(legacy, sentinel);
    expect(existsSync(current)).toBe(false);
    expect(readdirSync(scratch)).toEqual(["home"]);
  });
});
