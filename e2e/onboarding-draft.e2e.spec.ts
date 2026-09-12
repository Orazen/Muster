/** Real wizard, account pairing and offline task acceptance. Draft migration
 * alone seeds sessionStorage; auth and successful writes use the owned server. */
import { randomUUID } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { z } from "zod";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";
import type { PairingHarness } from "./pairing-harness.ts";

const taskPlaceholder = "Or type your own first task…";
const fieldBrief = "Put together a quick brief on what's new in my field right now.";
const sessionSchema = z.object({ user: z.object({ id: z.string().min(1), email: z.string() }) });
const rosterSchema = z.object({ bots: z.array(z.object({
  id: z.string(), character: z.string(), messages: z.array(z.object({ role: z.string(), text: z.string().optional() })),
})) });

async function account(page: Page, origin: string) {
  const response = await page.context().request.get(`${origin}/api/auth/get-session`, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  return sessionSchema.parse(await response.json()).user;
}

function observeTaskWrites(page: Page, origin: string) {
  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "POST"
      && /^\/api\/bots\/[^/]+\/(messages|task|cards\/[^/]+\/answer(?:\/start)?)$/.test(url.pathname)) {
      writes.push(url.pathname);
    }
  });
  return writes;
}

async function expectNoUserMessages(page: Page, origin: string): Promise<void> {
  const response = await page.context().request.get(`${origin}/api/bots`, { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const roster = rosterSchema.parse(await response.json());
  expect(roster.bots.flatMap((bot) => bot.messages.filter((message) => message.role === "user"))).toEqual([]);
}

async function expectSavedStep(page: Page, accountId: string, step: string): Promise<void> {
  await expect.poll(async () => {
    const raw = await page.evaluate((id) => sessionStorage.getItem(`muster:onboarding-draft:v2:${encodeURIComponent(id)}`), accountId);
    return JSON.parse(raw ?? "null");
  }).toMatchObject({ version: 2, step });
}

async function expectSavedTask(page: Page, accountId: string, customTask: string): Promise<void> {
  await expect.poll(async () => {
    const raw = await page.evaluate((id) => sessionStorage.getItem(`muster:onboarding-draft:v2:${encodeURIComponent(id)}`), accountId);
    return JSON.parse(raw ?? "null");
  }).toMatchObject({ version: 2, step: "first-task", customTask });
}

async function captureWizard(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  // Wait for the real 180ms entrance, without overriding product CSS. A
  // mid-animation screenshot is not evidence of the settled text contrast.
  await expect(page.locator("fieldset.wizard-step")).toHaveCSS("opacity", "1");
  await expect(page.locator("fieldset.wizard-step")).toHaveCSS("transform", "none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(filename) });
}

async function toTeammate(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Welcome to Muster", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.getByRole("button", { name: "Set up later", exact: true }).click();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.getByLabel("Teammate name", { exact: true })).toBeVisible();
}

async function toFirstTask(page: Page, name: string): Promise<void> {
  await page.getByLabel("Teammate name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toBeVisible();
}

async function cloudCode(page: Page, origin: string, email: string, password: string): Promise<string> {
  await page.goto(`${origin}/pair`);
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with email", exact: true }).click();
  await expect(page.getByText(`Signed in as ${email}.`, { exact: true })).toBeVisible();
  const input = page.getByLabel("Pairing code", { exact: true });
  await expect(input).toHaveValue(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  return input.inputValue();
}

async function connect(page: Page, harness: PairingHarness, code: string, email: string, next = "/app"): Promise<string> {
  await page.goto(`${harness.desktopUrl}/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page).toHaveURL(harness.desktopUrl + next);
  const user = await account(page, harness.desktopUrl);
  expect(user.email).toBe(email);
  return user.id;
}

async function switchOut(page: Page, origin: string): Promise<void> {
  // Navigation preserves this tab's sessionStorage. Escape deliberately
  // abandons onboarding, so it would invalidate the account-isolation proof.
  await page.goto(`${origin}/sign-in`);
  await page.getByRole("button", { name: "Use another account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use another account", exact: true })).toHaveCount(0);
  const response = await page.context().request.get(`${origin}/api/auth/get-session`, { maxRedirects: 0 });
  expect(await response.json()).toBeNull();
}

test("Permissions and First task retain exact draft fields across reload at 320px", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage();
  await page.setViewportSize({ width: 320, height: 760 });
  const writes = observeTaskWrites(page, harness.desktopUrl);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const { id } = await account(page, harness.desktopUrl);
  await toTeammate(page);
  await page.getByLabel("Teammate name", { exact: true }).fill("Field Scout");
  await page.getByLabel("Teammate role (optional)", { exact: true }).fill("Research — café");
  await page.getByRole("button", { name: "heart", exact: true }).click();
  await page.getByRole("button", { name: "teal", exact: true }).click();
  await page.getByRole("button", { name: "Tune its personality (optional)", exact: true }).click();
  await page.getByRole("slider", { name: "Companion to Coworker", exact: true }).fill("73");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSavedStep(page, id, "permissions");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await expect(page.getByLabel("Step 6 of 7: Permissions", { exact: true })).toBeVisible();
  await captureWizard(page, testInfo, "permissions-320.png");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Teammate name", { exact: true })).toHaveValue("Field Scout");
  await expect(page.getByLabel("Teammate role (optional)", { exact: true })).toHaveValue("Research — café");
  await expect(page.getByRole("button", { name: "heart", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "teal", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Companion to Coworker", exact: true })).toHaveValue("73");
  await toFirstTask(page, "Field Scout");
  const raw = "  Keep my résumé draft exactly as entered  ";
  await page.getByPlaceholder(taskPlaceholder, { exact: true }).fill(raw);
  await expectSavedTask(page, id, raw);
  await page.reload();
  await expect(page.getByLabel("Step 7 of 7: First task", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Give Field Scout a first task", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(raw);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(raw);
  await captureWizard(page, testInfo, "first-task-320.png");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Give Field Scout a first task", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(raw);
  await captureWizard(page, testInfo, "first-task-1280.png");
  expect(writes).toEqual([]);
  await expectNoUserMessages(page, harness.desktopUrl);
});

test("ambiguous legacy step restarts review and preserves saved fields", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  const writes = observeTaskWrites(page, harness.desktopUrl);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const { id } = await account(page, harness.desktopUrl);
  await expectSavedStep(page, id, "welcome");
  // An actual old-format persisted draft, not the current serializer. No
  // cookies, auth state, server messages or successful responses are injected.
  await page.evaluate((accountId) => {
    sessionStorage.removeItem(`muster:onboarding-draft:v2:${encodeURIComponent(accountId)}`);
    sessionStorage.setItem(`muster:onboarding-draft:v1:${encodeURIComponent(accountId)}`, JSON.stringify({
      version: 1, step: 4, name: "Legacy Owner", email: "legacy@draft.example.test",
      botName: "Saved Scout", botRole: "Local research", botColor: "purple", botCharacter: "heart",
      suggestion: "", customTask: "  Preserve the saved legacy task  ", showPersonality: true,
      axes: { companion: 62, tone: 44, independence: 38, depth: 71, honesty: 53 },
    }));
  }, id);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome to Muster", exact: true })).toBeVisible();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue("Legacy Owner");
  await expect(page.getByLabel("Email address", { exact: true })).toHaveValue("legacy@draft.example.test");
  await expectSavedStep(page, id, "welcome");
  await toTeammate(page);
  await expect(page.getByLabel("Teammate name", { exact: true })).toHaveValue("Saved Scout");
  await expect(page.getByLabel("Teammate role (optional)", { exact: true })).toHaveValue("Local research");
  await expect(page.getByRole("button", { name: "purple", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "heart", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Companion to Coworker", exact: true })).toHaveValue("62");
  await expect(page.getByRole("slider", { name: "Concise to Thorough", exact: true })).toHaveValue("71");
  await toFirstTask(page, "Saved Scout");
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue("  Preserve the saved legacy task  ");
  expect(writes).toEqual([]);
  await expectNoUserMessages(page, harness.desktopUrl);
});

test("account switching in one tab isolates and restores each account draft", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  const writes = observeTaskWrites(page, harness.desktopUrl);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const first = await account(page, harness.desktopUrl);
  await toTeammate(page);
  await toFirstTask(page, "Account A Scout");
  await page.getByPlaceholder(taskPlaceholder, { exact: true }).fill("Only account A should see this task");
  await expectSavedTask(page, first.id, "Only account A should see this task");
  await switchOut(page, harness.desktopUrl);

  const secondEmail = `draft-${randomUUID()}@example.test`;
  const secondPassword = randomUUID() + randomUUID();
  const signup = await page.context().request.post(`${harness.cloudUrl}/api/auth/sign-up/email`, {
    data: { email: secondEmail, password: secondPassword, name: "Other Draft Owner" },
    headers: { origin: harness.cloudUrl }, maxRedirects: 0,
  });
  expect(signup.status()).toBe(200);
  const secondCode = await cloudCode(await newPage(), harness.cloudUrl, secondEmail, secondPassword);
  const secondId = await connect(page, harness, secondCode, secondEmail);
  expect(secondId).not.toBe(first.id);
  await toTeammate(page);
  await expect(page.getByLabel("Teammate name", { exact: true })).toHaveValue("");
  await toFirstTask(page, "Account B Scout");
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue("");
  await page.getByPlaceholder(taskPlaceholder, { exact: true }).fill("Only account B should see this task");
  await expectSavedTask(page, secondId, "Only account B should see this task");
  await switchOut(page, harness.desktopUrl);

  const firstCode = await cloudCode(await newPage(), harness.cloudUrl, harness.email, harness.password);
  expect(await connect(page, harness, firstCode, harness.email)).toBe(first.id);
  await expect(page.getByRole("heading", { name: "Give Account A Scout a first task", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue("Only account A should see this task");
  await page.reload();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue("Only account A should see this task");
  expect(writes).toEqual([]);
  await expectNoUserMessages(page, harness.desktopUrl);
});

test("template needs explicit finish and a failed send retains the draft for manual retry", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage({ messageSend503: true });
  const writes = observeTaskWrites(page, harness.desktopUrl);
  // The template must precede the first wizard mount. A prior /app visit
  // already saves a blank draft, which correctly takes priority over a URL.
  const id = await connect(page, harness, pairCodeFromCloud, harness.email, "/app?template=field-brief");
  await toTeammate(page);
  await toFirstTask(page, "Template Scout");
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(fieldBrief);
  await expectSavedStep(page, id, "first-task");
  await page.reload();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(fieldBrief);
  await page.getByPlaceholder(taskPlaceholder, { exact: true }).fill("An edited template");
  await page.getByPlaceholder(taskPlaceholder, { exact: true }).fill("");
  await expectSavedTask(page, id, "");
  await page.goto(`${harness.desktopUrl}/app?template=weekly-priorities`);
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue("");
  expect(writes).toEqual([]);
  await expectNoUserMessages(page, harness.desktopUrl);

  const task = `Explicit onboarding task ${randomUUID()}`;
  await page.getByPlaceholder(taskPlaceholder, { exact: true }).fill(`  ${task}  `);
  await expectSavedTask(page, id, `  ${task}  `);
  const failed = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).origin === harness.desktopUrl && /\/api\/bots\/[^/]+\/messages$/.test(new URL(response.url()).pathname), { timeout: 15_000 });
  await page.getByRole("button", { name: "Muster Template Scout →", exact: true }).click();
  expect((await failed).status()).toBe(503);
  await expect(page.getByRole("alert")).toHaveText("Owned fixture: first task was not sent. Please retry.");
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(`  ${task}  `);
  await expectSavedTask(page, id, `  ${task}  `);
  expect(writes).toHaveLength(1);
  // The intercepted request never reached the server. The actual roster,
  // rather than the synthetic failure body, establishes no accepted user row.
  await expectNoUserMessages(page, harness.desktopUrl);
  await captureWizard(page, testInfo, "first-task-failed-send.png");
  await page.reload();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(`  ${task}  `);
  expect(writes).toHaveLength(1);
  const accepted = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).origin === harness.desktopUrl && /\/api\/bots\/[^/]+\/messages$/.test(new URL(response.url()).pathname), { timeout: 15_000 });
  await page.getByRole("button", { name: "Muster Template Scout →", exact: true }).click();
  expect((await accepted).status()).toBe(202);
  const row = page.locator("[data-mid]").filter({ hasText: task });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(task, { exact: true })).toBeVisible();
  const replyRow = page.locator("[data-mid]").filter({ hasText: "hello from fake acp" });
  await expect(replyRow).toHaveCount(1);
  await expect(replyRow.getByText("hello from fake acp", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  await page.reload();
  await expect(row).toHaveCount(1);
  await expect(replyRow).toHaveCount(1);
  expect(writes).toHaveLength(2);
  expect(await page.evaluate((accountId) => sessionStorage.getItem(`muster:onboarding-draft:v2:${encodeURIComponent(accountId)}`), id)).toBeNull();
});

test("the authenticated character route persists flower and blob and rejects unsupported choices without mutation", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  const api = page.context().request;
  const initial = await api.get(`${harness.desktopUrl}/api/bots`, { maxRedirects: 0 });
  expect(initial.status()).toBe(200);
  const roster = rosterSchema.parse(await initial.json());
  expect(roster.bots).toHaveLength(1);
  const botId = roster.bots[0].id;
  async function storedCharacter() {
    const response = await api.get(`${harness.desktopUrl}/api/bots`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    return rosterSchema.parse(await response.json()).bots.find((bot) => bot.id === botId)?.character;
  }
  for (const character of ["flower", "blob"]) {
    const response = await api.patch(`${harness.desktopUrl}/api/bots/${botId}`, { data: { character }, maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ bot: { id: botId, character } });
    expect(await storedCharacter()).toBe(character);
  }
  // APIRequestContext deliberately observes the real rejection; there is
  // no browser console exemption and no intercepted success response.
  for (const character of ["not-a-character", "lottie"]) {
    const response = await api.patch(`${harness.desktopUrl}/api/bots/${botId}`, { data: { character }, maxRedirects: 0 });
    expect(response.status()).toBe(400);
    expect(await storedCharacter()).toBe("blob");
  }
  const restored = await api.patch(`${harness.desktopUrl}/api/bots/${botId}`, { data: { character: "flower" }, maxRedirects: 0 });
  expect(restored.status()).toBe(200);
  expect(await storedCharacter()).toBe("flower");
  await expectNoUserMessages(page, harness.desktopUrl);
});
