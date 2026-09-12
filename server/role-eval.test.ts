import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseRoleCapture, scoreRoleCapture, roleNames, type RoleCapture, type RoleScenario } from './role-eval.ts';

const BASE = '2026-09-11T10:00:00Z';
const LATER = '2026-09-11T10:01:00Z';
const MID = Date.parse('2026-09-11T10:00:30Z');

function base(role: RoleScenario['role'], kind: RoleScenario['kind'], name: string, suffix: string): RoleScenario {
  return {
    role, kind, scenario: name,
    botId: `bot-${role}`, threadId: `thread-${suffix}`, startedAt: BASE, capturedAt: LATER,
    send: { messageId: `msg-${suffix}`, queued: false },
    wait: { outcome: 'settled', threadId: `thread-${suffix}`, reply: 'Finished' },
  };
}

function receiptFor(suffix: string, botId: string) {
  return {
    requestedBotId: botId, requestedThreadId: `thread-${suffix}`,
    receipt: {
      version: 1, bot: 'Test bot', job: 'Benchmark', startedAt: '2026-09-11T10:00:01Z', durationMs: 59000,
      turns: 1, tokensIn: 12, tokensOut: 8, costUsd: null, result: 'done', summary: 'Finished',
    },
  };
}

function fixture(): RoleCapture {
  const grounding = {
    facts: [{ id: 'price-list', content: 'Widget costs 40 credits' }],
    citations: [{ claim: 'Widget costs 40 credits', factId: 'price-list' }],
  };
  const card = { messageId: 'card', title: 'Approval needed', options: ['Allow', 'Deny'], tool: 'screenshot' };
  const approval = {
    card,
    audit: {
      requestedBotId: 'bot-specialist', humanDecisionId: 'decision',
      entries: [{ id: 'decision', at: MID, action: 'screenshot', decision: 'denied' }],
    },
  };
  return parseRoleCapture(JSON.stringify({
    version: 1, label: 'fixture', source: 'simulated',
    scenarios: [
      { ...base('assistant', 'direct-answer', 'answers a plain task in its own thread', 'direct'), receipt: receiptFor('direct', 'bot-assistant') },
      { ...base('assistant', 'grounded-answer', 'cites workspace facts for a grounded task', 'a-ground'), receipt: receiptFor('a-ground', 'bot-assistant'), grounding },
      { ...base('coordinator', 'direct-answer', 'answers a plain task in its own thread', 'chief'), receipt: receiptFor('chief', 'bot-coordinator') },
      {
        ...base('coordinator', 'delegation', 'splits a task across the room and merges results', 'dispatch'),
        receipt: receiptFor('dispatch', 'bot-coordinator'),
        dispatch: {
          planId: 'plan', roster: ['member-a', 'member-b'],
          subtasks: [{ memberId: 'member-a', subtask: 'Draft the brief' }, { memberId: 'member-b', subtask: 'Check the numbers' }],
          merged: true,
        },
      },
      { ...base('specialist', 'grounded-answer', 'cites workspace facts for a grounded task', 's-ground'), receipt: receiptFor('s-ground', 'bot-specialist'), grounding },
      {
        ...base('specialist', 'escalation', 'escalates a permission request to its human', 'escalate'),
        wait: { outcome: 'needs-user', threadId: 'thread-escalate', needsUser: card },
        approval,
      },
    ],
  }));
}

describe('role benchmark scorecards', () => {
  it('grades all six required benchmarks and rolls roles up to passed', () => {
    const result = scoreRoleCapture(fixture());
    expect(result.status).toBe('passed');
    for (const roleName of roleNames) {
      expect(result.roles[roleName].status).toBe('passed');
    }
    expect(result.roles.assistant.scenarios).toHaveLength(2);
    expect(result.roles.assistant.scenarios[0].tokens).toBe(20);
    expect(result.roles.assistant.scenarios[0].costUsd).toBeNull();
    expect(result.roles.specialist.scenarios[1].tokens).toBeNull();
  });

  it('reports missing required benchmarks rather than passing an empty run', () => {
    const capture = fixture();
    capture.scenarios = capture.scenarios.filter((s) => s.kind !== 'delegation');
    const result = scoreRoleCapture(capture);
    expect(result.roles.coordinator.status).toBe('incomplete');
    expect(result.roles.assistant.status).toBe('passed');
    expect(result.status).toBe('incomplete');
  });

  it('reports an empty capture as incomplete, never passed', () => {
    const capture = fixture(); capture.scenarios = [];
    expect(scoreRoleCapture(capture).status).toBe('incomplete');
  });

  it('rejects a queued task and the wrong wait thread', () => {
    const capture = fixture();
    capture.scenarios[0].send.queued = true;
    capture.scenarios[2].wait.threadId = 'other';
    const result = scoreRoleCapture(capture);
    expect(result.roles.assistant.status).toBe('failed');
    expect(result.roles.coordinator.status).toBe('failed');
    expect(result.status).toBe('failed');
  });

  it('rejects scenarios that reuse the same task thread', () => {
    const capture = fixture();
    capture.scenarios[1].threadId = capture.scenarios[0].threadId;
    capture.scenarios[1].wait.threadId = capture.scenarios[1].threadId;
    const result = scoreRoleCapture(capture);
    expect(result.roles.assistant.status).toBe('failed');
  });

  it('rejects a mismatched or stale receipt and suppresses its metrics', () => {
    for (const stale of [false, true]) {
      const capture = fixture();
      if (stale) capture.scenarios[0].receipt!.receipt.startedAt = '2026-09-08T10:00:00Z';
      else capture.scenarios[0].receipt!.requestedThreadId = 'other';
      const result = scoreRoleCapture(capture);
      expect(result.status).toBe('failed');
      expect(result.roles.assistant.scenarios[0].tokens).toBeNull();
    }
  });

  it('does not pass a settled task without receipt evidence', () => {
    const capture = fixture(); delete capture.scenarios[0].receipt;
    expect(scoreRoleCapture(capture).status).toBe('failed');
  });

  it('does not pass a grounded answer without citations or with unsourced claims', () => {
    const capture = fixture();
    capture.scenarios[1].grounding!.citations = [];
    expect(scoreRoleCapture(capture).roles.assistant.status).toBe('failed');
    capture.scenarios[1].grounding!.citations = [{ claim: 'Anything', factId: 'no-such-fact' }];
    expect(scoreRoleCapture(capture).roles.assistant.status).toBe('failed');
  });

  it('does not pass a dispatch below the minimum split or outside the roster', () => {
    const capture = fixture();
    capture.scenarios[3].dispatch!.subtasks = [capture.scenarios[3].dispatch!.subtasks[0]];
    expect(scoreRoleCapture(capture).roles.coordinator.status).toBe('failed');
    capture.scenarios[3].dispatch!.subtasks[0].memberId = 'stranger';
    expect(scoreRoleCapture(capture).roles.coordinator.status).toBe('failed');
    capture.scenarios[3].dispatch!.merged = false;
    expect(scoreRoleCapture(capture).roles.coordinator.status).toBe('failed');
  });

  it('requires exact option order and title when relaying an approval', () => {
    const capture = fixture(); capture.scenarios[5].wait.needsUser!.options.reverse();
    expect(scoreRoleCapture(capture).roles.specialist.status).toBe('failed');
  });

  it('does not accept auto approval as a human decision or an answered card', () => {
    const capture = fixture(); capture.scenarios[5].approval!.audit.entries[0].decision = 'auto';
    expect(scoreRoleCapture(capture).roles.specialist.status).toBe('failed');
    const answered = fixture(); answered.scenarios[5].approval!.card.answered = 'Deny';
    expect(scoreRoleCapture(answered).roles.specialist.status).toBe('failed');
  });

  it('rejects missing or out-of-window human decisions and foreign audits', () => {
    const capture = fixture(); capture.scenarios[5].approval!.audit.entries[0].at = 0;
    expect(scoreRoleCapture(capture).roles.specialist.status).toBe('failed');
    const foreign = fixture(); foreign.scenarios[5].approval!.audit.requestedBotId = 'bot-other';
    expect(scoreRoleCapture(foreign).roles.specialist.status).toBe('failed');
    const orphan = fixture(); delete orphan.scenarios[5].approval;
    expect(scoreRoleCapture(orphan).roles.specialist.status).toBe('failed');
  });

  it('rejects malformed dates, negative usage, unknown roles, and invalid JSON at the boundary', () => {
    const capture = fixture(); capture.scenarios[0].receipt!.receipt.tokensIn = -1;
    expect(() => parseRoleCapture(JSON.stringify(capture))).toThrow();
    expect(() => parseRoleCapture('{broken')).toThrow();
    const validRoles = fixture();
    const badRole = { ...validRoles, scenarios: [{ ...validRoles.scenarios[0], role: 'chief' }, ...validRoles.scenarios.slice(1)] };
    expect(() => parseRoleCapture(JSON.stringify(badRole))).toThrow();
  });

  it('writes a CLI scorecard, returns its result, and never overwrites evidence', () => {
    const dir = mkdtempSync(join(homedir(), 'role-eval-'));
    const input = join(dir, 'input.json'); const output = join(dir, 'output.json');
    writeFileSync(input, JSON.stringify(fixture()));
    const cli = fileURLToPath(new URL('../cli/muster.mjs', import.meta.url));
    const invoke = () => spawnSync(process.execPath, [cli, 'bench', input, output], { encoding: 'utf8', cwd: dir });
    expect(invoke().status).toBe(0);
    const original = readFileSync(output, 'utf8');
    expect(original).toContain('"status": "passed"');
    expect(invoke().status).toBe(2);
    expect(readFileSync(output, 'utf8')).toBe(original);
  });

  it('runs the bundled evaluator without a source checkout', async () => {
    const dir = mkdtempSync(join(homedir(), 'role-eval-'));
    const entry = fileURLToPath(new URL('./role-eval.ts', import.meta.url));
    const bundle = join(dir, 'role-eval.mjs');
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const input = join(dir, 'capture.json'); const output = join(dir, 'scorecard.json');
    writeFileSync(input, JSON.stringify(fixture()));
    const result = spawnSync(process.execPath, [bundle, input, output], { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('"source": "simulated"');
  });
});
