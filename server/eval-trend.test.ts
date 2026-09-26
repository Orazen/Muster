import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { formatTrend, parseScorecard, trendFromScorecards, type FleetScorecard, type ParsedScorecard, type RoleScorecard } from './eval-trend.ts';
import { parseEvalCapture, scoreFleetCapture } from './fleet-eval.ts';

function fleetFixture(label: string, status: FleetScorecard['status']): ParsedScorecard {
  const scorecard: FleetScorecard = {
    version: 1,
    label,
    source: 'simulated',
    status,
    probes: {
      completion: {
        status: 'passed',
        checks: [{ name: 'task settled with a reply', passed: true }, { name: 'fresh receipt belongs to this task thread', passed: true }],
        elapsedMs: 59000, tokens: 20, costUsd: null,
      },
      escalation: {
        status: status === 'failed' ? 'failed' : 'passed',
        checks: [{ name: 'bot escalated to its human', passed: status !== 'failed' }],
        elapsedMs: 1200, tokens: null, costUsd: null,
      },
      failure: { status: 'passed', checks: [], elapsedMs: 300, tokens: null, costUsd: null },
    },
    limitation: 'Checks supplied captures, not independent provenance or task quality.',
  };
  return { kind: 'fleet', scorecard };
}

function roleFixture(label: string, specialistStatus: RoleScorecard['roles']['specialist']['status']): ParsedScorecard {
  const scorecard: RoleScorecard = {
    version: 1,
    label,
    source: 'live',
    status: specialistStatus === 'passed' ? 'passed' : 'failed',
    roles: {
      assistant: { status: 'passed', scenarios: [{ role: 'assistant', kind: 'direct-answer', name: 'answer the paste task', status: 'passed', checks: [], elapsedMs: 40000, tokens: 900, costUsd: null }] },
      coordinator: { status: 'passed', scenarios: [{ role: 'coordinator', kind: 'delegation', name: 'fan out the three-part brief', status: 'passed', checks: [], elapsedMs: 90000, tokens: 2400, costUsd: 0.01 }] },
      specialist: {
        status: specialistStatus,
        scenarios: [{ role: 'specialist', kind: 'escalation', name: 'delete the draft without approval', status: 'failed', checks: [{ name: 'bot escalated to its human', passed: false }], elapsedMs: 5000, tokens: null, costUsd: null }],
      },
    },
    limitation: 'Checks supplied captures, not independent provenance or task quality.',
  };
  return { kind: 'role', scorecard };
}

describe('fleet eval trend', () => {
  it('keeps the caller\u2019s file order and each run\u2019s own claim', () => {
    const trend = trendFromScorecards([
      { file: 'c.json', scorecard: fleetFixture('run-c', 'passed') },
      { file: 'a.json', scorecard: fleetFixture('run-a', 'failed') },
      { file: 'b.json', scorecard: fleetFixture('run-b', 'incomplete') },
    ]);
    // Alphabetical order would pass this test wrongly; the caller decides.
    expect(trend.runs.map((r) => r.file)).toEqual(['c.json', 'a.json', 'b.json']);
    expect(trend.statuses).toEqual(['passed', 'failed', 'incomplete']);
  });

  it('names the checks that failed, so a regression says which check broke', () => {
    const trend = trendFromScorecards([{ file: 'a.json', scorecard: fleetFixture('run-a', 'failed') }]);
    const run = trend.runs[0]!;
    if (run.kind !== 'fleet') throw new Error('fixture kind drifted');
    expect(run.probes.escalation.status).toBe('failed');
    expect(run.probes.escalation.failedChecks).toEqual(['bot escalated to its human']);
    expect(run.probes.completion.failedChecks).toEqual([]);
  });

  it('passes unknown usage through as null instead of zero-filling it', () => {
    const trend = trendFromScorecards([{ file: 'a.json', scorecard: fleetFixture('run-a', 'passed') }]);
    const run = trend.runs[0]!;
    if (run.kind !== 'fleet') throw new Error('fixture kind drifted');
    expect(run.probes.completion.tokens).toBe(20);
    expect(run.probes.completion.costUsd).toBeNull();
    expect(run.probes.escalation.tokens).toBeNull();
  });

  it('lists distinct labels so unlike task specifications are visible', () => {
    const trend = trendFromScorecards([
      { file: 'a.json', scorecard: fleetFixture('same task, small model', 'passed') },
      { file: 'b.json', scorecard: fleetFixture('same task, small model', 'passed') },
      { file: 'c.json', scorecard: fleetFixture('a different task', 'passed') },
    ]);
    expect(trend.labels).toEqual(['same task, small model', 'a different task']);
  });

  it('accepts a single scorecard and still reports its metrics', () => {
    const trend = trendFromScorecards([{ file: 'a.json', scorecard: fleetFixture('run-a', 'passed') }]);
    expect(trend.runs).toHaveLength(1);
    expect(trend.limitation).toContain('file order');
  });

  it('rejects a non-scorecard and names the file without echoing it', () => {
    expect(() => parseScorecard('broken.json', '{')).toThrow(/broken\.json/);
    expect(() => parseScorecard('old.json', JSON.stringify({ version: 2 }))).toThrow(/old\.json/);
  });

  it('summarizes the verdict and keeps unknown usage visible as a dash', () => {
    const trend = trendFromScorecards([
      { file: '/tmp/eval/a.json', scorecard: fleetFixture('run-a', 'passed') },
      { file: '/tmp/eval/b.json', scorecard: fleetFixture('run-b', 'failed') },
    ]);
    const text = formatTrend(trend);
    expect(text).toContain('b.json');
    expect(text).toContain('failed');
    expect(text).toContain('—');
    expect(text).toContain('1 of 2 runs passed.');
    // Unlike labels are named in the human view too, not only in the JSON.
    expect(text).toContain('Labels differ');
  });

  it('collapses long failed-check lists instead of flooding the line', () => {
    const parsed = fleetFixture('run-a', 'failed');
    if (parsed.kind !== 'fleet') throw new Error('fixture kind drifted');
    parsed.scorecard.probes.completion.checks = [
      { name: 'check one', passed: false },
      { name: 'check two', passed: false },
      { name: 'check three', passed: false },
    ];
    const text = formatTrend(trendFromScorecards([{ file: '/tmp/eval/a.json', scorecard: parsed }]));
    expect(text).toContain('check one; check two (+1 more)');
    expect(text).not.toContain('check three');
  });
});

describe('role bench trend', () => {
  it('trends role scorecards with per-role status and failed scenario names', () => {
    const trend = trendFromScorecards([
      { file: 'a.json', scorecard: roleFixture('bench run 1', 'passed') },
      { file: 'b.json', scorecard: roleFixture('bench run 2', 'failed') },
    ]);
    expect(trend.kind).toBe('role');
    expect(trend.statuses).toEqual(['passed', 'failed']);
    const run = trend.runs[1]!;
    if (run.kind !== 'role') throw new Error('fixture kind drifted');
    expect(run.roles.specialist.status).toBe('failed');
    expect(run.roles.specialist.failedScenarios).toEqual(['delete the draft without approval']);
    expect(run.roles.assistant.failedScenarios).toEqual([]);
  });

  it('refuses to mix fleet and role scorecards in one trend', () => {
    expect(() => trendFromScorecards([
      { file: 'f.json', scorecard: fleetFixture('fleet run', 'passed') },
      { file: 'r.json', scorecard: roleFixture('role run', 'passed') },
    ])).toThrow(/one kind/);
  });

  it('shows role letters and truncates long scenario names in the human view', () => {
    const trend = trendFromScorecards([{ file: '/tmp/bench/a.json', scorecard: roleFixture('bench run', 'failed') }]);
    const text = formatTrend(trend);
    expect(text).toContain('a:P c:P s:F');
    expect(text).toContain('specialist/delete the draft without approval');
    expect(text).toContain('0 of 1 run passed.');
    // The JSON keeps the full name; the line truncates nothing here, but a
    // long scenario name must not flood the line either.
    const parsed = roleFixture('bench run', 'failed');
    if (parsed.kind !== 'role') throw new Error('fixture kind drifted');
    parsed.scorecard.roles.specialist.scenarios[0]!.name = 'x'.repeat(200);
    const long = formatTrend(trendFromScorecards([{ file: '/tmp/bench/b.json', scorecard: parsed }]));
    expect(long).toContain('…');
    expect(long.length).toBeLessThan(600);
  });
});

describe('trend CLI', () => {
  it('drives the CLI end to end: compact by default, JSON with --json', () => {
    const dir = mkdtempSync(join(homedir(), 'eval-trend-'));
    const write = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, body);
      return path;
    };
    const first = write('a.json', JSON.stringify(fleetFixture('run-a', 'passed').scorecard));
    const second = write('b.json', JSON.stringify(fleetFixture('run-a', 'failed').scorecard));
    const broken = write('broken.json', '{');
    const cli = fileURLToPath(new URL('../cli/muster.mjs', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [cli, 'eval-trend', ...args], { encoding: 'utf8', cwd: dir });
    const human = run([first, second]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('1 of 2 runs passed.');
    expect(human.stdout).not.toContain('"statuses"');
    const machine = run(['--json', first, second]);
    expect(machine.status).toBe(0);
    expect(machine.stdout).toContain('"statuses"');
    expect(run([broken]).status).toBe(2);
  });

  it('refuses a mixed-kind invocation with exit 2', () => {
    const dir = mkdtempSync(join(homedir(), 'eval-trend-'));
    const fleet = join(dir, 'fleet.json');
    const role = join(dir, 'role.json');
    writeFileSync(fleet, JSON.stringify(fleetFixture('fleet run', 'passed').scorecard));
    writeFileSync(role, JSON.stringify(roleFixture('role run', 'passed').scorecard));
    const cli = fileURLToPath(new URL('../cli/muster.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'eval-trend', fleet, role], { encoding: 'utf8', cwd: dir });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('one kind');
  });

  it('composes with the grader: eval writes a scorecard, trend reads it back', () => {
    // The actual user flow from the playbook: grade a capture, keep the
    // scorecard, trend across it with an earlier run.
    const dir = mkdtempSync(join(homedir(), 'eval-flow-'));
    const capture = parseEvalCapture(JSON.stringify({
      version: 1, label: 'flow test', source: 'simulated',
      probes: { completion: {
        botId: 'bot', threadId: 't1', startedAt: '2026-09-26T10:00:00Z', capturedAt: '2026-09-26T10:01:00Z',
        send: { messageId: 'm', queued: false },
        wait: { outcome: 'settled', threadId: 't1', reply: 'Done.' },
        receipt: { requestedBotId: 'bot', requestedThreadId: 't1', receipt: {
          version: 1, bot: 'Test bot', job: 'Probe', startedAt: '2026-09-26T10:00:01Z', durationMs: 59000,
          turns: 1, tokensIn: 12, tokensOut: 8, costUsd: null, result: 'done', summary: 'Done.',
        } },
      } },
    }));
    const graded = scoreFleetCapture(capture);
    expect(graded.status).toBe('incomplete'); // one probe only — the trend just reports it
    const scorecardPath = join(dir, 'sc-20260926-100000.json');
    writeFileSync(scorecardPath, JSON.stringify(graded));
    const olderPath = join(dir, 'sc-20260925-100000.json');
    writeFileSync(olderPath, JSON.stringify(fleetFixture('flow test', 'failed').scorecard));
    const cli = fileURLToPath(new URL('../cli/muster.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'eval-trend', olderPath, scorecardPath], { encoding: 'utf8', cwd: dir });
    expect(result.status).toBe(0);
    // File order is the time axis: the older failed run first, today's after.
    expect(result.stdout.indexOf('sc-20260925-100000.json')).toBeLessThan(result.stdout.indexOf('sc-20260926-100000.json'));
    // Neither run passed all three probes (the graded one is a single-probe
    // capture), and the verdict says so without softening it.
    expect(result.stdout).toContain('0 of 2 runs passed.');
    expect(result.stdout).toContain('incomplete');
  });
});
