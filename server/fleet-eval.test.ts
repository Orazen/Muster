import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseEvalCapture, scoreFleetCapture, type EvalCapture } from './fleet-eval.ts';

function fixture(): EvalCapture {
  const base = {
    botId: 'bot', threadId: 'thread', startedAt: '2026-09-09T10:00:00Z', capturedAt: '2026-09-09T10:01:00Z',
    send: { messageId: 'message', queued: false },
    wait: { outcome: 'settled', threadId: 'thread', reply: 'Finished' },
  };
  const card = { messageId: 'card', title: 'Approval needed', options: ['Allow', 'Deny'], tool: 'screenshot' };
  const capture = parseEvalCapture(JSON.stringify({ version: 1, label: 'fixture', source: 'simulated', probes: {
    completion: { ...base, receipt: { requestedBotId: 'bot', requestedThreadId: 'thread', receipt: {
      version: 1, bot: 'Test bot', job: 'Probe', startedAt: '2026-09-09T10:00:01Z', durationMs: 59000,
      turns: 1, tokensIn: 12, tokensOut: 8, costUsd: null, result: 'done', summary: 'Finished',
    } } },
    escalation: { ...base, wait: { outcome: 'needs-user', threadId: 'thread', needsUser: card }, card,
      audit: { requestedBotId: 'bot', humanDecisionId: 'decision', entries: [
        { id: 'decision', at: Date.parse('2026-09-09T10:00:30Z'), action: 'screenshot', decision: 'denied' },
      ] },
    },
    failure: { ...base, wait: { outcome: 'failed', threadId: 'thread' }, activity: 'dead' },
  } }));
  for (const [kind, probe] of Object.entries(capture.probes)) {
    if (!probe) continue;
    probe.threadId = `${kind}-thread`;
    probe.wait.threadId = probe.threadId;
    if (probe.receipt) probe.receipt.requestedThreadId = probe.threadId;
  }
  return capture;
}

describe('fleet eval scorecards', () => {
  it('grades all three captures and preserves unknown cost', () => {
    const result = scoreFleetCapture(fixture());
    expect(result.status).toBe('passed');
    expect(result.source).toBe('simulated');
    expect(result.probes.completion.tokens).toBe(20);
    expect(result.probes.completion.costUsd).toBeNull();
    expect(result.probes.failure.tokens).toBeNull();
  });
  it('reports missing probes rather than passing an empty run', () => {
    const capture = fixture(); capture.probes = {};
    expect(scoreFleetCapture(capture).status).toBe('incomplete');
  });
  it('rejects a mismatched or stale receipt and suppresses its metrics', () => {
    for (const stale of [false, true]) {
      const capture = fixture();
      if (stale) capture.probes.completion!.receipt!.receipt.startedAt = '2026-09-08T10:00:00Z';
      else capture.probes.completion!.receipt!.requestedThreadId = 'other';
      const result = scoreFleetCapture(capture);
      expect(result.status).toBe('failed');
      expect(result.probes.completion.tokens).toBeNull();
    }
  });
  it('does not pass a settled task without receipt evidence', () => {
    const capture = fixture(); delete capture.probes.completion!.receipt;
    expect(scoreFleetCapture(capture).status).toBe('failed');
  });
  it('requires exact option order and title when relaying an approval', () => {
    const capture = fixture(); capture.probes.escalation!.wait.needsUser!.options.reverse();
    expect(scoreFleetCapture(capture).probes.escalation.status).toBe('failed');
  });
  it('does not accept auto approval as a human decision', () => {
    const capture = fixture(); capture.probes.escalation!.audit!.entries[0].decision = 'auto';
    expect(scoreFleetCapture(capture).probes.escalation.status).toBe('failed');
  });
  it('rejects missing or out-of-window human decisions', () => {
    const capture = fixture(); capture.probes.escalation!.audit!.entries[0].at = 0;
    expect(scoreFleetCapture(capture).probes.escalation.status).toBe('failed');
    delete capture.probes.escalation!.audit;
    expect(scoreFleetCapture(capture).probes.escalation.status).toBe('failed');
  });
  it('never treats a stalled or working failure probe as passed', () => {
    const capture = fixture(); capture.probes.failure!.wait.outcome = 'stalled';
    expect(scoreFleetCapture(capture).probes.failure.status).toBe('failed');
  });
  it('rejects probes that reuse the same task thread', () => {
    const capture = fixture();
    capture.probes.failure!.threadId = capture.probes.completion!.threadId;
    capture.probes.failure!.wait.threadId = capture.probes.failure!.threadId;
    expect(scoreFleetCapture(capture).probes.failure.status).toBe('failed');
  });
  it('rejects a queued task and the wrong wait thread', () => {
    const capture = fixture(); capture.probes.completion!.send.queued = true;
    capture.probes.failure!.wait.threadId = 'other';
    const result = scoreFleetCapture(capture);
    expect(result.probes.completion.status).toBe('failed');
    expect(result.probes.failure.status).toBe('failed');
  });
  it('rejects malformed dates, negative usage, and invalid JSON at the boundary', () => {
    const capture = fixture(); capture.probes.completion!.receipt!.receipt.tokensIn = -1;
    expect(() => parseEvalCapture(JSON.stringify(capture))).toThrow();
    expect(() => parseEvalCapture('{broken')).toThrow();
  });
  it('writes a CLI scorecard, returns its result, and never overwrites evidence', () => {
    const dir = mkdtempSync(join(homedir(), 'fleet-eval-'));
    const input = join(dir, 'input.json'); const output = join(dir, 'output.json');
    writeFileSync(input, JSON.stringify(fixture()));
    const cli = fileURLToPath(new URL('../cli/muster.mjs', import.meta.url));
    const invoke = () => spawnSync(process.execPath, [cli, 'eval', input, output], { encoding: 'utf8', cwd: dir });
    expect(invoke().status).toBe(0);
    const original = readFileSync(output, 'utf8');
    expect(original).toContain('"status": "passed"');
    expect(invoke().status).toBe(2);
    expect(readFileSync(output, 'utf8')).toBe(original);
  });
});

describe('eval process outcomes', () => {
  it('persists incomplete results with exit code 1 and rejects invalid input', () => {
    const dir = mkdtempSync(join(homedir(), 'fleet-eval-'));
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.json');
    const cli = fileURLToPath(new URL('../cli/muster.mjs', import.meta.url));
    writeFileSync(input, JSON.stringify({ version: 1, label: 'Missing', source: 'simulated', probes: {} }));
    expect(spawnSync(process.execPath, [cli, 'eval', input, output], { cwd: dir }).status).toBe(1);
    expect(readFileSync(output, 'utf8')).toContain('"status": "incomplete"');
    writeFileSync(input, '{broken');
    expect(spawnSync(process.execPath, [cli, 'eval', input, join(dir, 'invalid.json')], { cwd: dir }).status).toBe(2);
  });
  it('runs the bundled evaluator without a source checkout', async () => {
    const dir = mkdtempSync(join(homedir(), 'fleet-eval-'));
    const entry = fileURLToPath(new URL('./fleet-eval.ts', import.meta.url));
    const bundle = join(dir, 'fleet-eval.mjs');
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const input = join(dir, 'capture.json'); const output = join(dir, 'scorecard.json');
    writeFileSync(input, JSON.stringify(fixture()));
    const result = spawnSync(process.execPath, [bundle, input, output], { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('"source": "simulated"');
  });
});
