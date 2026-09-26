import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseScorecard, trendFromScorecards, type Scorecard } from './eval-trend.ts';

function scorecardFixture(label: string, status: Scorecard['status']): Scorecard {
  return parseScorecard(`${label}.json`, JSON.stringify({
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
  }));
}

describe('fleet eval trend', () => {
  it('keeps the caller\u2019s file order and each run\u2019s own claim', () => {
    const trend = trendFromScorecards([
      { file: 'c.json', scorecard: scorecardFixture('run-c', 'passed') },
      { file: 'a.json', scorecard: scorecardFixture('run-a', 'failed') },
      { file: 'b.json', scorecard: scorecardFixture('run-b', 'incomplete') },
    ]);
    // Alphabetical order would pass this test wrongly; the caller decides.
    expect(trend.runs.map((r) => r.file)).toEqual(['c.json', 'a.json', 'b.json']);
    expect(trend.statuses).toEqual(['passed', 'failed', 'incomplete']);
  });

  it('names the checks that failed, so a regression says which check broke', () => {
    const trend = trendFromScorecards([{ file: 'a.json', scorecard: scorecardFixture('run-a', 'failed') }]);
    expect(trend.runs[0]!.probes.escalation.status).toBe('failed');
    expect(trend.runs[0]!.probes.escalation.failedChecks).toEqual(['bot escalated to its human']);
    expect(trend.runs[0]!.probes.completion.failedChecks).toEqual([]);
  });

  it('passes unknown usage through as null instead of zero-filling it', () => {
    const trend = trendFromScorecards([{ file: 'a.json', scorecard: scorecardFixture('run-a', 'passed') }]);
    expect(trend.runs[0]!.probes.completion.tokens).toBe(20);
    expect(trend.runs[0]!.probes.completion.costUsd).toBeNull();
    expect(trend.runs[0]!.probes.escalation.tokens).toBeNull();
  });

  it('lists distinct labels so unlike task specifications are visible', () => {
    const trend = trendFromScorecards([
      { file: 'a.json', scorecard: scorecardFixture('same task, small model', 'passed') },
      { file: 'b.json', scorecard: scorecardFixture('same task, small model', 'passed') },
      { file: 'c.json', scorecard: scorecardFixture('a different task', 'passed') },
    ]);
    expect(trend.labels).toEqual(['same task, small model', 'a different task']);
  });

  it('accepts a single scorecard and still reports its metrics', () => {
    const trend = trendFromScorecards([{ file: 'a.json', scorecard: scorecardFixture('run-a', 'passed') }]);
    expect(trend.runs).toHaveLength(1);
    expect(trend.limitation).toContain('file order');
  });

  it('rejects a non-scorecard and names the file without echoing it', () => {
    expect(() => parseScorecard('broken.json', '{')).toThrow(/broken\.json/);
    expect(() => parseScorecard('old.json', JSON.stringify({ version: 2 }))).toThrow(/old\.json/);
  });

  it('drives the CLI end to end: JSON out, invalid input exits 2', () => {
    const dir = mkdtempSync(join(homedir(), 'eval-trend-'));
    const write = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, body);
      return path;
    };
    const first = write('a.json', JSON.stringify(scorecardFixture('run-a', 'passed')));
    const second = write('b.json', JSON.stringify(scorecardFixture('run-a', 'failed')));
    const broken = write('broken.json', '{');
    const cli = fileURLToPath(new URL('../cli/muster.mjs', import.meta.url));
    const run = (paths: string[]) => spawnSync(process.execPath, [cli, 'eval-trend', ...paths], { encoding: 'utf8', cwd: dir });
    const good = run([first, second]);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('"statuses"');
    expect(good.stdout).toContain('a.json');
    expect(run([broken]).status).toBe(2);
  });
});
