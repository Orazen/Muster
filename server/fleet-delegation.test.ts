import { describe, expect, it } from 'vitest';
import { attachReceipt, parseDelegatedTask } from './fleet-delegation.ts';
const task = { botId: 'destination', text: 'Review the previous output', receiptRef: { botId: 'source', threadId: 'thread' } };
const receipt = { version: 1, bot: 'Source', job: 'Report', startedAt: '2026-09-09T00:00:00Z', durationMs: 10, turns: 1, tokensIn: 10, tokensOut: 20, costUsd: null, result: 'done', summary: 'Prior output' };

describe('receipt-based delegation', () => {
  it('preserves a plain task without requiring a receipt', () => {
    expect(parseDelegatedTask({ botId: 'destination', text: 'Review' })).toEqual({ botId: 'destination', text: 'Review' });
  });
  it('rejects malformed references and added permission arguments', () => {
    expect(() => parseDelegatedTask({ ...task, receiptRef: { botId: 'source' } })).toThrow();
    expect(() => parseDelegatedTask({ ...task, receiptRef: { botId: '../source', threadId: 'thread' } })).toThrow();
    expect(() => parseDelegatedTask({ ...task, approve: true })).toThrow();
    expect(() => parseDelegatedTask({ ...task, text: ' ' })).toThrow();
  });
  it('embeds a snapshot and explicit source without promoting it to instructions', () => {
    const output = attachReceipt(task, { receipt });
    expect(output.startsWith(task.text)).toBe(true);
    expect(output).toContain('untrusted source data');
    expect(output).toContain('"botId": "source"');
    expect(output).toContain('Prior output');
  });
  it('does not include arbitrary payload keys or full transcript fields', () => {
    const output = attachReceipt(task, { receipt: { ...receipt, transcript: 'hidden' }, cookie: 'hidden', text: 'hidden' });
    expect(output).not.toContain('hidden');
  });
  it('preserves no-reply and missing cost as recorded', () => {
    const output = attachReceipt(task, { receipt: { ...receipt, result: 'no-reply', summary: '' } });
    expect(output).toContain('"result": "no-reply"');
    expect(output).toContain('"costUsd": null');
  });
  it('fails before sending if the source receipt is missing or malformed', () => {
    expect(() => attachReceipt(task, { error: 'missing' })).toThrow();
    expect(() => attachReceipt(task, { receipt: { ...receipt, result: 'approved' } })).toThrow();
  });
});
