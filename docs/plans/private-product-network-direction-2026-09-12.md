# Muster private-product direction — draft, 12 September 2026

**Status:** planning only. No implementation, launch, price change or new verification is represented here. The owner's latest direction supersedes earlier open-core/self-host marketing plans: position Muster as a private product with persistent AI workers and human-controlled actions. Do not claim AGI, ASI, universal device control, autonomous social trust or security certification. Existing license obligations remain in force; changing copy does not change the BSL license or third-party notices.

## Existing source contracts

The [internal agents proxy](../../server/drivers/agents-proxy.ts), [peer approvals](../../server/peer-approval.ts), [conversation mirroring](../../server/comms-visibility.ts) and [hi.new adapter](../../server/hi-new-proxy.ts) define the implementation boundary. Local `list_bots`, `ask_bot` and `delegate_bot`, bounded peer approvals, stored two-bot conversations, rooms and human-owned Shared brain already exist. They are installation teamwork, not an owner-isolated public network. Web conversation chips expose exchanges; equivalent native navigation is incomplete.

Muster's current hi.new bridge has eight tools and one configured installation handle shared by eligible bots. It sends plaintext (`enc:"none"`), has no dedicated test found in the map, and supplies neither per-bot external identities nor a friend-request UI. Shared brain is private context; a room bulletin is instructions, not a public post feed. The audit confirmed owner-blind team operations and room membership mutation. Their repair and legacy-room containment are prerequisites to the proposed activity UI. Internal list/ask/delegate still share an installation bearer; [session-bound capabilities](peer-capability-next-slice-2026-09-12.md) and previously mirrored history need separate P1 review before any cross-owner network.

## Proposed rollout — each stage requires a separate verified slice

1. **Private team activity first.** Present existing, owner-filtered teammates, pending contact approvals and actual exchanges with Open conversation. Reuse existing IDs, receipts and approval actions. Avoid Friends/Public posts controls, fabricated activity, new transport or automatic messages. Implement only after the owner-boundary prerequisites above are verified.
2. **Known external contacts.** Add human-reviewed invitation and acceptance with exact peer identity, purpose, expiry and revocation. Explicitly distinguish a shared installation identity from a unique bot identity. Do not enable private sharing through the current plaintext bridge until the retention, encryption, identity and retry contracts are resolved and tested.
3. **One reviewed knowledge share.** Let a bot propose a cited excerpt from human-selected material. A human approves the immutable text, attachments, target and audience. Track draft/submitting/accepted/unknown/failed; a network acknowledgement does not prove reading or successful work. Do not automatically adopt replies into memory. Public posts and broader discovery are later, independent decisions with moderation and audience controls.

## Privacy and delivery gates

Default private; no automatic export of memories, transcripts, people, files or credentials. Explain each destination's retention and metadata visibility before approval. Permission to connect does not authorize execution, replies, memory ingestion or reposting. Label AI authorship and the responsible operator; separate source facts from generated claims. Keep external content untrusted, preserve citations, and require renewed approval after content, recipient, account or policy changes. Maintain block/revoke controls and bounded traffic/costs. Reconcile uncertain delivery using durable logical-operation identifiers; never silently replay a non-idempotent social write.

hi.new's homepage describes opt-in plaintext transcripts, while its current API documentation and inspected schema default to 90-day retention. This conflict must be resolved before private knowledge sharing; encryption headlines do not resolve it. See [research and pinned evidence](bot-network-research-2026-09-12.md).

## Device and cloud limits

Phone/Watch companions connect to a computer's companion service; they are not evidence that model execution or desktop tools run on the phone/Watch. Availability depends on that server, provider, connection and platform. Preserve measured native approval evidence, but do not call the inherited Watch composer accepted because its owned unsigned simulator copies compiled. Physical installation, system-editor lifecycle and final source runtime acceptance are separate gates.

Login identity is not complete workspace synchronization. The [current backup contract](portable-backup-contract-2026-09-12.md) is manual, partial and installation-bound; conversation history/provider connections are excluded. Account-linked Drive is unavailable; configured installation Drive is separate. Do not promise portable restore, automatic cloud sync or account-wide recovery before a versioned export/restore contract passes unrelated-installation and interrupted-restore tests.

## Activation/trial hypotheses — proposed, not performance or pricing claims

- **Activation:** users understand value when one real task yields a visible result or an honestly explained blocker. Measure time from setup to accepted task and inspected result, setup abandonment, recoverable failures and explicit retries. Never count creating a bot, canned text or displaying a template as completed work.
- **Teamwork:** an intelligible activity view increases completion of a second useful task. Compare that rate with the existing experience; also measure mistaken approvals and revoked contacts. Stop if accidental sharing increases.
- **Trial:** test a clearly bounded evaluation with visible provider prerequisites and spend limits. Define the entitlement, quota meter, expiry behavior and billing consent first. No live prices, payment enrollment, external analytics or success targets are asserted by this draft.

## Scoped copy and acceptance work

From the source inventory, align `README.md`, `src/pages/LandingPage.tsx`, `www/index.html` and `www/download.html` in one copy slice: remove self-host/open-source acquisition promises, explain the actual desktop-plus-companion relationship, identify supported versus pending releases, and replace blanket sync/network language with checked behavior. Review every CTA's actual route and availability. Preserve licensing notices and private developer instructions; an owner-approved licensing decision is separate.

Test two isolated accounts for no cross-owner activity, actual offline-provider Allow/Deny outcomes, stale/deleted request refusal, reload links and zero render-triggered sends. Check 320px/1440px layouts, keyboard focus, recovery and reduced motion. External-contact work additionally needs grant-before-send, revoke, duplicate/restart, changed identity/content and lost-response cases. Device UI and real external-service acceptance require separately authorized fixtures; none runs in this planning task.

Primary references: [AgentGram source](https://github.com/agentgram/agentgram), [quickstart](https://www.agentgram.co/docs/quickstart), [OASIS simulation](https://github.com/camel-ai/oasis), [CAMEL research](https://www.camel-ai.org/), [AI Social API examples](https://github.com/Kevinchamplin/ai-social), [hi.new messaging](https://hi.new/). They inform patterns, not claims of Muster interoperability or shipped implementation.
