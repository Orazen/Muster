// Deployment environment passthrough policy.
//
// `isEmailConfigured()` in server/email.ts is exactly `Boolean(RESEND_API_KEY)`
// and GET /api/auth-capabilities advertises `emailOtp` from it, so those two
// variables decide whether a deployed server can send a sign-in code at all.
// Docker Compose forwards ONLY what a service declares — in its `environment:`
// block or an `env_file:` — so a value placed in the shell or a `.env` file
// never reaches the container unless the name is declared. That makes the
// compose declaration the actual enablement switch, and an omission is silent:
// the deployment keeps serving a sign-in screen that simply hides email codes,
// which reads exactly like "email sign-in is broken".
//
// This test is the guard. It fails when the server reads a variable no compose
// service declares, when a compose file drifts behind the others, when a
// documented name stops matching a read name (the shape a `RESEND_APILKEY`-
// style typo takes), or when a secret literal is committed — including one
// hidden inside a substitution default.
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

/** Every compose file that can run the server. */
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
      environment: z.union([z.array(z.string()), z.record(z.string(), scalar)]).optional(),
    }),
  ),
});

type Environment = Map<string, string>;

/** One service's declared environment, normalizing both compose syntaxes. */
const declaredEnvironment = (value: z.infer<typeof composeDoc>["services"][string]["environment"]): Environment => {
  const entries = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const entry = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(item);
      if (entry) entries.set(entry[1]!, entry[2]!.trim());
    }
    return entries;
  }
  if (value) for (const [name, raw] of Object.entries(value)) entries.set(name, String(raw));
  return entries;
};

const servicesOf = (file: string): Array<{ service: string; env: Environment }> => {
  const parsed = composeDoc.safeParse(parse(read(file)));
  if (!parsed.success) throw new Error(`${file} is not a compose document this test understands`);
  return Object.entries(parsed.data.services).map(([service, definition]) => ({
    service,
    env: declaredEnvironment(definition.environment),
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

// Names that could carry a credential: their value must arrive as a shell
// substitution, and its default must be blank. A non-blank default would be a
// hardcoded credential wearing a substitution's syntax.
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE/;
const SUBSTITUTION_WITH_BLANK_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-\s*)?\}$/;

const mailerVars = envReads(read("server/email.ts"));
const documented = documentedVars(read("docs/self-host.md"));

describe("deployment environment passthrough", () => {
  it.each(COMPOSE_FILES)("%s declares every variable the mailer reads", (file) => {
    for (const { service, env } of servicesOf(file)) {
      expect(
        mailerVars.filter((name) => !env.has(name)),
        `${file}: service "${service}" does not declare ${mailerVars.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("declares the sign-in mailer switch itself, in every service of every file", () => {
    for (const file of COMPOSE_FILES) {
      for (const { service, env } of servicesOf(file)) {
        expect(env.has("RESEND_API_KEY"), `${file}: service "${service}" must declare RESEND_API_KEY`).toBe(true);
        expect(env.has("EMAIL_FROM"), `${file}: service "${service}" must declare EMAIL_FROM`).toBe(true);
      }
    }
  });

  it("never commits a secret literal, including one hidden in a default", () => {
    for (const file of COMPOSE_FILES) {
      for (const { service, env } of servicesOf(file)) {
        for (const [name, value] of env) {
          if (!SECRETISH.test(name)) continue;
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
