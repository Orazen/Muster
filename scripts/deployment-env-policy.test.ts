// Deployment environment passthrough policy.
//
// `isEmailConfigured()` in server/email.ts is exactly `Boolean(RESEND_API_KEY)`
// and GET /api/auth-capabilities advertises `emailOtp` from it, so those two
// variables decide whether a deployed server can send a sign-in code at all.
// Docker Compose forwards ONLY what a service declares — in its `environment:`
// block or through an `env_file:` — so a value placed in the shell or a `.env`
// file never reaches the container unless the name is declared. That makes the
// compose declaration the actual enablement switch, and an omission is silent:
// the deployment keeps serving a sign-in screen that hides email codes, which
// reads exactly like "email sign-in is broken".
//
// SCOPE, stated precisely so the guarantee is not read as larger than it is.
// This guard covers the MAILER, and only the mailer: it reads the variables
// `server/email.ts` reads and requires each server-running service in these
// compose files to declare them. It does not audit every documented variable —
// several are declared by no compose file on purpose — and it does not decide
// whether a service runs the server; it asks the compose document, treating a
// service with a `build:` or named `muster` as the server.
//
// It parses the compose files with the real YAML parser rather than matching
// text, so both the mapping syntax (`NAME: "value"`) and the list syntax
// (`- NAME=value`) are covered, along with every service in every file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

/** Every compose file in this repo that can run the server. */
const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.prod.yml",
  "docker-compose.staging.yml",
] as const;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const composeDoc = z.object({
  services: z.record(
    z.string(),
    z.object({
      build: z.unknown().optional(),
      env_file: z.unknown().optional(),
      environment: z.union([z.array(z.string()), z.record(z.string(), scalar)]).optional(),
    }),
  ),
});

type Service = { service: string; env: Map<string, string>; runsServer: boolean; viaEnvFile: boolean };

/**
 * One service's declared environment, normalizing both compose syntaxes.
 * `- NAME=value` and `- NAME` are both list forms; the bare form forwards the
 * variable straight from the host, so the name counts as declared.
 */
const declaredEnvironment = (value: z.infer<typeof composeDoc>["services"][string]["environment"]): Map<string, string> => {
  const entries = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const pair = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(item);
      if (pair) {
        entries.set(pair[1]!, pair[2]!.trim());
        continue;
      }
      const bare = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(item);
      if (bare) entries.set(bare[1]!, "");
    }
    return entries;
  }
  if (value) for (const [name, raw] of Object.entries(value)) entries.set(name, String(raw));
  return entries;
};

/** A service runs the server when the compose document says it builds one. */
const runsServer = (service: string, definition: z.infer<typeof composeDoc>["services"][string]): boolean =>
  definition.build !== undefined || service === "muster";

const servicesOf = (file: string): Service[] => {
  const parsed = composeDoc.safeParse(parse(read(file)));
  if (!parsed.success) throw new Error(`${file} is not a compose document this test understands`);
  return Object.entries(parsed.data.services).map(([service, definition]) => ({
    service,
    env: declaredEnvironment(definition.environment),
    runsServer: runsServer(service, definition),
    // An `env_file:` service states where its variables come from. We cannot
    // read the referenced file's contents here, so treat the declaration as
    // satisfying rather than demanding a redundant inline copy.
    viaEnvFile: definition.env_file !== undefined,
  }));
};

/** Every `process.env.NAME` the mailer reads: dot, bracket and destructured. */
const envReads = (source: string): string[] => {
  const names = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(match[1]!);
  for (const match of source.matchAll(/process\.env\[\s*["'`]([A-Z0-9_]+)["'`]\s*\]/g)) names.add(match[1]!);
  for (const match of source.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.split(":")[0]!.trim().replace(/^\.\.\./, "");
      if (/^[A-Z0-9_]+$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
};

/** Variable names documented in the self-host environment table. */
const documentedVars = (markdown: string): string[] => {
  const names = new Set<string>();
  for (const match of markdown.matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|/gm)) names.add(match[1]!);
  return [...names].sort();
};

// Credential-bearing names, matched on a SUFFIX rather than a substring: a
// tuning knob like SESSION_TOKEN_TTL_SECONDS legitimately carries a numeric
// default, while RESEND_API_KEY and BETTER_AUTH_SECRET must not.
const CREDENTIAL_NAME = /(?:^|_)(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS?)$/;
const SUBSTITUTION_WITH_BLANK_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-\s*)?\}$/;

const mailerVars = envReads(read("server/email.ts"));
const documented = documentedVars(read("docs/self-host.md"));
const serverServices = COMPOSE_FILES.flatMap((file) =>
  servicesOf(file).filter((entry) => entry.runsServer).map((entry) => ({ file, ...entry })),
);

describe("deployment environment passthrough", () => {
  it("still reads the mailer's variables out of the source", () => {
    // Non-vacuity anchor. Without it, deleting every process.env read from the
    // mailer would satisfy every assertion below by comparing nothing to
    // nothing, and the guard would report success while watching an empty set.
    expect(mailerVars.length).toBeGreaterThan(0);
  });

  it("finds the server services the assertion is about", () => {
    expect(serverServices.length).toBe(COMPOSE_FILES.length);
  });

  it.each(COMPOSE_FILES)("%s declares every mailer variable in each server service", (file) => {
    for (const entry of serverServices.filter((service) => service.file === file)) {
      if (entry.viaEnvFile) continue;
      expect(
        mailerVars.filter((name) => !entry.env.has(name)),
        `${file}: service "${entry.service}" does not declare ${mailerVars.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("declares the sign-in mailer switch in each server service", () => {
    for (const { file, service, env, viaEnvFile } of serverServices) {
      if (viaEnvFile) continue;
      expect(env.has("RESEND_API_KEY"), `${file}: service "${service}" must declare RESEND_API_KEY`).toBe(true);
      expect(env.has("EMAIL_FROM"), `${file}: service "${service}" must declare EMAIL_FROM`).toBe(true);
    }
  });

  it("never commits a credential literal, including one hidden in a default", () => {
    for (const file of COMPOSE_FILES) {
      for (const { service, env } of servicesOf(file)) {
        for (const [name, value] of env) {
          if (!CREDENTIAL_NAME.test(name)) continue;
          // An empty value is the bare list form (`- NAME`) or `- NAME=`:
          // compose forwards the variable from the host environment and the
          // file commits no credential at all.
          if (value === "") continue;
          expect(
            value,
            `${file}: service "${service}" declares ${name} as a literal instead of a blank-default substitution`,
          ).toMatch(SUBSTITUTION_WITH_BLANK_DEFAULT);
        }
      }
    }
  });

  it("documents every variable the mailer reads", () => {
    // Subset check, not an exact pair: documenting an unrelated EMAIL_* or
    // RESEND_* variable later must not fail the build, but a renamed or
    // misspelled one (the RESEND_APILKEY shape) drops a real name from the
    // documentation and does fail.
    expect(mailerVars.filter((name) => !documented.includes(name))).toEqual([]);
  });
});
