/** A local, scripted landing-page demonstration. No real work is sent or saved. */
const freezeScenarios = (scenarios) => {
  for (const scenario of Object.values(scenarios)) {
    Object.freeze(scenario.inputs);
    Object.freeze(scenario.steps);
    Object.freeze(scenario.draft);
    Object.freeze(scenario);
  }
  return Object.freeze(scenarios);
};

export const SCENARIOS = freezeScenarios({
  update: {
    label: 'Wrap up the week',
    role: 'Your project companion',
    title: 'Friday update. Ready before Friday.',
    brief: 'Turn these fictional week notes into a short team update.',
    inputs: [
      'The launch checklist has been reviewed.',
      'An onboarding rough edge has been fixed.',
      'The pricing question is still open.',
    ],
    steps: [
      'Read the three sample notes',
      'Separate progress from the open question',
      'Prepare a short draft for your review',
    ],
    draftTitle: 'A small week. A clear update.',
    draft: [
      'Launch: the checklist review is complete.',
      'Onboarding: the rough edge has been fixed.',
      'Next decision: resolve the open pricing question.',
    ],
    approvalTitle: 'Share this with the team?',
    approvalDetail: 'Preview the decision to share with a fictional team. This local demo sends no messages.',
    approveLabel: 'Approve sample update',
    receiptApproved: 'Sample update approved. Nothing was sent to a team.',
    receiptDraft: 'Sample update kept as a draft in this demo. Nothing was sent.',
  },
  plan: {
    label: 'Make room for focus',
    role: 'Your planning companion',
    title: 'A little room for your real work.',
    brief: 'Arrange a fictional morning around one meeting and two priorities.',
    inputs: [
      'The sample morning runs from 9:00 to 12:00.',
      'A team check-in occupies 10:00–10:30.',
      'Allow 45 minutes for a proposal and 30 minutes for follow-ups.',
    ],
    steps: [
      'Keep the sample check-in in place',
      'Give the proposal an uninterrupted block',
      'Leave breathing room around follow-ups',
    ],
    draftTitle: 'Your morning, with breathing room.',
    draft: [
      '9:00–9:45 · Focus on the proposal.',
      '10:00–10:30 · Team check-in.',
      '10:45–11:15 · Follow-ups, with the remaining time left open.',
    ],
    approvalTitle: 'Does this morning work for you?',
    approvalDetail: 'Try approving this sample plan. No calendar is connected, and no events will be created.',
    approveLabel: 'Approve sample plan',
    receiptApproved: 'Sample plan approved. Nothing was added to a calendar.',
    receiptDraft: 'Sample plan kept as a draft in this demo. Your calendar is unchanged.',
  },
  research: {
    label: 'Untangle a decision',
    role: 'Your research companion',
    title: 'Three notes. One clearer choice.',
    brief: 'Make a decision brief from these fictional workshop venue notes.',
    inputs: [
      'The sample brief needs seating for 12 people and a projector.',
      'Studio A has 12 seats; projector availability is unknown.',
      'Studio B has 16 seats and a projector.',
    ],
    steps: [
      'Read the supplied sample criteria',
      'Compare the two fictional venue notes',
      'Keep the missing detail visible in the brief',
    ],
    draftTitle: 'A choice, with the unknowns intact.',
    draft: [
      'Studio B meets both requirements in the sample notes.',
      'Studio A has enough seats; its projector still needs checking.',
      'Ask about price and availability before choosing either venue.',
    ],
    approvalTitle: 'Use this as your decision brief?',
    approvalDetail: 'Approve the sample brief only. No web research, venue contact, or booking takes place.',
    approveLabel: 'Approve sample brief',
    receiptApproved: 'Sample brief approved. No venue was contacted or booked.',
    receiptDraft: 'Sample brief kept as a draft in this demo. No venue was contacted.',
  },
});

const DISCLAIMER = 'Local scripted demo · no AI connection, messages, bookings, or calendar changes.';
const scenarioKeys = Object.keys(SCENARIOS);

function requireScenario(key) {
  if (!scenarioKeys.includes(key)) throw new RangeError(`Unknown sample scenario: ${String(key)}`);
  return key;
}

/**
 * All actions return an immutable snapshot. Unsupported lifecycle transitions
 * leave the current state unchanged. Invalid scenario/decision values throw.
 */
export function createHandoff(initial = 'update') {
  let scenarioKey = requireScenario(initial);
  let phase = 'ready';
  let outcome = null;

  const getSnapshot = () => {
    const scenario = SCENARIOS[scenarioKey];
    const approved = outcome === 'approved';
    const cue = phase === 'ready' ? 'idle'
      : phase === 'preparing' ? 'thinking'
        : phase === 'review' ? 'curious'
          : approved ? 'celebrate' : 'happy';
    const status = phase === 'ready' ? 'Ready for a sample task'
      : phase === 'preparing' ? 'Preparing a sample draft'
        : phase === 'review' ? 'Waiting for your decision'
          : approved ? 'Demo approved — nothing sent' : 'Draft kept in this demo';
    return Object.freeze({
      scenarioKey,
      scenario,
      phase,
      outcome,
      cue,
      status,
      receipt: phase === 'complete'
        ? (approved ? scenario.receiptApproved : scenario.receiptDraft)
        : null,
      disclaimer: DISCLAIMER,
    });
  };

  return Object.freeze({
    getSnapshot,
    selectScenario(key) {
      requireScenario(key);
      scenarioKey = key;
      phase = 'ready';
      outcome = null;
      return getSnapshot();
    },
    start() {
      if (phase === 'ready') phase = 'preparing';
      return getSnapshot();
    },
    advance() {
      if (phase === 'preparing') phase = 'review';
      return getSnapshot();
    },
    decide(decision) {
      if (decision !== 'approve' && decision !== 'draft') {
        throw new RangeError(`Unknown sample decision: ${String(decision)}`);
      }
      if (phase === 'review') {
        outcome = decision === 'approve' ? 'approved' : 'draft';
        phase = 'complete';
      }
      return getSnapshot();
    },
    reset() {
      phase = 'ready';
      outcome = null;
      return getSnapshot();
    },
  });
}
