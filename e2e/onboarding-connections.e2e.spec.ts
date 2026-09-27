/** Setup ownership regression. Real isolated server/password session; external
 * consent and provider availability are explicit synthetic boundary fixtures. */
import { z } from 'zod';
import { test, expect, type Page } from '@playwright/test';
import { startOnboardingHarness } from './onboarding-harness.ts';

const staticDir = process.env.MUSTER_ONBOARDING_UI;
let harness: Awaited<ReturnType<typeof startOnboardingHarness>>;
let external: string[];
test.beforeEach(async ({context}) => {
  harness = await startOnboardingHarness(staticDir);
  external = [];
  await context.addInitScript(() => localStorage.setItem("muster:analytics-opt-out","1"));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === harness.url) return route.continue();
    external.push(url.origin+url.pathname);
    await route.abort("blockedbyclient");
  });
});
test.afterEach(async ({page}) => { await page.unrouteAll({behavior:"wait"}); await page.close(); await harness.stop(); expect(external).toEqual([]); });

async function enter(page: Page, options: { connected?: boolean; done?: boolean; search?: string } = {}) {
  const bots = await harness.api('/api/bots');
  for (const bot of z.object({bots:z.array(z.object({id:z.string()}))}).parse(bots.body).bots) {
    expect((await harness.api(`/api/bots/${bot.id}`, {method:'DELETE'})).status).toBe(200);
  }
  if (options.done) await harness.api('/api/me/onboarding', {method:'PUT', body:JSON.stringify({status:'submitted'})});
  const config = z.record(z.string(),z.unknown()).parse((await harness.api('/api/config')).body);
  await page.route('**/api/config', route => route.fulfill({json:{...config, storageGate:{required:true,satisfied:options.connected ?? false,options:{googleDrive:{available:true,connected:options.connected ?? false},telegram:{configured:false}}}}}));
  await page.route('**/api/connectors/catalog', route => route.fulfill({json:{configured:false,mode:'unavailable',cards:[],reason:'Gmail is not enabled on this workspace.'}}));
  await page.goto(`${harness.url}/sign-in?next=${encodeURIComponent('/app'+(options.search??''))}`);
  await page.getByLabel('Email address',{exact:true}).fill(harness.email);
  await page.getByLabel('Password',{exact:true}).fill(harness.password);
  await page.getByRole('button',{name:'Sign in with email',exact:true}).click();
  await expect(page).toHaveURL(/\/app/);
}

const wizard = (page: Page) => page.getByRole('region',{name:'Set up Muster',exact:true});

test('hosted first run has one setup surface, with no Drive or chat overlay', async ({page}) => {
  await enter(page);
  await expect(wizard(page)).toBeVisible();
  await expect(page.getByRole('dialog',{name:'Connect your storage'})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Set up Muster with your assistant'})).toHaveCount(0);
  await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Welcome');
});

async function engines(page: Page) {
  await wizard(page).getByRole('button',{name:'Continue',exact:true}).click();
  await wizard(page).getByRole('button',{name:'Skip tour',exact:true}).click();
  await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Engines');
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
  const region = wizard(page);
  const size = await region.boundingBox();
  expect(size!.x).toBeGreaterThanOrEqual(0);
  expect(size!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const width of [320,1440]) test(`Drive/Gmail and provider setup stay in one flow at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width,height:width===320?568:900});
  await enter(page);
  await engines(page);
  await expect(page.getByRole('heading',{name:'ChatGPT via Codex',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Claude',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'OpenCode',exact:true})).toBeVisible();
  await expect(page.getByLabel('AI provider',{exact:true})).toBeVisible();
  await fits(page);
  await wizard(page).getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByRole('button',{name:'Connect Google Drive',exact:true})).toBeVisible();
  await expect(page.getByText('Gmail setup is unavailable here',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Connect Gmail',exact:true})).toHaveCount(0);
  await fits(page);
  const avatar = page.locator('.onboarding-guide-flower canvas');
  const frame = await page.locator('.onboarding-guide-flower').boundingBox();
  const art = await avatar.boundingBox();
  expect(art!.width).toBeLessThanOrEqual(frame!.width+1);
  expect(art!.height).toBeLessThanOrEqual(frame!.height+1);
  expect(art!.x).toBeGreaterThanOrEqual(frame!.x-1);
  expect(art!.y).toBeGreaterThanOrEqual(frame!.y-1);
  expect(art!.x+art!.width).toBeLessThanOrEqual(frame!.x+frame!.width+1);
  expect(art!.y+art!.height).toBeLessThanOrEqual(frame!.y+frame!.height+1);
  await page.getByRole('button',{name:'Connect Google Drive',exact:true}).click({trial:true});
  await page.getByRole('button',{name:'Check Gmail again',exact:true}).click({trial:true});
  await page.getByTestId('onboarding-stage-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({path:info.outputPath(`connections-${width}.png`),fullPage:true});
  await page.reload();
  await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Connections');
  await expect(page.getByRole('region',{name:'Set up Muster with your assistant'})).toHaveCount(0);
});

test('deferring setup keeps one resumable notice rather than another interview', async ({page}) => {
  await enter(page);
  await wizard(page).getByRole('button',{name:'Maybe later',exact:true}).click();
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Set up Muster with your assistant'})).toHaveCount(0);
  await page.getByRole('button',{name:'Continue setup',exact:true}).click();
  await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Connections');
});

test('Drive return never treats a success query as proof and preserves the route', async ({page}) => {
  await enter(page,{done:true,search:'?drive=connected&template=plan-my-day#keep'});
  await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Connections');
  const drive = page.getByRole('region',{name:'Google Drive setup',exact:true});
  await expect(drive.getByText('Not connected',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Return to workspace',exact:true})).toBeDisabled();
  await expect(page).toHaveURL(/\/app\?template=plan-my-day#keep$/);
});

test('denied Drive consent explains recovery without restarting sign-in', async ({page}) => {
  await enter(page,{search:'?drive=connect-failed'});
  await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Connections');
  await expect(page.getByRole('alert').filter({hasText:/Drive.*not completed/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Connect Google Drive',exact:true})).toBeEnabled();
  await expect(page).toHaveURL(/\/app$/);
});

test('a completed empty account does not start another interview', async ({page}) => {
  await enter(page,{connected:true,done:true});
  await expect(page.getByRole('button',{name:'New bot',exact:true})).toBeVisible();
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Set up Muster with your assistant'})).toHaveCount(0);
});

test('inline BYOK saves only to the account vault and clears the typed key', async ({page}) => {
  await enter(page);
  const writes: {path:string; body:unknown}[] = [];
  await page.route('**/api/user-keys', async route => {
    if (route.request().method() === 'GET') return route.continue();
    writes.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    const config = z.record(z.string(),z.unknown()).parse((await harness.api('/api/config')).body);
    await route.fulfill({json:{...config,providers:{openai:{configured:true}}}});
  });
  await engines(page);
  await page.getByLabel('AI provider',{exact:true}).selectOption('openai');
  await page.getByLabel('OpenAI API key',{exact:true}).fill('synthetic-onboarding-key-not-a-credential');
  await page.getByRole('button',{name:'Save provider key',exact:true}).click();
  await expect(page.getByText(/key saved. It has not been tested with a model request/)).toBeVisible();
  await expect(page.getByLabel('OpenAI API key',{exact:true})).toHaveValue('');
  expect(writes).toEqual([{path:'/api/user-keys',body:{providerId:'openai',apiKey:'synthetic-onboarding-key-not-a-credential'}}]);
  expect(await page.evaluate(() => JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('synthetic-onboarding-key-not-a-credential');
});

test('Gmail consent link waits for verified status and never grants Drive', async ({page}) => {
  await enter(page);
  let gmailConnected = false;
  await page.route('**/api/connectors/catalog', route => route.fulfill({json:{configured:true,cards:[{slug:'gmail'}]}}));
  await page.route('**/api/connectors?services=gmail', route => route.fulfill({json:{configured:true,services:{gmail:{connected:gmailConnected,pending:!gmailConnected}}}}));
  await page.route('**/api/connectors/gmail/authorize', route => route.fulfill({json:{url:'https://consent.example.test/gmail'}}));
  await engines(page);
  await wizard(page).getByRole('button',{name:'Continue',exact:true}).click();
  const gmail = page.getByRole('region',{name:'Gmail setup',exact:true});
  await gmail.getByRole('button',{name:'Connect Gmail',exact:true}).click();
  await expect(gmail.getByRole('link',{name:'Continue to Gmail permission'})).toHaveAttribute('href','https://consent.example.test/gmail');
  await expect(gmail.getByText('Connected',{exact:true})).toHaveCount(0);
  gmailConnected = true;
  await gmail.getByRole('button',{name:'Check Gmail again',exact:true}).click();
  await expect(gmail.getByText('Connected',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Google Drive setup'}).getByText('Not connected',{exact:true})).toBeVisible();
});

test('verified Drive return shows Connected and offers the workspace once', async ({page}) => {
  await page.route('**/api/workspace/google/status', route => route.fulfill({json:{accountDrive:{available:true,connected:true}}}));
  await enter(page,{done:true,connected:true,search:'?drive=connected'});
  await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Connections');
  await expect(page.getByRole('region',{name:'Google Drive setup'}).getByText('Connected',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Return to workspace',exact:true}).click();
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Set up Muster with your assistant'})).toHaveCount(0);
});


test('a temporary stream disconnect preserves the setup and unsaved key', async ({page}) => {
  // Chromium's offline emulation need not close an already-open SSE stream.
  // This owned, events-only proxy lets us sever the real browser transport
  // and then restore it; no EventSource/store callback is mocked or invoked.
  const {createServer,request:forward} = await import('node:http');
  const streams = new Set<import('node:http').ServerResponse>();
  let accepting = true;
  let opens = 0;
  const proxy = createServer((request,response) => {
    if (request.url !== '/api/events') { response.writeHead(404).end(); request.resume(); return; }
    if (!accepting) { response.writeHead(503).end(); request.resume(); return; }
    streams.add(response);
    const upstream = forward(`${harness.serverUrl}/api/events`, {
      method:'GET',headers:{...request.headers,host:new URL(harness.url).host},
    }, reply => {
      if (reply.statusCode === 200) opens += 1;
      response.writeHead(reply.statusCode ?? 502,{
        ...reply.headers,'access-control-allow-origin':harness.url,'access-control-allow-credentials':'true',
      });
      reply.pipe(response);
    });
    upstream.on('error',() => response.destroy());
    response.once('close',() => { streams.delete(response); upstream.destroy(); });
    request.pipe(upstream);
  });
  await new Promise<void>((resolve,reject) => { proxy.once('error',reject); proxy.listen(0,'127.0.0.1',resolve); });
  const {port} = z.object({port:z.number()}).parse(proxy.address());
  const eventsUrl = `${harness.url}/api/events`;
  const proxyUrl = new URL(eventsUrl);
  proxyUrl.port = String(port);
  try {
    await page.route(eventsUrl,async route => route.continue({
      url:proxyUrl.href,headers:await route.request().allHeaders(),
    }));
    await enter(page);
    await expect.poll(() => opens).toBeGreaterThan(0);
    await engines(page);
    const mounted = await wizard(page).elementHandle();
    const key = page.getByLabel('OpenAI API key',{exact:true});
    await key.fill('unsaved-synthetic-key');
    const previousOpens = opens;
    accepting = false;
    for (const stream of streams) stream.destroy();
    await expect(page.getByText('Connecting to the bot server…',{exact:true})).toHaveCount(1);
    await expect(key).toHaveValue('unsaved-synthetic-key');
    await expect(page.getByTestId('onboarding-stage-title')).toHaveText('Engines');
    expect(await mounted!.evaluate(element => element.isConnected)).toBe(true);

    accepting = true;
    await expect.poll(() => opens).toBeGreaterThan(previousOpens);
    await expect(page.getByText('Your roster is empty — muster your first teammate',{exact:true})).toHaveCount(1);
    await expect(key).toHaveValue('unsaved-synthetic-key');
    expect(await mounted!.evaluate(element => element.isConnected)).toBe(true);
  } finally {
    try { if (!page.isClosed()) await page.unroute(eventsUrl); }
    finally {
      for (const stream of streams) stream.destroy();
      proxy.closeAllConnections();
      await new Promise<void>((resolve,reject) => proxy.close(error => error ? reject(error) : resolve()));
      // A timed-out test may already have lost its page before afterEach can
      // drain routes. Its detached owned server still needs explicit cleanup.
      if (page.isClosed()) await harness.stop();
    }
  }
});
