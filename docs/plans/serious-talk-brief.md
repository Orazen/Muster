# Muster — the serious-talk brief

_For the founder meeting. Everything below is grounded in the shipped product
(through v1.6.0) and three waves of competitor research. No speculation without a
citation to a shipped feature or a studied competitor._

## Where we genuinely are

**Shipped and differentiated (verified against 15 competitors):** the only product
that combines agent identity (personas + memory), rooms, verifiable signed receipts,
BYOK-any-endpoint providers, real computers, a headless browser, and five surfaces
(desktop, web, cloud, self-host, CLI). Closest rivals each cover one slice:
t3code (harness only, 21k★), Squad ($99/mo, identity+computers, no receipts/BYOK),
UmbrelOS (store UX only), OpenWork (org gateway only), Osaurus (macOS-only).

**Numbers that matter:** 6 releases in 4 days, 1,585 tests, 4 CI gates per push,
0 open Dependabot alerts, auto-update feed live, 22-asset installers on all
platforms. The engineering floor is real.

## The 5 decisions for this meeting

**1. Distribution is now the ONLY bottleneck — pick the wedge.**
Product is no longer the constraint. Options, ranked by our asymmetric advantage:
a) **openalternative.co + similar directories** (free, 1 hour, operator account) —
   SEO flywheel already proven by the directory itself.
b) **Show, don't tell**: 3 signed-receipt case posts — real tasks with verifiable
   proofs. Nothing else in the market can produce these.
c) **Templates with audiences**: port the 15 team packs to where their users are.
My recommendation: do all three in one week. Total cost: an operator account.

**2. The pricing gate.** The SKU ladder is decided (Self-host free / Cloud $20 per
computer / Pro $49 / Teams $18/seat / Enterprise MSAL). Squad charges $99/mo for a
subset; Eigent charges $19.99/mo of credits. The Stripe plumbing is wired. What's
missing: the checkout decision and the billing-page reveal. Two hours of work.

**3. Privacy Shield v2 = the enterprise wedge.** Hash-chained egress ledger
(gstack pattern) turning "you see what left" into a tamper-evident audit export.
Combined with signed receipts, this is the compliance story no competitor has.
Effort: ~1 week. This is the feature that justifies the Teams/Enterprise tiers.

**4. Mobile is 80% code-complete.** iOS (SwiftUI) + Android (Expo) companions
exist with store kits. Push approvals need only APNs/FCM credentials ($99 + $25 +
an Expo token). This unlocks "manage your team from anywhere" — the single most
requested capability, validated by OpenWork's Dispatch and Clonk's remote control.

**5. What I would NOT do next:** the big-L research items (Peer SDK, Gadgets,
trajectory export). They're differentiators, not conversions. The bottleneck is
users, and users come from distribution + pricing + mobile, in that order.

## The ask list (operator actions, in priority order)

1. openalternative.co account + submit Muster (AI Agent Platforms category)
2. Re-export VPS_SSH_KEY in OpenSSH format → download mirror goes current
3. Apple Developer ($99) + Google Play ($25) + Expo token → mobile ships
4. Stripe: enable the SKU ladder (2 hours with the wired portal)
5. Decide: hosted marketing budget (the directories offer paid placement later)

## The one-line thesis

Everything else is renting a model; Muster is hiring a workforce you can verify —
and after this week, it's the only product on any platform where that's true.
