import type { JsonObject } from './schema.ts';
import { describe, expect, it } from 'vitest';
import { parseEvidenceQuery, parseScorecardEvidence, parseWhyEvidence } from './fleet-evidence.ts';
const query = { botId: 'b1', limit: 1 };
const why = { runId: 'r1', botId: 'b1', threadId: 't1', at: 1, intent: 'Inspect', decisions: ['Read'], outcome: 'failed', hypothesis: 'Expected a page', findings: 'Not reachable' };
const run = { id: 'r1', botId: 'b1', routineId: 'routine', routineName: 'Check', scheduledFor: 1, status: 'failed' };

describe('bounded fleet evidence', () => {
  it('defaults the limit and rejects invalid ids, limits, and write arguments', () => {
    expect(parseEvidenceQuery({ botId: 'b1' })).toEqual({ botId: 'b1', limit: 10 });
    const invalidArguments: JsonObject[] = [{ botId: '../b1' }, { botId: 'b1', limit: 101 }, { botId: 'b1', limit: 0 }, { botId: 'b1', limit: 1.5 }, { botId: 'b1', limit: '10' }, { botId: 'b1', approve: true }];
    for (const args of invalidArguments) {
      expect(() => parseEvidenceQuery(args)).toThrow();
    }
  });
  it('scopes and sorts journal entries while preserving failure and reasoning', () => {
    const result = parseWhyEvidence({ entries: [why, { ...why, runId: 'r2', at: 2 }, { ...why, botId: 'b2', at: 3 }] }, query);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ runId: 'r2', outcome: 'failed', hypothesis: why.hypothesis, findings: why.findings });
  });
  it('reports an empty journal as empty evidence', () => {
    expect(parseWhyEvidence({ entries: [] }, query).entries).toEqual([]);
  });
  it('omits prompts and output and never turns absent checks into a pass', () => {
    const result = parseScorecardEvidence({ runs: [{ ...run, prompt: 'private prompt', output: 'private output' }] }, query);
    expect(result.runs[0]).toEqual(run);
    expect(result.runs[0].scorecard).toBeUndefined();
    expect(result.note).toContain('not a pass');
  });
  it('retains failed checks independently of a completed run', () => {
    const check = { id: 'check', label: 'Contains result', passed: false, reason: 'Missing' };
    const result = parseScorecardEvidence({ runs: [{ ...run, status: 'completed', scorecard: [check] }] }, query);
    expect(result.runs[0].status).toBe('completed');
    expect(result.runs[0].scorecard).toEqual([check]);
  });
  it('scopes recent scorecards by bot before applying the limit', () => {
    const result = parseScorecardEvidence({ runs: [run, { ...run, id: 'r2', scheduledFor: 2 }, { ...run, botId: 'b2', scheduledFor: 3 }] }, query);
    expect(result.runs.map((r) => r.id)).toEqual(['r2']);
    expect(result.hasMore).toBe(true);
  });
  it('rejects malformed upstream data instead of manufacturing empty evidence', () => {
    expect(() => parseWhyEvidence({ error: 'not authorized' }, query)).toThrow();
    expect(() => parseScorecardEvidence({ runs: [{ ...run, scorecard: [{ id: 'c', label: 'x', passed: 'yes' }] }] }, query)).toThrow();
  });
});
