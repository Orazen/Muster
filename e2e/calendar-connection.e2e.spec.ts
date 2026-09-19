import { test, expect, pairDesktop } from "./browser-fixtures.ts";

// Route fixtures verify UI behavior only. Real consent, Google grants and
// provider isolation belong to the server harness/provider acceptance gates.
test("Calendar UI fixture: explicit same-context consent and local disconnect at 320px", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  let connected = false;
  let connects = 0;
  let disconnects = 0;
  await page.route("**/api/calendar/status", (route) => route.fulfill({ json: { configured: true, connected } }));
  await page.route("**/api/calendar/connect", async (route) => {
    expect(route.request().method()).toBe("POST");
    connects++;
    await route.fulfill({ json: { url: "https://accounts.google.com/o/oauth2/v2/auth?state=owned-ui-fixture" } });
  });
  // Fulfilled in-process before the context's external-network blocker:
  // no request reaches Google and this is not real-provider acceptance.
  await page.route("https://accounts.google.com/o/oauth2/v2/auth?state=owned-ui-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Owned Calendar consent fixture</h1>" }));
  await page.route("**/api/calendar/connection", (route) => {
    expect(route.request().method()).toBe("DELETE");
    disconnects++;
    connected = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { configured: false, cards: [], reason: "Installation connections unavailable." } }));
  await page.getByRole("button", { name: "Connected apps", exact: true }).click();
  const card = page.getByRole("region", { name: "Personal Google Calendar", exact: true });
  await expect(card.getByText("Calendar not connected", { exact: true })).toBeVisible();
  expect(connects).toBe(0);
  expect(disconnects).toBe(0);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(card.getByText(/requests read-only access/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const pageCount = page.context().pages().length;
  await card.getByRole("button", { name: "Connect Google Calendar", exact: true }).click();
  await expect(page).toHaveURL("https://accounts.google.com/o/oauth2/v2/auth?state=owned-ui-fixture");
  expect(page.context().pages()).toHaveLength(pageCount);
  expect(connects).toBe(1);
  connected = true;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${harness.desktopUrl}/app?calendar=connected`);
  await expect(card).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(card.getByText("Calendar connected", { exact: true })).toBeVisible();
  await expect(card.getByText(/does not revoke Google’s combined permission grant/)).toBeVisible();
  await card.getByRole("button", { name: "Disconnect Calendar here", exact: true }).click();
  await expect(card.getByText("Calendar not connected", { exact: true })).toBeVisible();
  expect(disconnects).toBe(1);
  await page.goto(`${harness.desktopUrl}/app?calendar=failed`);
  await expect(card.getByText("Calendar consent did not finish. You can try connecting again.", { exact: true })).toBeVisible();
  await expect(card.getByText("Calendar not connected", { exact: true })).toBeVisible();
});

test("Calendar UI fixture: unknown status is recoverable and unavailable config never connects", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  let statusCalls = 0;
  let mutations = 0;
  await page.route("**/api/calendar/status", (route) => {
    statusCalls++;
    return route.fulfill({ json: statusCalls === 1 ? { connected: "unknown" } : { configured: false, connected: false } });
  });
  await page.route("**/api/calendar/connect", (route) => {
    mutations++;
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { configured: false, cards: [] } }));
  await page.getByRole("button", { name: "Connected apps", exact: true }).click();
  const card = page.getByRole("region", { name: "Personal Google Calendar", exact: true });
  await expect(card.getByRole("alert")).toHaveText("Calendar status is unavailable. Please retry.");
  await expect(card.getByText("Calendar status unknown", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Connect Google Calendar", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Retry Calendar status", exact: true }).click();
  await expect(card.getByText("Calendar connection is unavailable on this server.", { exact: true })).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(statusCalls).toBe(2);
  expect(mutations).toBe(0);
});

test("Calendar UI fixture: personal sign-in is explicit and preserves the paired app", async ({ harness, newPage, pairCodeFromCloud }) => {
  const page = await newPage();
  await pairDesktop(page, harness, pairCodeFromCloud);
  await page.getByRole("button", { name: "Quick start — skip setup, just get me in", exact: true }).click();
  let mutations = 0;
  await page.route("**/api/calendar/status", (route) => route.fulfill({ json: { configured: true, connected: false, requiresSignIn: true } }));
  await page.route("**/api/calendar/connect", (route) => {
    mutations++;
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/connectors/catalog", (route) => route.fulfill({ json: { configured: false, cards: [] } }));
  await page.getByRole("button", { name: "Connected apps", exact: true }).click();
  const card = page.getByRole("region", { name: "Personal Google Calendar", exact: true });
  await expect(card.getByText("Sign in to connect your personal Calendar.", { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: "Sign in for Calendar", exact: true })).toHaveAttribute("href", "/sign-in?next=%2Fapp");
  await expect(card.getByRole("button", { name: "Connect Google Calendar", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(`${harness.desktopUrl}/app`);
  await page.getByRole("button", { name: "Close connected apps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connected apps", exact: true })).toBeVisible();
  expect(mutations).toBe(0);
});
