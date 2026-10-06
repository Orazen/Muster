import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./muster.mjs", import.meta.url));
const homes = [];
const servers = [];

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "muster-sessions-cli-"));
  homes.push(home);
  return home;
}

function runCli(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, MUSTER_DIR: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function fixtureServer(sessions) {
  const revocations = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/api/auth/list-sessions") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(sessions));
        return;
      }
      if (request.method === "POST" && request.url === "/api/auth/revoke-session") {
        revocations.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: true }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Not found" }));
    });
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const home = makeHome();
  writeFileSync(
    join(home, "cli.json"),
    JSON.stringify({ base: `http://127.0.0.1:${address.port}`, cookie: "better-auth.session_token=fixture.signature" }),
    { mode: 0o600 },
  );
  return { home, revocations };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const currentToken = ["fixture-session-", "current-secret"].join("");
const otherToken = ["fixture-session-", "other-secret"].join("");
const sessionRows = () => [
  {
    id: "ses_current_fixture",
    current: true,
    createdAt: "2026-10-06T00:00:00.000Z",
    expiresAt: "2026-10-13T00:00:00.000Z",
    ipAddress: null,
    userAgent: "Current test browser",
    token: currentToken,
  },
  {
    id: "ses_other_fixture",
    current: false,
    createdAt: "2026-10-05T00:00:00.000Z",
    expiresAt: "2026-10-12T00:00:00.000Z",
    ipAddress: null,
    userAgent: "Other test browser",
    token: otherToken,
  },
];

describe("muster sessions token-free contract", () => {
  it("prints IDs and the server's current marker without token fields or values", async () => {
    const { home } = await fixtureServer(sessionRows());
    const result = await runCli(home, ["sessions", "--json"]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.sessions).toHaveLength(2);
    expect(payload.sessions.map((session) => session.id)).toEqual(["ses_current_fixture", "ses_other_fixture"]);
    expect(payload.sessions.map((session) => session.current)).toEqual([true, false]);
    expect(payload.sessions.every((session) => !Object.hasOwn(session, "token"))).toBe(true);
    expect(result.stdout).not.toContain(currentToken);
    expect(result.stdout).not.toContain(otherToken);
  });

  it("revokes only non-current session IDs for --revoke other", async () => {
    const { home, revocations } = await fixtureServer(sessionRows());
    const result = await runCli(home, ["sessions", "--revoke", "other", "--json"]);

    expect(result.code).toBe(0);
    expect(revocations).toEqual([{ sessionId: "ses_other_fixture" }]);
    expect(JSON.parse(result.stdout)).toEqual({ revoked: [{ id: "ses_other_fixture" }] });
    expect(result.stdout).not.toContain(currentToken);
    expect(result.stdout).not.toContain(otherToken);
  });

  it("selects an explicitly requested current session by exact ID", async () => {
    const { home, revocations } = await fixtureServer(sessionRows());
    const result = await runCli(home, ["sessions", "--revoke", "ses_current_fixture", "--json"]);

    expect(result.code).toBe(0);
    expect(revocations).toEqual([{ sessionId: "ses_current_fixture" }]);
  });

  it("fails closed when the server omits current markers", async () => {
    const { home, revocations } = await fixtureServer([
      { id: "ses_unknown_fixture", token: otherToken },
    ]);
    const result = await runCli(home, ["sessions", "--revoke", "other"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not support token-free session IDs");
    expect(result.stderr).not.toContain(otherToken);
    expect(revocations).toEqual([]);
  });
});
