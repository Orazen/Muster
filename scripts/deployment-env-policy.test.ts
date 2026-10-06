// Deployment environment passthrough policy.
//
// `isEmailConfigured()` in server/email.ts is exactly `Boolean(RESEND_API_KEY)`
// and GET /api/auth-capabilities advertises `emailOtp` from it, so those two
// variables decide whether a deployed server can send a sign-in code at all.
// Docker Compose forwards ONLY the names written in a service's `environment:`
// block: a value set in a hosting panel's env UI does not reach the container
// unless the name is listed here. That makes the compose list the actual
// enablement switch, and an omission is silent — the deployment keeps serving a
// sign-in screen that simply hides email codes.
//
// This test is the guard. It fails when the server reads a variable no compose
// file forwards, when production and staging drift apart, when the documented
// name and the read name disagree (the shape a `RESEND_APILKEY`-style typo
// takes), or when a secret literal is committed to a compose file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

const PROD = "docker-compose.prod.yml";
const STAGING = "docker-compose.staging.yml";

/** Every `process.env.NAME` the mailer reads, in a stable order. */
const envReads = (source: string): string[] => {
  const names = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(match[1]!);
  return [...names].sort();
};

/** Variable names documented in the self-host env table. */
const documentedVars = (markdown: string): string[] => {
  const names = new Set<string>();
  for (const match of markdown.matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|/gm)) names.add(match[1]!);
  return [...names].sort();
};

/**
 * The single service's `environment:` entries, line by line so a comment or a
 * blank line cannot silently truncate the block. Compose list syntax is
 * `- NAME=value`, so the value may itself contain `=` and spaces.
 */
const forwarded = (compose: string): Map<string, string> => {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => /^\s*environment:\s*$/.test(line));
  if (start === -1) throw new Error("compose file has no environment: block");
  const entries = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    // Blank lines and comments sit inside the block and carry no entry.
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // A dedent, or any line that is not a `- NAME=value` entry, ends the block.
    if (!/^\s/.test(line)) break;
    const entry = /^\s*-\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!entry) break;
    entries.set(entry[1]!, entry[2]!.trim());
  }
  return entries;
};

const mailerVars = envReads(read("server/email.ts"));

describe("deployment environment passthrough", () => {
  it("reads only variables that compose can forward", () => {
    expect(mailerVars.length).toBeGreaterThan(0);
  });

  it.each([PROD, STAGING])("%s forwards every variable the mailer reads", (file) => {
    const entries = forwarded(read(file));
    expect(mailerVars.filter((name) => !entries.has(name))).toEqual([]);
  });

  it("forwards the sign-in mailer switch itself", () => {
    for (const file of [PROD, STAGING]) {
      const entries = forwarded(read(file));
      expect(entries.has("RESEND_API_KEY"), `${file} must forward RESEND_API_KEY`).toBe(true);
      expect(entries.has("EMAIL_FROM"), `${file} must forward EMAIL_FROM`).toBe(true);
    }
  });

  it("keeps production and staging in step", () => {
    const prod = [...forwarded(read(PROD)).keys()].sort();
    const staging = [...forwarded(read(STAGING)).keys()].sort();
    // Staging is a deliberately smaller surface; it may omit prod-only entries,
    // but it must never forward a variable production does not.
    expect(staging.filter((name) => !prod.includes(name))).toEqual([]);
  });

  it("documents exactly the names the mailer reads", () => {
    const documented = documentedVars(read("docs/self-host.md"));
    const mailish = documented.filter((name) => name.includes("RESEND") || name.includes("EMAIL"));
    expect(mailish.sort()).toEqual(["EMAIL_FROM", "RESEND_API_KEY"]);
  });

  it("never commits a secret literal", () => {
    // Non-secret settings (NODE_ENV, OMB_HOST, OMB_PORT) are legitimately
    // literal. Anything that could carry a credential must arrive as a shell
    // substitution so the value lives only in the deployment environment.
    const secretish = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE/;
    for (const file of [PROD, STAGING]) {
      for (const [name, value] of forwarded(read(file))) {
        if (!secretish.test(name)) continue;
        expect(value, `${file}: ${name} must be a shell substitution, not a literal`)
          .toMatch(/^\$\{[A-Z0-9_]+(:-[^}]*)?\}$/);
      }
    }
  });
});
