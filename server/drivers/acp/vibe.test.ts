import { chmodSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs, instanceConfigs } from '../../config.ts';
import type { ProviderInstance } from '../../contracts.ts';
import { recordEvents, type EventRecorder } from '../../testing/events.ts';
import { VibeAgentDriver, VIBE_CONFIGURED_MODEL } from './vibe.ts';
import { AcpToolContexts } from './tool-context.ts';

const fake = fileURLToPath(new URL('../../testing/fake-acp-cli.ts', import.meta.url));
let instance: ProviderInstance;
let recorder: EventRecorder;
const create = async (environment: Record<string, string> = {}) => {
  instance = await VibeAgentDriver.create({
    instanceId: 'vibe-test', displayName: 'Vibe test', enabled: true,
    config: { cli: fake, fullAuto: false },
    environment: { MISTRAL_API_KEY: 'fixture-key', FAKE_ACP_MODELS: 'model-a,model-b', FAKE_ACP_SESSION_MODE: 'auto-approve', ...environment },
  });
  recorder = recordEvents(instance.adapter);
};
beforeEach(() => { ensureDirs(); chmodSync(fake, 0o755); });
afterEach(async () => { recorder?.stop(); await instance?.dispose(); vi.unstubAllEnvs(); });

describe('Vibe ACP', () => {
  it('uses the configured model and confirms approval mode without model argv', async () => {
    const dump = join(homedir(), 'vibe-dump.json');
    await create({ FAKE_ACP_DUMP: dump, VIBE_HOME: '/tmp/fixture-vibe-home' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: VIBE_CONFIGURED_MODEL });
    expect(await recorder.until((e) => e.type === 'turn.completed')).toMatchObject({ ok: true });
    expect(recorder.events.find((e) => e.type === 'session.started')).toMatchObject({ model: 'model-a' });
    const dumped = JSON.parse(readFileSync(dump, 'utf8'));
    expect(dumped.argv).toEqual([]);
    expect(dumped.env.MISTRAL_API_KEY).toBe('fixture-key');
    expect(dumped.env.VIBE_HOME).toBe('/tmp/fixture-vibe-home');
  });
  it('selects an explicit model after setting default mode', async () => {
    await create({ FAKE_ACP_MODE_RESETS_MODEL: '1' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: 'model-b' });
    expect(await recorder.until((e) => e.type === 'turn.completed')).toMatchObject({ ok: true });
    expect(recorder.events.find((e) => e.type === 'session.started')).toMatchObject({ model: 'model-b' });
  });
  it('fails without prompting if approval mode silently sticks', async () => {
    await create({ FAKE_ACP_MODE_STICKS: '1' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: VIBE_CONFIGURED_MODEL });
    expect(await recorder.until((e) => e.type === 'turn.completed')).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === 'content.delta')).toBe(false);
  });
  it('fails without prompting if the requested model silently sticks', async () => {
    await create({ FAKE_ACP_MODEL_STICKS: '1' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: 'model-b' });
    expect(await recorder.until((e) => e.type === 'turn.completed')).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === 'content.delta')).toBe(false);
  });
  it('fails without prompting if model selection changes approval mode', async () => {
    await create({ FAKE_ACP_MODEL_RESETS_MODE: '1' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: 'model-b' });
    expect(await recorder.until((e) => e.type === 'turn.completed')).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === 'content.delta')).toBe(false);
  });
  it('fails without prompting when mode configuration is unsupported', async () => {
    await create({ FAKE_ACP_SESSION_MODE: '' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: VIBE_CONFIGURED_MODEL });
    expect(await recorder.until((e) => e.type === 'turn.completed')).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === 'content.delta')).toBe(false);
  });
  it.each(['allow', 'deny'] as const)('retains sparse tool context and honors human %s', async (behavior) => {
    await create({ FAKE_ACP_MODE: 'sparse-permission' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: VIBE_CONFIGURED_MODEL });
    const ask = await recorder.until((e) => e.type === 'request.opened');
    expect(ask).toMatchObject({ tool: 'shell', summary: 'echo pending', requestType: 'permission' });
    await instance.adapter.respondToRequest('thread', ask.requestId!, { behavior });
    expect(await recorder.until((e) => e.type === 'request.resolved')).toMatchObject({ behavior, source: 'user' });
    await recorder.until((e) => e.type === 'turn.completed');
  });
  it('reports an early engine exit as failure', async () => {
    await create({ FAKE_ACP_MODE: 'exit-early' });
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: VIBE_CONFIGURED_MODEL });
    expect(await recorder.until((e) => e.type === 'turn.completed')).toMatchObject({ ok: false });
  });
  it('confirms settings on a resumed session', async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: 'thread', text: 'Inspect', model: VIBE_CONFIGURED_MODEL, resumeCursor: 'saved-session' });
    await recorder.until((e) => e.type === 'turn.completed');
    expect(recorder.events.find((e) => e.type === 'session.started')).toMatchObject({ sessionId: 'saved-session', model: 'model-a' });
  });
  it('reports missing credentials and respects explicit instance keys', async () => {
    vi.stubEnv('MISTRAL_API_KEY', '');
    await create({ MISTRAL_API_KEY: '' });
    expect((await instance.snapshot()).authenticated).toBe(false);
    const cfg = instanceConfigs({ providers: { mistral: { apiKey: 'saved-fixture' } }, instances: { vibe: { driver: 'vibeAgent', environment: { MISTRAL_API_KEY: 'instance-fixture' } } } });
    expect(cfg.vibe.environment?.MISTRAL_API_KEY).toBe('instance-fixture');
    expect(instanceConfigs({ providers: { mistral: { apiKey: 'saved-fixture' } } }).vibe.environment?.MISTRAL_API_KEY).toBe('saved-fixture');
    expect(instanceConfigs({ providers: { mistral: { apiKey: 'saved-fixture' } }, instances: { vibe: { driver: 'vibeAgent', environment: { MISTRAL_API_KEY: '' } } } }).vibe.environment?.MISTRAL_API_KEY).toBe('');
  });
  it('reports a missing CLI as unavailable', async () => {
    instance = await VibeAgentDriver.create({ instanceId: 'missing', displayName: 'Missing', enabled: true, environment: { MISTRAL_API_KEY: 'fixture' }, config: { cli: '/no-such-vibe-cli', fullAuto: false } });
    expect((await instance.snapshot()).state).toBe('unavailable');
  });
});

describe('ACP tool metadata retention', () => {
  it('merges partial updates and keeps separate tool ids', () => {
    const contexts = new AcpToolContexts();
    contexts.remember({ toolCallId: 'one', kind: 'execute', rawInput: { command: 'first' } });
    contexts.remember({ toolCallId: 'two', kind: 'read', title: 'Second' });
    contexts.remember({ toolCallId: 'one', title: 'Updated' });
    expect(contexts.remember({ toolCallId: 'one' })).toMatchObject({ kind: 'execute', rawInput: { command: 'first' }, title: 'Updated' });
    expect(contexts.remember({ toolCallId: 'two' }).title).toBe('Second');
  });
  it('bounds retained entries and rejects malformed context', () => {
    const contexts = new AcpToolContexts();
    for (let i = 0; i < 513; i++) contexts.remember({ toolCallId: String(i), title: `Tool ${i}` });
    expect(contexts.remember({ toolCallId: '0' }).title).toBeUndefined();
    expect(contexts.remember({ toolCallId: '512' }).title).toBe('Tool 512');
    expect(contexts.remember({ toolCallId: 9 })).toEqual({});
  });
});
