import { describe, expect, it } from 'vitest';
import { approvalWhy } from './approval-why.ts';
import type { WhyEntry } from './why-journal.ts';
const entry: WhyEntry = { runId: 'run', botId: 'bot', threadId: 'thread', at: 10, intent: 'Inspect prices', decisions: ['Read the page'], outcome: 'failed' };

describe('approval why history', () => {
  it('selects the latest matching bot and thread before the ask', () => {
    const result = approvalWhy([{ ...entry, at: 5 }, entry, { ...entry, botId: 'other', at: 11 }, { ...entry, threadId: 'other', at: 12 }, { ...entry, at: 30 }], 'bot', 'thread', 20);
    expect(result).toMatchObject({ source: 'previous-run', at: 10, outcome: 'failed' });
  });
  it('filters thread before selecting the latest history', () => {
    expect(approvalWhy([{ ...entry, threadId: 'other', at: 19 }, entry], 'bot', 'thread', 20)?.at).toBe(10);
  });
  it('omits missing, future, same-time, or invalid-clock evidence', () => {
    expect(approvalWhy([], 'bot', 'thread', 20)).toBeUndefined();
    expect(approvalWhy([entry], 'other', 'thread', 20)).toBeUndefined();
    expect(approvalWhy([entry], 'bot', 'thread', 10)).toBeUndefined();
    expect(approvalWhy([entry], 'bot', 'thread', NaN)).toBeUndefined();
  });
  it('bounds text and decisions without mutating the journal', () => {
    const raw = { ...entry, intent: 'a'.repeat(900), hypothesis: 'h'.repeat(900), findings: 'f'.repeat(900), decisions: Array(10).fill('d'.repeat(900)) };
    const result = approvalWhy([raw], 'bot', 'thread', 20)!;
    expect(result.intent.length).toBe(300);
    expect(result.hypothesis?.length).toBe(300);
    expect(result.findings?.length).toBe(300);
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions[0].length).toBe(200);
    result.decisions[0] = 'changed';
    expect(raw.decisions[0]).toHaveLength(900);
  });
  it('redacts full secrets before clipping displayed fields', () => {
    const secret = `sk-ant-api03-${'abcdefghijklmnopqrstuvwxyz0123456789'}`;
    const result = approvalWhy([{ ...entry, intent: secret, hypothesis: secret, findings: secret, decisions: [secret] }], 'bot', 'thread', 20);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result?.intent).toContain('«redacted');
  });
});
