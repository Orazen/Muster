/** Real wizard, account pairing and offline task acceptance. Draft migration
 * alone seeds sessionStorage; auth and successful writes use the owned server. */
import { randomUUID } from "node:crypto";
import type { Locator, Page, Request, TestInfo } from "@playwright/test";
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

const setupLabels = ["Welcome", "Tour", "Engines", "Phone", "Teammate", "Permissions", "First task"];
const shortViewport = { width: 320, height: 568 };
const wideViewport = { width: 1440, height: 900 };

function setupShell(page: Page): Locator {
  return page.getByRole("region", { name: "Set up Muster", exact: true });
}

async function savedDraft(page: Page, accountId: string): Promise<string | null> {
  return page.evaluate((id) => sessionStorage.getItem(`muster:onboarding-draft:v2:${encodeURIComponent(id)}`), accountId);
}

async function expectStage(page: Page, label: string, focused = false): Promise<void> {
  const shell = setupShell(page);
  await expect(shell).toBeVisible();
  const progress = shell.getByRole("list", { name: "Setup progress", exact: true });
  expect(await progress.evaluate((node) => node.tagName)).toBe("OL");
  await expect(progress.getByRole("listitem")).toHaveCount(setupLabels.length);
  const current = progress.locator('[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText(label);
  const index = setupLabels.indexOf(label);
  expect(index).toBeGreaterThanOrEqual(0);
  await expect(progress.getByRole("listitem").nth(index)).toHaveAttribute("aria-current", "step");
  const title = shell.getByTestId("onboarding-stage-title");
  await expect(title).toHaveRole("heading");
  await expect(title).toHaveText(label);
  await expect(title).toHaveAttribute("tabindex", "-1");
  await expect(shell.getByText(`Step ${index + 1} of 7`, { exact: true })).toBeVisible();
  if (focused) await expect(title).toBeFocused();
}

async function expectWithinViewport(surface: Locator): Promise<void> {
  await expect(surface).toBeVisible();
  const bounds = await surface.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(-1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
  expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.width + 1);
}

/** Observation only: notably does NOT scroll/focus a newly shown error to
 * repair the behavior being tested. Insets avoid rounded-corner hit gaps. */
async function expectUncovered(element: Locator): Promise<void> {
  await expectWithinViewport(element);
  const result = await element.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const xInset = Math.min(8, r.width / 4), yInset = Math.min(8, r.height / 4);
    const points = [
      [r.left + xInset, r.top + yInset], [r.right - xInset, r.top + yInset],
      [r.left + xInset, r.bottom - yInset], [r.right - xInset, r.bottom - yInset],
    ];
    return { width: r.width, height: r.height, uncovered: points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === node || node.contains(hit));
    }) };
  });
  expect(result.width).toBeGreaterThan(0);
  expect(result.height).toBeGreaterThan(0);
  expect(result.uncovered, "Content must not be clipped by its scroll area or covered by another surface").toBe(true);
}

/** Vertical content scrolling and horizontal identity pickers are legitimate.
 * This measures real controls after Playwright's ordinary scroll-into-view.
 *
 * A real wheel keeps driving the container after its offset first reads the
 * target: Chromium clamps the offset at the edge while the gesture's scroll
 * animation is still running, so a programmatic scroll that lands in that
 * tail is pulled straight back under the scrollport — the swiped-up screen
 * keeps travelling. Playwright's own actionability re-scrolls and re-checks
 * the hit target for this reason; do the same, bounded, so the assertions
 * below sample where the control actually rests instead of a frame the
 * browser is still animating. A control that cannot be brought out from
 * under its own scroll area still fails them. */
async function expectControlReachable(control: Locator): Promise<void> {
  await expect(control).toBeEnabled();
  const deadline = Date.now() + 5_000;
  for (;;) {
    await control.scrollIntoViewIfNeeded();
    if (await scrollHeld(control)) break;
    if (Date.now() >= deadline) break;
  }
  await expectUncovered(control);
  await control.click({ trial: true });
}

/** A single sample cannot tell a held scroll from an animating one: require
 * the control to stay entirely inside both its scroll area and the window,
 * with its offset, its content height and the port's own box unchanged, for
 * a window long enough to span the animation's own ticks. Headless Chromium
 * does not vsync-lock animation frames, so counting frames reads the gap
 * between two ticks as rest; the window is measured in milliseconds. */
const settleWindowMs = 200;

async function scrollHeld(control: Locator): Promise<boolean> {
  return control.evaluate(async (node, settleMs) => {
    const frame = () => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const read = () => {
      const r = node.getBoundingClientRect();
      let scroller: HTMLElement | null = node.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
      const s = scroller?.getBoundingClientRect();
      const inside = r.top >= -0.5 && r.bottom <= innerHeight + 0.5
        && (!s || (r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5));
      return { inside, key: [r.top, r.bottom, scroller?.scrollTop, scroller?.scrollHeight, s?.top, s?.bottom].join("/") };
    };
    const began = performance.now();
    let stableSince = began;
    let previous = read();
    if (!previous.inside) return false;
    for (;;) {
      await frame();
      const now = performance.now();
      const current = read();
      if (!current.inside) return false;
      if (current.key !== previous.key) {
        previous = current;
        stableSince = now;
        continue;
      }
      if (now - stableSince >= settleMs) return true;
      if (now - began >= 1_000) return false;
    }
  }, settleWindowMs);
}

/** No locator.focus(): traversal starts from the actual current focus and
 * fails if any Tab escapes to the covered app or misses the target. */
async function tabTo(page: Page, target: Locator, surface = setupShell(page)): Promise<void> {
  await expect(target).toBeVisible();
  for (let index = 0; index < 80; index += 1) {
    if (await target.evaluate((node) => document.activeElement === node)) return;
    await page.keyboard.press("Tab");
    expect(await surface.evaluate((node) => node.contains(document.activeElement)),
      "Tab stays within the active setup surface").toBe(true);
  }
  throw new Error("Target was not keyboard reachable within 80 Tab presses");
}

async function keyboardActivate(page: Page, button: Locator): Promise<void> {
  await tabTo(page, button);
  await expect(button).toBeFocused();
  await expect(button).toBeEnabled();
  // Browser keyboard navigation itself must have revealed the control.
  await expectUncovered(button);
  await page.keyboard.press("Enter");
}

async function captureStageSizes(page: Page, testInfo: TestInfo, stage: string, controls: Locator[]): Promise<void> {
  for (const viewport of [shortViewport, wideViewport]) {
    await page.setViewportSize(viewport);
    const scroll = setupShell(page).getByTestId("onboarding-stage-scroll");
    // Real wheel input over the scroll area's padding, not a DOM scrollTop
    // assignment. Nested engine/picker scrolling is left untouched.
    await scroll.hover({ position: { x: 4, y: 4 } });
    await page.mouse.wheel(0, -10_000);
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(0);
    await captureWizard(page, testInfo, `${stage}-${viewport.width}.png`);
    for (const control of controls) await expectControlReachable(control);
  }
  await page.setViewportSize(shortViewport);
}

async function captureWizard(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  // Wait for the real 180ms entrance, without overriding product CSS. A
  // mid-animation screenshot is not evidence of the settled text contrast.
  await expect(page.locator("fieldset.wizard-step")).toHaveCSS("opacity", "1");
  await expect(page.locator("fieldset.wizard-step")).toHaveCSS("transform", "none");
  const panel = setupShell(page).locator(".tour-panel");
  if (await panel.count()) {
    await expect(panel).toHaveCSS("opacity", "1");
    // The normal filled keyframe serializes translateX(0) as an identity
    // matrix. Require zero spatial displacement, without suppressing motion.
    await expect.poll(() => panel.evaluate((node) =>
      new DOMMatrixReadOnly(getComputedStyle(node).transform).isIdentity)).toBe(true);
  }
  await expectWithinViewport(setupShell(page));
  await expectWithinViewport(setupShell(page).locator(".onboarding-frame"));
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
  await expectStage(page, "Permissions");
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
  await page.setViewportSize(shortViewport);
  const writes = observeTaskWrites(page, harness.desktopUrl);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const { id } = await account(page, harness.desktopUrl);
  await captureStageSizes(page, testInfo, "welcome", [
    page.getByLabel("Your name", { exact: true }), page.getByLabel("Email address", { exact: true }),
    page.getByRole("button", { name: "Continue", exact: true }),
  ]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectStage(page, "Tour");
  await captureStageSizes(page, testInfo, "tour", [page.getByRole("button", { name: "Skip tour", exact: true })]);
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await expectStage(page, "Engines");
  await captureStageSizes(page, testInfo, "engines", [page.getByRole("button", { name: "Set up later", exact: true })]);
  await page.getByRole("button", { name: "Set up later", exact: true }).click();
  await expectStage(page, "Phone");
  await captureStageSizes(page, testInfo, "phone", [page.getByRole("button", { name: "Not now", exact: true })]);
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expectStage(page, "Teammate");
  const teammateName = "Field Scout — research and weekly planning";
  await page.getByLabel("Teammate name", { exact: true }).fill(teammateName);
  const role = "Research — café, market notes and weekly planning for a small independent team";
  await page.getByLabel("Teammate role (optional)", { exact: true }).fill(role);
  await page.getByRole("button", { name: "heart", exact: true }).click();
  await page.getByRole("button", { name: "teal", exact: true }).click();
  await page.getByRole("button", { name: "Tune its personality (optional)", exact: true }).click();
  await page.getByRole("slider", { name: "Companion to Coworker", exact: true }).fill("73");
  await captureStageSizes(page, testInfo, "teammate-expanded", [
    page.getByLabel("Teammate name", { exact: true }), page.getByLabel("Teammate role (optional)", { exact: true }),
    page.getByRole("slider", { name: "Companion to Coworker", exact: true }),
    page.getByRole("button", { name: "Continue", exact: true }),
  ]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectSavedStep(page, id, "permissions");
  await page.reload();
  await expectStage(page, "Permissions", true);
  await captureStageSizes(page, testInfo, "permissions", [
    page.getByRole("button", { name: "Back", exact: true }), page.getByRole("button", { name: "Continue", exact: true }),
  ]);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Teammate name", { exact: true })).toHaveValue(teammateName);
  await expect(page.getByLabel("Teammate role (optional)", { exact: true })).toHaveValue(role);
  await expect(page.getByRole("button", { name: "heart", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "teal", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Companion to Coworker", exact: true })).toHaveValue("73");
  await toFirstTask(page, teammateName);
  const raw = "  Keep my résumé draft exactly as entered  ";
  await page.getByPlaceholder(taskPlaceholder, { exact: true }).fill(raw);
  await expectSavedTask(page, id, raw);
  await page.reload();
  await expectStage(page, "First task", true);
  await expect(page.getByRole("heading", { name: `Give ${teammateName} a first task`, exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(raw);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(raw);
  await captureStageSizes(page, testInfo, "first-task", [
    page.getByPlaceholder(taskPlaceholder, { exact: true }), page.getByRole("button", { name: "Back", exact: true }),
    page.getByRole("button", { name: `Muster ${teammateName} →`, exact: true }),
  ]);
  await page.setViewportSize(wideViewport);
  await page.reload();
  await expect(page.getByRole("heading", { name: `Give ${teammateName} a first task`, exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(raw);
  await captureWizard(page, testInfo, "first-task-reloaded-1440.png");
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
  await page.setViewportSize(shortViewport);
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
  // The guide's face reads the failure as its honest beat: the component's
  // "thinking" prop maps to the bot-avatars canvas' "working" draw state.
  await expect(setupShell(page).locator('.onboarding-guide-flower canvas[data-bot-avatar][data-state="working"]')).toHaveCount(1);
  const alert = setupShell(page).getByRole("alert");
  await expect(alert).toHaveText("Owned fixture: first task was not sent. Please retry.");
  // These checks precede any test scrolling, focus call or draft edit.
  // Full text and its alert box must already be visible in the short viewport.
  await expect(alert).toBeFocused();
  await expectUncovered(alert);
  await expectUncovered(alert.getByText("Owned fixture: first task was not sent. Please retry.", { exact: true }));
  await captureWizard(page, testInfo, "first-task-failed-send-auto-reveal-320.png");
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(`  ${task}  `);
  await expectSavedTask(page, id, `  ${task}  `);
  expect(writes).toHaveLength(1);
  // The intercepted request never reached the server. The actual roster,
  // rather than the synthetic failure body, establishes no accepted user row.
  await expectNoUserMessages(page, harness.desktopUrl);
  // Tab from the alert into the real form. No synthetic focus repair and
  // no Enter on any suggestion/skip action that would alter or submit it.
  const draft = page.getByPlaceholder(taskPlaceholder, { exact: true });
  const back = page.getByRole("button", { name: "Back", exact: true });
  const retry = page.getByRole("button", { name: "Muster Template Scout →", exact: true });
  await tabTo(page, draft);
  await expectUncovered(draft);
  await draft.fill(`  ${task} — edited during recovery  `);
  await expectSavedTask(page, id, `  ${task} — edited during recovery  `);
  await expect(draft).toBeFocused();
  await expect(alert).not.toBeFocused();
  await draft.fill(`  ${task}  `);
  await expectSavedTask(page, id, `  ${task}  `);
  await expect(draft).toBeFocused();
  await tabTo(page, back);
  await expectUncovered(back);
  await tabTo(page, retry);
  await expectUncovered(retry);
  await captureWizard(page, testInfo, "first-task-failed-send-keyboard-retry-320.png");
  expect(writes).toHaveLength(1);
  await page.reload();
  await expect(page.getByPlaceholder(taskPlaceholder, { exact: true })).toHaveValue(`  ${task}  `);
  expect(writes).toHaveLength(1);
  await expectStage(page, "First task", true);
  await tabTo(page, page.getByRole("button", { name: "Back", exact: true }));
  await expectUncovered(page.getByRole("button", { name: "Back", exact: true }));
  await tabTo(page, retry);
  await expectUncovered(retry);
  expect(writes).toHaveLength(1);
  const accepted = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).origin === harness.desktopUrl && /\/api\/bots\/[^/]+\/messages$/.test(new URL(response.url()).pathname), { timeout: 15_000 });
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
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


test("setup progress, keyboard focus and provider Settings preserve the current account draft", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage();
  await page.setViewportSize(shortViewport);
  const writes = observeTaskWrites(page, harness.desktopUrl);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const { id } = await account(page, harness.desktopUrl);
  const shell = setupShell(page);
  const button = (name: string) => shell.getByRole("button", { name, exact: true });
  await expectStage(page, "Welcome", true);

  // Both wrap directions and reverse navigation from the non-tabbable
  // stage heading must stay inside setup. No underlying app click is made.
  await page.keyboard.press("Shift+Tab");
  await expect(button("Maybe later")).toBeFocused();
  await page.keyboard.press("Tab");
  const name = shell.getByLabel("Your name", { exact: true });
  await expect(name).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(button("Maybe later")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  await name.fill("  A careful setup owner  ");
  await expect.poll(async () => JSON.parse(await savedDraft(page, id) ?? "null")).toMatchObject({ name: "  A careful setup owner  " });
  await expect(name).toBeFocused(); // Same-step state/save rerender must not steal focus.

  await keyboardActivate(page, button("Continue"));
  await expectStage(page, "Tour", true);
  await keyboardActivate(page, button("Back"));
  await expectStage(page, "Welcome", true);
  await expect(name).toHaveValue("  A careful setup owner  ");
  await keyboardActivate(page, button("Continue"));
  await expectStage(page, "Tour", true);
  await keyboardActivate(page, button("Skip tour"));
  await expectStage(page, "Engines", true);
  await expectSavedStep(page, id, "engines");
  const beforeSettings = await savedDraft(page, id);
  expect(beforeSettings).not.toBeNull();
  const settingsWrites: string[] = [];
  const observeSettings = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === harness.desktopUrl && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      settingsWrites.push(`${request.method()} ${url.pathname}`);
    }
  };
  page.on("request", observeSettings);
  const providerButton = button("Add a provider key");
  await keyboardActivate(page, providerButton);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel("Settings section", { exact: true })).toHaveValue("providers");
  await expect(settings).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await settings.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expectStage(page, "Engines");
  await expect(providerButton).toBeFocused();
  expect(await savedDraft(page, id)).toBe(beforeSettings);
  expect(settingsWrites, "Opening/closing provider Settings must not save a key, change auth or abandon setup").toEqual([]);
  page.off("request", observeSettings);
  await captureWizard(page, testInfo, "engines-after-provider-settings-escape-320.png");

  await keyboardActivate(page, button("Set up later"));
  await expectStage(page, "Phone", true);
  await keyboardActivate(page, button("Not now"));
  await expectStage(page, "Teammate", true);
  const teammate = shell.getByLabel("Teammate name", { exact: true });
  await tabTo(page, teammate);
  await teammate.fill("Focus Scout");
  await expect(teammate).toBeFocused();
  await keyboardActivate(page, button("Continue"));
  await expectStage(page, "Permissions", true);
  await keyboardActivate(page, button("Continue"));
  await expectStage(page, "First task", true);
  const draft = page.getByPlaceholder(taskPlaceholder, { exact: true });
  const raw = "  A deliberate first task — café  ";
  await tabTo(page, draft);
  await draft.fill(raw);
  await expectSavedTask(page, id, raw);
  await expect(draft).toBeFocused();
  await keyboardActivate(page, button("Back"));
  await expectStage(page, "Permissions", true);
  await keyboardActivate(page, button("Continue"));
  await expectStage(page, "First task", true);
  await expect(draft).toHaveValue(raw);
  await page.reload();
  await expectStage(page, "First task", true);
  await expect(draft).toHaveValue(raw);
  await tabTo(page, button("Muster Focus Scout →"));
  await expectUncovered(button("Muster Focus Scout →"));
  await captureWizard(page, testInfo, "first-task-restored-keyboard-focus-320.png");
  expect(writes).toEqual([]);
  await expectNoUserMessages(page, harness.desktopUrl);
});

test("reduced-motion tour stays still and manual navigation preserves an unsent exact draft", async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
  const page = await newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(wideViewport);
  const writes = observeTaskWrites(page, harness.desktopUrl);
  await pairDesktop(page, harness, pairCodeFromCloud);
  const { id } = await account(page, harness.desktopUrl);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const shell = setupShell(page);
  await expectStage(page, "Welcome", true);
  await expect(shell).toHaveCSS("animation-name", "none");
  await expect(shell.locator(".onboarding-frame")).toHaveCSS("animation-name", "none");
  await expect(shell.locator("fieldset.wizard-step")).toHaveCSS("animation-name", "none");
  await shell.getByRole("button", { name: "Continue", exact: true }).click();
  await expectStage(page, "Tour", true);
  const panel = shell.locator(".tour-panel");
  const panelOne = shell.getByRole("button", { name: "Tour panel 1: Every chat is a real agent", exact: true });
  const panelTwo = shell.getByRole("button", { name: "Tour panel 2: They have hands", exact: true });
  const panelFour = shell.getByRole("button", { name: "Tour panel 4: Put bots in a room", exact: true });
  await expect(panelOne).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toHaveCSS("animation-name", "none");
  await expect(panel).toHaveCSS("transform", "none");
  const initialPanel = await panel.innerText();
  // An intentional bounded temporal assertion against the actual 3,600ms
  // product interval. No fake clocks, CSS overrides or invented server result.
  await page.waitForTimeout(4_000);
  await expect(panelOne).toHaveAttribute("aria-pressed", "true");
  expect(await panel.innerText()).toBe(initialPanel);
  await shell.getByRole("button", { name: "Next", exact: true }).click();
  await expect(panelTwo).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByText("They have hands", { exact: true })).toBeVisible();
  await expectStage(page, "Tour");
  await panelFour.click();
  await expect(panelFour).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByText("Put bots in a room", { exact: true })).toBeVisible();
  await expect(panelFour).toBeFocused(); // Panel state changes are not stage focus changes.
  await expect(panel).toHaveCSS("animation-name", "none");
  await captureWizard(page, testInfo, "reduced-motion-manual-tour-1440.png");
  await shell.getByRole("button", { name: "Skip tour", exact: true }).click();
  await shell.getByRole("button", { name: "Set up later", exact: true }).click();
  await shell.getByRole("button", { name: "Not now", exact: true }).click();
  await toFirstTask(page, "Quiet Scout");
  const raw = "  Keep this exact reduced-motion task — café  ";
  const draft = page.getByPlaceholder(taskPlaceholder, { exact: true });
  await draft.fill(raw);
  await expectSavedTask(page, id, raw);
  await page.setViewportSize(shortViewport);
  await page.reload();
  await expectStage(page, "First task", true);
  await expect(draft).toHaveValue(raw);
  await expect(shell.locator("fieldset.wizard-step")).toHaveCSS("animation-name", "none");
  await expectControlReachable(draft);
  await expectControlReachable(shell.getByRole("button", { name: "Muster Quiet Scout →", exact: true }));
  await captureWizard(page, testInfo, "reduced-motion-unsent-first-task-320.png");
  expect(writes).toEqual([]);
  await expectNoUserMessages(page, harness.desktopUrl);
});
