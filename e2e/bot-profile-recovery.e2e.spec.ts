/** Older/restored records must remain usable while clients and servers update
 * independently. All records, sessions, engines and traffic below are owned. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { z } from "zod";
import { startPairingHarness } from "./pairing-harness.ts";
import { openSse } from "../server/testing/sse.ts";

const wireBotSchema = z.looseObject({ id: z.string(), threadId: z.string(), name: z.string(),
  messages: z.array(z.unknown()).optional(), tasks: z.array(z.unknown()).optional(), modelSelection: z.unknown().optional() });
const rosterSchema = z.object({ bots: z.array(wireBotSchema) });
const frameSchema = z.object({ kind: z.string(), bot: z.object({ id: z.string(), title: z.string().optional() }).optional() });

// eslint-disable-next-line anti-slop/no-unknown-parameters -- SSE frames are untrusted wire data; this function parses before inspecting them.
function isBotFrame(value: unknown, botId: string, title?: string): boolean {
  const frame = frameSchema.safeParse(value);
  return frame.success && frame.data.kind === "bot" && frame.data.bot?.id === botId
    && (title === undefined || frame.data.bot.title === title);
}

test("incomplete profiles stay usable and malformed model patches cannot corrupt a bot", async ({ browser }) => {
  const harness = await startPairingHarness();
  const context = await browser.newContext();
  const errors: string[] = [];
  let malformedRoster = false;
  let targetId = "";
  let sends = 0;
  const origin = harness.desktopUrl;
  const retainedKeys = ["activeLeafId", "activity", "busy", "createdAt", "id", "messages", "name", "tasks", "threadId"];
  try {
    await context.addInitScript(() => localStorage.setItem("muster:analytics-opt-out", "1"));
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push(`Unexpected external request: ${url.origin}${url.pathname}`); await route.abort(); return; }
      if (/^\/api\/bots\/[^/]+\/messages$/.test(url.pathname) && route.request().method() === "POST") sends++;
      if (url.pathname === "/api/bots" && route.request().method() === "GET" && malformedRoster) {
        const response = await route.fetch();
        const body = rosterSchema.parse(await response.json());
        const bots = body.bots.map(bot => bot.id === targetId
          ? Object.fromEntries(retainedKeys.filter(key => key in bot).map(key => [key, bot[key]])) : bot);
        await route.fulfill({ response, json: { ...body, bots } });
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.addLocatorHandler(page.getByRole("dialog", { name: "Product tour", exact: true }), async dialog => {
      await dialog.getByRole("button", { name: "Skip", exact: true }).click();
    });
    const signup = await context.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { origin }, data: { email: harness.email, password: harness.password, name: "Profile Recovery Fixture" },
    });
    expect(signup.status()).toBe(200);
    const readBots = async () => rosterSchema.parse(await (await context.request.get(`${origin}/api/bots`)).json()).bots;
    const target = (await readBots())[0];
    expect(target).toBeDefined();
    targetId = target.id;
    await page.goto(`${origin}/app`);
    await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
    const composer = page.getByRole("textbox", { name: /^Message / });
    await expect(composer).toBeVisible();
    const before = (await readBots()).find(bot => bot.id === targetId)!;
    await expect(page.locator("[data-mid]").first()).toBeVisible();
    const visibleMessages = await page.locator("[data-mid]").count();
    const firstMessageText = await page.locator("[data-mid]").first().innerText();
    malformedRoster = true;
    await page.reload();
    await expect(composer).toBeVisible();
    const picker = page.getByRole("button", { name: "Choose model", exact: true });
    await expect(picker).toHaveText("Choose model");
    await expect(page.locator("[data-mid]")).toHaveCount(visibleMessages);
    await expect(page.locator("[data-mid]").first()).toHaveText(firstMessageText, { useInnerText: true });
    await picker.click();
    await expect(page.getByRole("dialog", { name: "Choose model", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTitle("Bot settings", { exact: true }).first().click();
    await expect(page.getByRole("complementary", { name: "Bot settings", exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Web browser for this bot", exact: true })).toBeVisible();
    const after = (await readBots()).find(bot => bot.id === targetId)!;
    expect(after).toEqual(before); // response compatibility does not rewrite the server's saved choice
    expect(sends).toBe(0);
    expect(errors).toEqual([]);

    // Stop UI acknowledgement traffic before checking the exact persisted
    // bytes and emitted frames from rejected writes.
    await page.close();
    const cookie = (await context.cookies(origin)).map(value => `${value.name}=${value.value}`).join("; ");
    const sse = await openSse(`${origin}/api/events`, { cookie });
    try {
      await sse.until(frame => frame?.kind === "hello");
      const savedPath = join(harness.rootDirectory, "desktop", "data", "bots.json");
      const savedBefore = await readFile(savedPath, "utf8");
      const frameStart = sse.frames.length;
      for (const modelSelection of [null, [], "invalid", {}, { instanceId: 1 }, { model: false }, { effort: "turbo" }]) {
        const rejected = await context.request.patch(`${origin}/api/bots/${targetId}`, { data: { modelSelection }, headers: { origin } });
        expect(rejected.status()).toBe(400);
      }
      expect(await readFile(savedPath, "utf8")).toBe(savedBefore);
      expect((await readBots()).find(bot => bot.id === targetId)).toEqual(before);
      // A legitimate marker makes the stream check deterministic: all seven
      // rejected requests completed before this one and must emit no bot frame.
      const marker = "Profile boundary checked";
      expect((await context.request.patch(`${origin}/api/bots/${targetId}`, { data: { title: marker }, headers: { origin } })).status()).toBe(200);
      await sse.until(frame => isBotFrame(frame, targetId, marker));
      expect(sse.frames.slice(frameStart).filter(frame => isBotFrame(frame, targetId))).toHaveLength(1);

      const patchSelection = async (modelSelection: { instanceId?: string; model?: string; effort?: string }) => {
        const response = await context.request.patch(`${origin}/api/bots/${targetId}`, { data: { modelSelection }, headers: { origin } });
        expect(response.status()).toBe(200);
        return wireBotSchema.parse((await response.json()).bot).modelSelection;
      };
      expect(await patchSelection({ instanceId: "offline-fixture", model: "chosen", effort: "high" }))
        .toEqual({ instanceId: "offline-fixture", model: "chosen", effort: "high" });
      expect(await patchSelection({ instanceId: "offline-fixture" }))
        .toEqual({ instanceId: "offline-fixture", model: "chosen", effort: "high" });
      expect(await patchSelection({ effort: "low" }))
        .toEqual({ instanceId: "offline-fixture", model: "chosen", effort: "low" });
      expect(await patchSelection({ instanceId: "offline-fixture", model: "chosen" }))
        .toEqual({ instanceId: "offline-fixture", model: "chosen" });
      expect(await patchSelection({ instanceId: "another-offline-fixture" }))
        .toEqual({ instanceId: "another-offline-fixture", model: "" });
      expect(await patchSelection({ instanceId: "", model: "" })).toEqual({ instanceId: "", model: "" });
      const final = (await readBots()).find(bot => bot.id === targetId)!;
      expect(final.threadId).toBe(before.threadId);
      expect(final.messages).toEqual(before.messages);
      expect(final.tasks).toEqual(before.tasks);
    } finally { sse.close(); }
  } finally { await context.close(); await harness.stop(); }
});
