import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMPANION_SETTINGS,
  parseCompanionSettings,
  readCompanionSettings,
  writeCompanionSettings,
} from "./companion-settings.mjs";

const scratch = [];
function scratchDir() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "muster-companion-settings-")));
  scratch.push(directory);
  return directory;
}
const scratchFile = () => path.join(scratchDir(), "companion-settings.json");
afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("companion settings parsing", () => {
  it("reads both facts when the document is well formed", () => {
    expect(parseCompanionSettings('{"enabled":true,"keepAwake":true}')).toEqual({ enabled: true, keepAwake: true });
    expect(parseCompanionSettings('{"enabled":true,"keepAwake":false}')).toEqual({ enabled: true, keepAwake: false });
    expect(parseCompanionSettings('{"enabled":false,"keepAwake":true}')).toEqual({ enabled: false, keepAwake: true });
  });

  it("ignores fields this version did not write", () => {
    expect(parseCompanionSettings('{"enabled":true,"keepAwake":false,"future":"whatever"}')).toEqual({
      enabled: true,
      keepAwake: false,
    });
  });

  // Every one of these is a way a preference could be misread as permission to
  // open a port. They all have to land on the off position.
  it.each([
    ["empty string", ""],
    ["truncated document", '{"enabled":true,"keepAwa'],
    ["not JSON at all", "enabled: true"],
    ["null", "null"],
    ["an array", '["enabled"]'],
    ["a bare string", '"enabled"'],
    ["a bare number", "1"],
    ["string booleans", '{"enabled":"true","keepAwake":"true"}'],
    ["numeric booleans", '{"enabled":1,"keepAwake":1}'],
    ["null fields", '{"enabled":null,"keepAwake":null}'],
    ["only one field", '{"enabled":true}'],
    ["only the other field", '{"keepAwake":true}'],
    ["no fields", "{}"],
  ])("fails closed on %s", (_label, text) => {
    expect(parseCompanionSettings(text)).toEqual(DEFAULT_COMPANION_SETTINGS);
  });

  it("hands back a fresh object each time so a caller cannot mutate the default", () => {
    const first = parseCompanionSettings("nonsense");
    first.enabled = true;
    expect(DEFAULT_COMPANION_SETTINGS.enabled).toBe(false);
    expect(parseCompanionSettings("nonsense")).toEqual(DEFAULT_COMPANION_SETTINGS);
  });
});

describe("companion settings on disk", () => {
  it("round-trips through a real file", () => {
    const file = scratchFile();
    expect(writeCompanionSettings(file, { enabled: true, keepAwake: true })).toBe(true);
    expect(readCompanionSettings(file)).toEqual({ enabled: true, keepAwake: true });
  });

  it("treats a missing file as off without creating one", () => {
    const file = scratchFile();
    expect(readCompanionSettings(file)).toEqual(DEFAULT_COMPANION_SETTINGS);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("treats a corrupt file as off and leaves it in place", () => {
    const file = scratchFile();
    fs.writeFileSync(file, '{"enabled":true,');
    expect(readCompanionSettings(file)).toEqual(DEFAULT_COMPANION_SETTINGS);
    // the reader does not repair or delete what it could not understand
    expect(fs.readFileSync(file, "utf8")).toBe('{"enabled":true,');
  });

  it("writes the file 0600", () => {
    const file = scratchFile();
    writeCompanionSettings(file, { enabled: true, keepAwake: false });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind on success", () => {
    const directory = scratchDir();
    const file = path.join(directory, "companion-settings.json");
    writeCompanionSettings(file, { enabled: true, keepAwake: true });
    expect(fs.readdirSync(directory)).toEqual(["companion-settings.json"]);
  });

  it("replaces the previous contents rather than appending to them", () => {
    const file = scratchFile();
    writeCompanionSettings(file, { enabled: true, keepAwake: true });
    writeCompanionSettings(file, { enabled: false, keepAwake: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ enabled: false, keepAwake: false });
  });

  it("reports a failed write instead of throwing", () => {
    const directory = scratchDir();
    const file = path.join(directory, "companion-settings.json");
    const refusing = {
      ...fs,
      renameSync() {
        throw Object.assign(new Error("read-only volume"), { code: "EROFS" });
      },
    };
    expect(writeCompanionSettings(file, { enabled: true, keepAwake: true }, refusing)).toBe(false);
    // and it cleans up after itself so a later read is not confused by a stray fragment
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("still succeeds when the directory already exists", () => {
    const directory = scratchDir();
    const file = path.join(directory, "nested", "companion-settings.json");
    expect(writeCompanionSettings(file, { enabled: true, keepAwake: false })).toBe(true);
    expect(readCompanionSettings(file)).toEqual({ enabled: true, keepAwake: false });
  });
});