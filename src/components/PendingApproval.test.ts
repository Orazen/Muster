import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/state/store';
import { pendingApprovals, PendingApprovalPanel, suggestionAction } from './PendingApproval';

describe('plan evidence on pending approvals', () => {
  it('keeps evidence on the pending card and renders it as escaped text', () => {
    const message: Message = { id: 'm', at: 0, role: 'bot', kind: 'options', card: {
      title: 'Approval needed', subtitle: 'Inspect page', options: ['Allow', 'Deny'], requestId: 'r', tool: 'browser_open',
      rehearsal: { plannedSteps: 2, matchedSteps: 0, matchedRuns: 0, reviewedRuns: 0, summary: 'Plan rehearsal: <no matches>' },
    } };
    const [pending] = pendingApprovals([message]);
    expect(pending.rehearsal).toEqual(message.card?.rehearsal);
    expect(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }))).toContain('Plan rehearsal: &lt;no matches&gt;');
    expect(pendingApprovals([{ ...message, card: { ...message.card!, answered: 'Deny' } }])).toEqual([]);
  });
});

describe('grounded suggestion choice list', () => {
  const message: Message = { id: 'm2', at: 0, role: 'bot', kind: 'options', card: {
    title: 'Approval needed', subtitle: 'click (412, 88)', options: ['Allow', 'Deny'], requestId: 'r2', tool: 'computer_click',
    suggestions: [
      { id: 'b1', label: 'Save', source: 'browser', actionKind: 'click' },
      { id: 'b3', label: 'Save drafts', source: 'browser', actionKind: 'click' },
    ],
  } };

  it('carries the grounded controls onto the pending card and explains the choice', () => {
    const [pending] = pendingApprovals([message]);
    expect(pending.suggestions).toEqual(message.card?.suggestions);
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }));
    expect(html).toContain('Grounded controls detected on screen are offered below');
    expect(html).toContain('must not fall back to a nearby label');
    // the panel is evidence only — buttons live in the action row
    expect(html).not.toContain('<button');
  });

  it('answers through the existing respond route, naming the exact target', () => {
    const action = suggestionAction(message.card!.suggestions![0], 'thread-9', 'r2');
    expect(action).toEqual({
      type: 'decideRequest',
      threadId: 'thread-9',
      requestId: 'r2',
      behavior: 'allow',
      message: 'Grounded target chosen by the human: b1 — Save [browser] (click). Act on this exact target; a failed exact ID must not fall back to a nearby label.',
    });
    // a suggestion is a human choice, never an auto-answer: no behavior
    // other than the tapped allow, no always-allow grant attached
    expect(action.type).toBe('decideRequest');
    expect('alwaysAllow' in action).toBe(false);
  });
});
