import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/state/store';
import { pendingApprovals, PendingApprovalPanel } from './PendingApproval';

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
