import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "muster-auth-list-sessions-"));
const savedEnvironment = {
  OMB_DATA_DIR: process.env.OMB_DATA_DIR,
  OMB_HOST: process.env.OMB_HOST,
  OMB_PUBLIC_HOST: process.env.OMB_PUBLIC_HOST,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
};

let auth: typeof import("./auth.ts").auth;
let createBridgedUser: typeof import("./auth.ts").createBridgedUser;
let mintSession: typeof import("./auth.ts").mintSession;
let signedSessionCookieValue: typeof import("./auth.ts").signedSessionCookieValue;
let getDb: typeof import("./auth.ts").getDb;

beforeAll(async () => {
  process.env.OMB_DATA_DIR = dataDir;
  process.env.OMB_HOST = "127.0.0.1";
  delete process.env.OMB_PUBLIC_HOST;
  process.env.BETTER_AUTH_SECRET = "auth-list-sessions-fixture-secret-not-a-credential";
  const authModule = await import("./auth.ts");
  auth = authModule.auth;
  createBridgedUser = authModule.createBridgedUser;
  mintSession = authModule.mintSession;
  signedSessionCookieValue = authModule.signedSessionCookieValue;
  getDb = authModule.getDb;
});

afterAll(() => {
  getDb?.().close();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

type SessionFixture = {
  userId: string;
  currentToken: string;
  otherToken: string;
};

const sessionListSchema = z.array(z.record(z.string(), z.json()));

function makeAccount(label: string, sessionCount: number): SessionFixture {
  const userId = createBridgedUser(`${label}-${randomUUID()}@example.test`, label);
  const tokens = Array.from({ length: sessionCount }, (_, index) =>
    mintSession(userId, { userAgent: `${label}-browser-${index}` }).token,
  );
  const [currentToken = "", otherToken = ""] = tokens;
  return { userId, currentToken, otherToken };
}

function cookieFor(token: string): string {
  return `better-auth.session_token=${signedSessionCookieValue(token)}`;
}

function listSessions(cookie?: string): Promise<Response> {
  return auth.handler(
    new Request("http://127.0.0.1:8799/api/auth/list-sessions", {
      method: "GET",
      headers: cookie ? { cookie } : {},
    }),
  );
}

function revokeSession(cookie: string, sessionId: string): Promise<Response> {
  return auth.handler(
    new Request("http://127.0.0.1:8799/api/auth/revoke-session", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://127.0.0.1:8799",
      },
      body: JSON.stringify({ sessionId }),
    }),
  );
}

async function responseSessions(response: Response): Promise<z.infer<typeof sessionListSchema>> {
  return sessionListSchema.parse(await response.json());
}

describe("configured Better Auth list-sessions handler", () => {
  it("redacts token fields and values while identifying the current and other sessions", async () => {
    const account = makeAccount("owner", 2);
    const response = await listSessions(cookieFor(account.currentToken));
    const responseText = await response.clone().text();
    const body = await responseSessions(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toHaveLength(2);
    expect(body.filter((session) => session.current === true)).toHaveLength(1);
    expect(body.find((session) => session.current === true)?.id).toEqual(expect.any(String));
    expect(body.filter((session) => session.current === false)).toHaveLength(1);
    expect(body.every((session) => !Object.hasOwn(session, "token"))).toBe(true);

    const serialized = JSON.stringify(body);
    expect(responseText).not.toContain(account.currentToken);
    expect(responseText).not.toContain(account.otherToken);
    expect(serialized).not.toContain(account.currentToken);
    expect(serialized).not.toContain(account.otherToken);
  });

  it("keeps Better Auth's session list isolated to the authenticated account", async () => {
    const owner = makeAccount("tenant-a", 2);
    const otherAccount = makeAccount("tenant-b", 1);

    const ownerResponse = await listSessions(cookieFor(owner.currentToken));
    const ownerText = await ownerResponse.clone().text();
    const ownerSessions = await responseSessions(ownerResponse);
    const otherResponse = await listSessions(cookieFor(otherAccount.currentToken));
    const otherText = await otherResponse.clone().text();
    const otherSessions = await responseSessions(otherResponse);

    expect(ownerSessions).toHaveLength(2);
    expect(otherSessions).toHaveLength(1);
    expect(ownerSessions.every((session) => session.userId === owner.userId)).toBe(true);
    expect(ownerSessions.map((session) => session.id)).not.toContain(otherSessions[0]?.id);
    expect(ownerText).not.toContain(otherAccount.currentToken);
    expect(otherText).not.toContain(owner.currentToken);
    expect(otherText).not.toContain(owner.otherToken);
    expect(JSON.stringify(ownerSessions)).not.toContain(otherAccount.currentToken);
    expect(JSON.stringify(otherSessions)).not.toContain(owner.currentToken);
    expect(JSON.stringify(otherSessions)).not.toContain(owner.otherToken);
  });

  it("resolves an owned session ID and leaves Better Auth revocation working", async () => {
    const account = makeAccount("revocation", 2);
    const listed = await responseSessions(await listSessions(cookieFor(account.currentToken)));
    const otherSessionId = listed.find((session) => session.current === false)?.id;
    expect(otherSessionId).toEqual(expect.any(String));

    const revokeResponse = await revokeSession(cookieFor(account.currentToken), String(otherSessionId));

    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toMatchObject({ status: true });

    const listResponse = await listSessions(cookieFor(account.currentToken));
    const remainingSessions = await responseSessions(listResponse);
    expect(remainingSessions).toHaveLength(1);
    expect(remainingSessions[0]?.current).toBe(true);
    expect(remainingSessions.map((session) => session.id)).not.toContain(otherSessionId);
    expect(JSON.stringify(remainingSessions)).not.toContain(account.otherToken);
  });

  it("does not revoke a different account's session ID", async () => {
    const owner = makeAccount("session-id-owner", 1);
    const otherAccount = makeAccount("session-id-other", 1);
    const otherSessions = await responseSessions(await listSessions(cookieFor(otherAccount.currentToken)));
    const foreignSessionId = otherSessions[0]?.id;
    expect(foreignSessionId).toEqual(expect.any(String));

    const response = await revokeSession(cookieFor(owner.currentToken), String(foreignSessionId));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: true });

    expect(await responseSessions(await listSessions(cookieFor(owner.currentToken)))).toHaveLength(1);
    const stillOwnedByOther = await responseSessions(await listSessions(cookieFor(otherAccount.currentToken)));
    expect(stillOwnedByOther).toHaveLength(1);
    expect(stillOwnedByOther[0]?.id).toBe(foreignSessionId);
  });

  it("resolves the current session ID without targeting another account", async () => {
    const owner = makeAccount("current-revocation", 2);
    const otherAccount = makeAccount("current-revocation-other", 1);
    const ownerSessions = await responseSessions(await listSessions(cookieFor(owner.currentToken)));
    const currentSessionId = ownerSessions.find((session) => session.current === true)?.id;
    expect(currentSessionId).toEqual(expect.any(String));

    const response = await revokeSession(cookieFor(owner.currentToken), String(currentSessionId));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: true });

    expect((await listSessions(cookieFor(owner.currentToken))).status).toBe(401);
    const otherSessions = await responseSessions(await listSessions(cookieFor(otherAccount.currentToken)));
    expect(otherSessions).toHaveLength(1);
  });

  it("does not expose session tokens in Better Auth error responses", async () => {
    const owner = makeAccount("error-owner", 2);
    const invalidSignatureCookie =
      `better-auth.session_token=${encodeURIComponent(`${owner.currentToken}.invalid-signature`)}`;
    const response = await listSessions(invalidSignatureCookie);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain(owner.currentToken);
    expect(body).not.toContain(owner.otherToken);
  });
});
