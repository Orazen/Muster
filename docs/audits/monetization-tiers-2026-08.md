# Muster Subscription Tiers — Monetization Model (BSL-1.1 compliant)
# Source: BSL converts to Apache 2.0 after 2030-08-19; commercial support allowed now

TIER_FREE:
  price: $0/mo
  bots: 1, cloud_computer: false, voice: false, api: false
  data_dir: ~/.muster (local)

TIER_PRO:
  price: $20/mo
  bots: unlimited, cloud_computer: true (Box), voice: true (ElevenLabs), api: true
  data_dir: /data/workspace-{id}
  rev_share: 30% of Composio agency usage

TIER_ENTERPRISE:
  price: custom ($500+/mo)
  sso: true (OIDC), dedicated_harness: true, agent_marketplace: true
  rev_share: 30% + 70/30 split on agent sales

# Revenue streams (verified from session strategy doc):
# 1. Subscriptions 2. Composio rev-share 3. Agent Marketplace 4. Professional services
# Target ARR (12mo, conservative): $18.95k
