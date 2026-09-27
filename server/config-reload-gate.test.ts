// The reload gate is only as good as its coverage of the config schema.
//
// `PUT /api/config` used to reload the engine registry whenever a patch carried
// any key besides `profile`/`tts`. The registry reload disposes every engine and
// settles every busy bot with "turn interrupted — provider settings changed", so
// four cosmetic sections — `branding`, `parallelThreads`, `eventLogRetention`,
// `bots` — destroyed in-flight work fleet-wide. server/config-reload-gate-e2e
// proves the effect; this file stops the same rot coming back.
//
// The mechanism that rotted it was structural: a DENYLIST has no way to notice a
// new key, so every future section silently joined the destructive branch. The
// fix is an allowlist, and an allowlist is only safe if it is provably complete.
// That is what these cases assert — chiefly by deriving the expected set from
// the registry builder's own source rather than from a second hand-written copy
// that could drift the moment someone edits either file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS, PROVIDER_RELOAD_SECTIONS, parseConfigPatch, providerReloadRequired } from "./config.ts";

const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), "config.ts");

/** The config sections that are read live, per turn or per request, and so are
 * already in effect the moment they are saved. Named explicitly here — not in
 * the implementation — so that adding a section anywhere forces a decision in
 * two places instead of one. */
const READ_LIVE: readonly string[] = [
  "branding", // labels only: org name, logo
  "channels", // turn-cap minutes
  "composio", // prepared per request at the route
  "driveSync", // read per sync route
  "eventLogRetention", // applied by the log reaper, not by a driver
  "hiNew", // read per turn in the dispatch path
  "localVm", // container lifecycle, read per call
  "mcpServers", // customMcpForBot() per turn — its own routes never reload
  "musterCloud",
  "openConnector",
  "opensandbox",
  "parallelThreads", // the slot ledger reads it per turn
  "profile", // display name/email
  "telegramSync", // per push/pull
  "tts", // picked per turn
  "usage", // allowance, checked per turn
  "vps",
  "bots", // default effort, read per turn
];

/** Sections the generic `PUT /api/config` patch cannot carry: they have
 * whole-collection write semantics on their own routes, which reload the
 * registry themselves. */
const OWN_ROUTE_ONLY: ReadonlySet<string> = new Set(["instances", "mcpServers", "customProviders"]);

/** The smallest patch that names `section` at all, built by the route's own
 * parser so these cases also prove the section is genuinely savable. */
function patchNaming(section: string) {
  return parseConfigPatch(JSON.parse(JSON.stringify({ [section]: {} })));
}

describe("the provider-reload gate", () => {
  it("classifies every config section, so a new one cannot default to destructive", () => {
    // The regression this file exists for. A denylist failed exactly here: a
    // section nobody classified fell into "reload the fleet".
    const unclassified = CONFIG_SECTIONS.filter(
      (key) => !PROVIDER_RELOAD_SECTIONS.has(key) && !READ_LIVE.includes(key),
    );
    expect(
      unclassified,
      "these config sections are neither registry-shaping nor declared read-live — add each to PROVIDER_RELOAD_SECTIONS or to READ_LIVE",
    ).toEqual([]);
  });

  it("names no section that does not exist", () => {
    // Drift the other way: a stale entry in the allowlist would keep a removed
    // section's key path interrupting turns forever.
    const unknown = [...PROVIDER_RELOAD_SECTIONS].filter((key) => !CONFIG_SECTIONS.includes(key));
    expect(unknown).toEqual([]);
  });

  it("matches exactly the sections instanceConfigs() reads", () => {
    // The invariant that makes the allowlist TRUE rather than merely plausible.
    //
    // `instanceConfigs()` is the one function that builds the registry's
    // instance map and injects per-instance credential environment, so the set
    // of config keys it reads IS the set of changes that require rebuilding the
    // engines. Reading it out of the source rather than restating it here means
    // adding `cfg.somethingElse.key` to that function without classifying
    // `somethingElse` fails this case — which is exactly the edit that would
    // otherwise make a live section need a reload, discovered here instead of
    // in a user's lost turn.
    const source = readFileSync(CONFIG_FILE, "utf8");
    const start = source.indexOf("export function instanceConfigs");
    expect(start, "instanceConfigs() must still exist in config.ts").toBeGreaterThan(-1);

    // Brace-matched body, so a signature that grows a second clause cannot make
    // the scan stop early or run on into the next function.
    const open = source.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = source.slice(open, end);
    const read = new Set([...body.matchAll(/cfg\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!));
    // This function is the source of truth; if it ever reads nothing, the scan
    // broke and a vacuous pass would be worse than a failure.
    expect(read.size, "the scan must actually find config reads").toBeGreaterThan(0);
    expect([...PROVIDER_RELOAD_SECTIONS].sort()).toEqual([...read].sort());
  });

  it("classifies every section the generic patch cannot carry", () => {
    // The allowlist deliberately mirrors what `instanceConfigs()` reads, which
    // is a SUPERSET of what the generic patch can express: these three have
    // whole-collection write semantics on their own routes, and those routes
    // reload the registry themselves. Naming them where the builder's reads
    // require is defence in depth, and it keeps the completeness case above a
    // real equality rather than an approximation.
    //
    // So they are pinned in the direction they actually belong, not all three in
    // the reload set: `instances` and `customProviders` shape the registry,
    // while `mcpServers` is read per turn and genuinely does not.
    for (const key of OWN_ROUTE_ONLY) {
      expect(Object.keys(patchNaming(key)), `${key} must not ride the generic patch`).toEqual([]);
      const classified = PROVIDER_RELOAD_SECTIONS.has(key) ? "registry" : READ_LIVE.includes(key) ? "live" : null;
      expect(classified, `${key} must be classified one way or the other`).not.toBeNull();
    }
    expect(PROVIDER_RELOAD_SECTIONS.has("instances")).toBe(true);
    expect(PROVIDER_RELOAD_SECTIONS.has("customProviders")).toBe(true);
    expect(PROVIDER_RELOAD_SECTIONS.has("mcpServers")).toBe(false);
  });

  it("reloads for a registry section and stays quiet for a live one", () => {
    for (const key of PROVIDER_RELOAD_SECTIONS) {
      if (OWN_ROUTE_ONLY.has(key)) continue; // pinned by the case above
      expect(providerReloadRequired(patchNaming(key)), `${key} must reload the registry`).toBe(true);
    }
    for (const key of READ_LIVE) {
      if (OWN_ROUTE_ONLY.has(key)) continue;
      expect(providerReloadRequired(patchNaming(key)), `${key} must not reload the registry`).toBe(false);
    }
  });

  it("reloads once for a mixed patch, because a credential did change", () => {
    // The gate is per-patch, not per-key: a brand name and a new API key in one
    // save still has to rebuild, or the key would not take effect.
    expect(providerReloadRequired({ branding: { orgName: "Acme" }, xai: { key: "k" } })).toBe(true);
    expect(providerReloadRequired({ branding: { orgName: "Acme" }, profile: { name: "n" } })).toBe(false);
  });

  it("stays quiet for an empty patch", () => {
    // The route rejects an empty patch before this is reached, but the function
    // must not be the thing that decides to destroy a turn over nothing.
    expect(providerReloadRequired({})).toBe(false);
  });
});
