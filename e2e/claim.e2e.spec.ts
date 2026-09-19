import { z } from "zod";
import { test, expect } from "./browser-fixtures.ts";

const issuedClaim = z.object({ code: z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/) });
const sessionIdentity = z.object({ user: z.object({ id: z.string(), email: z.string() }) });

test.describe("owner claim links", () => {
  test("an owned claim link opens a session, removes the fragment and cannot be reused", async ({ harness, request, newPage }) => {
    const created = await request.post(`${harness.desktopUrl}/api/pair/claim/create`);
    expect(created.status()).toBe(201);
    const { code } = issuedClaim.parse(await created.json());
    const page = await newPage();
    let submissions = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url() === `${harness.desktopUrl}/api/pair/claim`) submissions += 1;
    });
    await page.goto(`${harness.desktopUrl}/claim#${code}`);
    await expect(page.getByRole("heading", { name: "You’re connected", exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    await expect(page).toHaveURL(`${harness.desktopUrl}/app`);
    const session = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`);
    expect(session.status()).toBe(200);
    const identity = sessionIdentity.parse(await session.json());
    expect(identity.user.id).toBeTruthy();
    expect(identity.user.email).toBe("owner@muster.local");
    expect(submissions).toBe(1);
    const replay = await request.post(`${harness.desktopUrl}/api/pair/claim`, { data: { code } });
    expect(replay.status()).toBe(400);
    const after = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`);
    expect(sessionIdentity.parse(await after.json()).user).toEqual(identity.user);
  });

  test("a cloud pairing code cannot be used as an owner claim", async ({ harness, pairCodeFromCloud, request }) => {
    const rejected = await request.post(`${harness.cloudUrl}/api/pair/claim`, { data: { code: pairCodeFromCloud } });
    expect(rejected.status()).toBe(400);
    const session = await request.get(`${harness.cloudUrl}/api/auth/get-session`);
    expect(await session.json()).toBeNull();
    // Rejection must not consume the code from its actual namespace.
    const verified = await request.post(`${harness.cloudUrl}/api/pair/verify`, { data: { code: pairCodeFromCloud } });
    expect(verified.status()).toBe(200);
    expect(z.object({ email: z.string() }).parse(await verified.json()).email).toBe(harness.email);
  });

  test("a malformed claim link clears its fragment without submitting or authenticating", async ({ harness, newPage }) => {
    const page = await newPage();
    const submissions: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/api/pair/claim")) submissions.push(req.url());
    });
    await page.goto(`${harness.desktopUrl}/claim#not-a-claim`);
    await expect(page.getByRole("alert")).toContainText("This claim code is not valid");
    expect(new URL(page.url()).hash).toBe("");
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    const session = await page.context().request.get(`${harness.desktopUrl}/api/auth/get-session`);
    expect(await session.json()).toBeNull();
    expect(submissions).toEqual([]);
  });
});
