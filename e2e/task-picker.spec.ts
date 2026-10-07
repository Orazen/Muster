/** Task naming must be reachable independently of selecting its conversation.
 * All actions use owned synthetic accounts, real task routes and real UI. */
import { randomUUID } from "node:crypto";
import type { Page, Request } from "@playwright/test";
import { test, expect, pairDesktop } from "./browser-fixtures.ts";

interface TaskRecord { threadId: string; title: string }
interface TaskBot { id: string; threadId: string; tasks: TaskRecord[] }

test.afterEach(async ({ harness }, testInfo) => {
  await testInfo.attach("owned-task-harness", {
    body: JSON.stringify({ rootDirectory: harness.rootDirectory, cloudUrl: harness.cloudUrl, desktopUrl: harness.desktopUrl }),
    contentType: "application/json",
  });
});

async function createSecondTask(page: Page): Promise<TaskBot> {
  const response = page.waitForResponse((reply) => reply.request().method() === "POST"
    && /^\/api\/bots\/[^/]+\/tasks$/.test(new URL(reply.url()).pathname));
  await page.getByRole("button", { name: "Task", exact: true }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  const { bot }: { bot: TaskBot } = await created.json();
  expect(bot.tasks).toHaveLength(2);
  expect(new Set(bot.tasks.map((task) => task.threadId)).size).toBe(2);
  return bot;
}

function watchTaskRequests(page: Page, bot: TaskBot): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/bots/${bot.id}/tasks`)) requests.push(request);
  });
  return requests;
}

for (const inputMethod of ["pointer", "keyboard"] as const) {
  test(`${inputMethod} rename targets an inactive task exactly once and persists after reload`, async ({ harness, newPage, pairCodeFromCloud }, testInfo) => {
    const page = await newPage();
    await pairDesktop(page, harness, pairCodeFromCloud);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    const bot = await createSecondTask(page);
    const targetIndex = bot.tasks.findIndex((task) => task.threadId !== bot.threadId);
    const target = bot.tasks[targetIndex];
    const active = bot.tasks.find((task) => task.threadId === bot.threadId)!;
    const requests = watchTaskRequests(page, bot);
    const picker = page.locator(".task-picker");
    await picker.getByRole("button", { name: "Switch task", exact: true }).click();
    const dialog = picker.getByRole("dialog", { name: "Tasks", exact: true });
    const rename = dialog.getByRole("button", { name: /^Rename task / }).nth(targetIndex);
    await expect(rename).toHaveAccessibleName(`Rename task ${target.title}`);
    if (inputMethod === "keyboard") {
      await rename.focus();
      await rename.press("Enter");
    } else await rename.click();
    const edit = dialog.getByRole("textbox");
    await expect(edit).toHaveValue(target.title);
    await expect(edit).toBeFocused();
    await expect(picker.getByRole("button", { name: "Switch task", exact: true })).toContainText(active.title);

    if (inputMethod === "keyboard") {
      await edit.fill(`Cancelled ${randomUUID()}`);
      await edit.press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await picker.getByRole("button", { name: "Switch task", exact: true }).click();
      await expect(dialog.getByRole("button", { name: /^Rename task / }).nth(targetIndex))
        .toHaveAccessibleName(`Rename task ${target.title}`);
      expect(requests.filter((request) => request.method() === "PATCH")).toHaveLength(0);
      await dialog.getByRole("button", { name: /^Rename task / }).nth(targetIndex).focus();
      await dialog.getByRole("button", { name: /^Rename task / }).nth(targetIndex).press("Enter");
    }

    const title = `Named ${randomUUID()}`;
    const expectedPath = `/api/bots/${bot.id}/tasks/${target.threadId}`;
    const response = page.waitForResponse((reply) => reply.request().method() === "PATCH"
      && new URL(reply.url()).pathname === expectedPath);
    await edit.fill(title);
    await edit.press("Enter");
    const renamed = await response;
    expect(renamed.status()).toBe(200);
    expect((await renamed.json()).task).toMatchObject({ threadId: target.threadId, title });
    await expect(dialog.getByRole("button", { name: `Rename task ${title}`, exact: true })).toBeVisible();
    await page.reload();
    await picker.getByRole("button", { name: "Switch task", exact: true }).click();
    await expect(dialog.getByRole("button", { name: `Rename task ${title}`, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Rename task ${active.title}`, exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Switch task", exact: true })).toContainText(active.title);
    expect(requests.filter((request) => request.method() === "PATCH").map((request) => ({
      path: new URL(request.url()).pathname, body: request.postDataJSON(),
    }))).toEqual([{ path: expectedPath, body: { title } }]);
    expect(requests.filter((request) => request.method() === "POST")).toHaveLength(0);
    if (inputMethod === "pointer") {
      await dialog.getByRole("button", { name: `Rename task ${title}`, exact: true }).hover();
      await testInfo.attach("renamed-task-picker", {
        body: await page.screenshot(), contentType: "image/png",
      });
    }
  });
}

test("blank blur cancels and a nonblank blur commits only the edited task", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  const bot = await createSecondTask(page);
  const targetIndex = bot.tasks.findIndex((task) => task.threadId !== bot.threadId);
  const target = bot.tasks[targetIndex];
  const requests = watchTaskRequests(page, bot);
  const picker = page.locator(".task-picker");
  await picker.getByRole("button", { name: "Switch task", exact: true }).click();
  const dialog = picker.getByRole("dialog", { name: "Tasks", exact: true });
  await dialog.getByRole("button", { name: /^Rename task / }).nth(targetIndex).click();
  await dialog.getByRole("textbox").fill("   ");
  await dialog.getByRole("textbox").press("Tab");
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^Rename task / }).nth(targetIndex))
    .toHaveAccessibleName(`Rename task ${target.title}`);
  expect(requests.filter((request) => request.method() === "PATCH")).toHaveLength(0);
  await dialog.getByRole("button", { name: /^Rename task / }).nth(targetIndex).click();
  const title = `Blur ${randomUUID()}`;
  const expectedPath = `/api/bots/${bot.id}/tasks/${target.threadId}`;
  const response = page.waitForResponse((reply) => reply.request().method() === "PATCH"
    && new URL(reply.url()).pathname === expectedPath);
  await dialog.getByRole("textbox").fill(title);
  await dialog.getByRole("textbox").press("Tab");
  expect((await response).status()).toBe(200);
  await expect(dialog.getByRole("button", { name: `Rename task ${title}`, exact: true })).toBeVisible();
  expect(requests.filter((request) => request.method() === "PATCH").map((request) => ({
    path: new URL(request.url()).pathname, body: request.postDataJSON(),
  }))).toEqual([{ path: expectedPath, body: { title } }]);
});

test("selection, new task and deletion retain their original exact-task routes", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  const bot = await createSecondTask(page);
  const targetIndex = bot.tasks.findIndex((task) => task.threadId !== bot.threadId);
  const target = bot.tasks[targetIndex];
  const requests = watchTaskRequests(page, bot);
  const picker = page.locator(".task-picker");
  await picker.getByRole("button", { name: "Switch task", exact: true }).click();
  const dialog = picker.getByRole("dialog", { name: "Tasks", exact: true });
  const selected = page.waitForResponse((reply) => reply.request().method() === "POST"
    && new URL(reply.url()).pathname === `/api/bots/${bot.id}/tasks/${target.threadId}`);
  await dialog.getByTitle("Switch to this task", { exact: true }).nth(targetIndex).click();
  expect((await selected).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(picker.getByRole("button", { name: "Switch task", exact: true })).toContainText(target.title);
  await picker.getByRole("button", { name: "Switch task", exact: true }).click();
  const created = page.waitForResponse((reply) => reply.request().method() === "POST"
    && new URL(reply.url()).pathname === `/api/bots/${bot.id}/tasks`);
  await dialog.getByRole("button", { name: "New task", exact: true }).click();
  const createdReply = await created;
  expect(createdReply.status()).toBe(201);
  const { bot: fresh, task }: { bot: TaskBot; task: TaskRecord } = await createdReply.json();
  expect(fresh.tasks).toHaveLength(3);
  await picker.getByRole("button", { name: "Switch task", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^Rename task / })).toHaveCount(3);
  const deleteIndex = fresh.tasks.findIndex((item) => item.threadId === target.threadId);
  const deleted = page.waitForResponse((reply) => reply.request().method() === "DELETE"
    && new URL(reply.url()).pathname === `/api/bots/${bot.id}/tasks/${target.threadId}`);
  await dialog.getByRole("button", { name: "Delete task", exact: true }).nth(deleteIndex).click();
  const deletedReply = await deleted;
  expect(deletedReply.status()).toBe(200);
  expect((await deletedReply.json()).bot.tasks.map((item: TaskRecord) => item.threadId).sort())
    .toEqual(fresh.tasks.filter((item) => item.threadId !== target.threadId).map((item) => item.threadId).sort());
  await expect(dialog.getByRole("button", { name: /^Rename task / })).toHaveCount(2);
  await expect(picker.getByRole("button", { name: "Switch task", exact: true })).toContainText(task.title);
  expect(requests.filter((request) => request.method() === "POST").map((request) => new URL(request.url()).pathname))
    .toEqual([`/api/bots/${bot.id}/tasks/${target.threadId}`, `/api/bots/${bot.id}/tasks`]);
  expect(requests.filter((request) => request.method() === "DELETE").map((request) => new URL(request.url()).pathname))
    .toEqual([`/api/bots/${bot.id}/tasks/${target.threadId}`]);
  expect(requests.filter((request) => request.method() === "PATCH")).toHaveLength(0);
});
