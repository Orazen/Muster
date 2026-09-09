import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./contracts.ts";
import { currentPlan, rehearsePlan, statedPlan } from "./plan-rehearsal.ts";

const summary = 'Open and inspect the page.\nPLAN TOOLS:\n- browser_open\n- screenshot';
function run(names = ['browser_open', 'screenshot'], id = 'run'): RuntimeEvent[] {
  const base = { eventId: 'event', provider: 'codex' as const, threadId: 'thread', turnId: id, createdAt: '2026-09-09' };
  return [
    { ...base, type: 'turn.started' },
    ...names.flatMap((title, i): RuntimeEvent[] => [
      { ...base, type: 'item.started', itemType: 'tool', title, itemId: String(i) },
      { ...base, type: 'item.completed', itemType: 'tool', ok: true, itemId: String(i) },
    ]),
    { ...base, type: 'turn.completed', ok: true },
  ];
}

describe('plan rehearsal', () => {
  it('requires an explicit bounded plan, rejecting prose or arguments', () => {
    expect(statedPlan(summary)).toEqual(['browser_open', 'screenshot']);
    for (const text of ['- browser_open\n- screenshot', 'PLAN TOOLS:\n- browser_open', summary + '\nThen continue', summary + ' --url secret', 'PLAN TOOLS:\n' + '- screenshot\n'.repeat(21), 'x'.repeat(8001)]) {
      expect(statedPlan(text)).toBeNull();
      expect(rehearsePlan(text, run())).toBeUndefined();
    }
  });
  it('reports empty history without inventing confidence', () => {
    expect(rehearsePlan(summary, [])).toMatchObject({ matchedSteps: 0, matchedRuns: 0, reviewedRuns: 0 });
  });
  it('counts complete matching runs and reports the evidence limits', () => {
    const result = rehearsePlan(summary, [...run(), ...run(undefined, 'second')]);
    expect(result).toMatchObject({ plannedSteps: 2, matchedSteps: 2, matchedRuns: 2, reviewedRuns: 2 });
    expect(result?.summary).toContain('arguments and screen states were not checked');
  });
  it('does not stitch steps across runs', () => {
    expect(rehearsePlan(summary, [...run(['browser_open']), ...run(['screenshot'], 'second')])).toMatchObject({ matchedSteps: 1, matchedRuns: 0 });
  });
  it('requires exact names and contiguous order', () => {
    for (const names of [['screenshot', 'browser_open'], ['browser_open', 'other', 'screenshot'], ['mcp__other__browser_open', 'screenshot']]) {
      expect(rehearsePlan(summary, run(names))?.matchedRuns).toBe(0);
    }
  });
  it('does not reuse an action for repeated steps', () => {
    expect(rehearsePlan('PLAN TOOLS:\n- screenshot\n- screenshot', run(['screenshot']))?.matchedSteps).toBe(1);
  });
  it('excludes failed turns and failed tools', () => {
    for (const index of [2, 5]) {
      const events = run();
      const event = events[index];
      if (event.type === 'turn.completed' || (event.type === 'item.completed' && event.itemType === 'tool')) {
        events[index] = { ...event, ok: false };
      }
      expect(rehearsePlan(summary, events)?.reviewedRuns).toBe(0);
    }
  });
  it('excludes incomplete turns and tails without a turn start', () => {
    expect(rehearsePlan(summary, run().slice(1))?.reviewedRuns).toBe(0);
    expect(rehearsePlan(summary, run().slice(0, -1))?.reviewedRuns).toBe(0);
  });
  it('excludes unmatched, duplicate, and overlapping tool events', () => {
    const events = run();
    for (const broken of [events.filter((_, i) => i !== 1), [...events.slice(0, 3), events[2], ...events.slice(3)], [events[0], events[1], events[3], events[2], events[4], events[5]]]) {
      expect(rehearsePlan(summary, broken)?.reviewedRuns).toBe(0);
    }
  });
  it('does not incorporate events from another turn', () => {
    const events = run();
    events[2] = { ...events[2], turnId: 'other' };
    expect(rehearsePlan(summary, events)?.reviewedRuns).toBe(0);
  });
});

describe('current plan provenance', () => {
  const base = run()[0];
  const text: RuntimeEvent = { ...base, type: 'item.completed', itemType: 'assistant_text', text: summary };
  it('uses only assistant text in the current turn', () => {
    expect(currentPlan('Allow', [text], 'run')).toBe(summary);
    expect(currentPlan('Allow', [text], 'other')).toBeUndefined();
    expect(currentPlan('Allow', [text])).toBeUndefined();
  });
  it('accepts streaming assistant plans but never reasoning text', () => {
    const delta: RuntimeEvent = { ...base, type: 'content.delta', streamKind: 'assistant_text', delta: summary };
    expect(currentPlan('Allow', [delta], 'run')).toBe(summary);
    expect(currentPlan('Allow', [{ ...delta, streamKind: 'reasoning_text' }], 'run')).toBeUndefined();
  });
  it('invalidates a malformed replacement plan', () => {
    expect(currentPlan('Allow', [text, { ...text, text: 'PLAN TOOLS:\n- incomplete' }], 'run')).toBeUndefined();
  });
});
