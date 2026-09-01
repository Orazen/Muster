# WhatsApp Business Packs — Muster

Ready-to-sell packs that put a WhatsApp agent in front of a small business's customers in one day, using Muster routines plus the WhatsApp Business channel. The bot answers customer messages and scheduled watches (sentries) run on a cadence without anyone watching a dashboard.

## Honest limits (state these to every buyer)

- **Approval cards still gate any computer-use action.** If the agent needs to touch a booking system, POS, or calendar via computer use, a human approves the action card in Muster first. Nothing executes unattended.
- **The WhatsApp channel only relays text replies.** No images, voice notes, buttons, or lists are sent back; customers get plain text answers.

## Prerequisites — Meta WhatsApp Cloud API credentials

All credentials come from the [Meta developer dashboard](https://developers.facebook.com/) (Your app → WhatsApp → API Setup) and are set as **deployment environment variables — never in files, never committed**.

| Env var | What it is |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Cloud API access token (system-user token) |
| `WHATSAPP_PHONE_NUMBER_ID` | ID of the business phone number |
| `WHATSAPP_VERIFY_TOKEN` | Any string you choose, for webhook verification |
| `WHATSAPP_APP_SECRET` | App secret, used to verify webhook payload signatures |
| `WHATSAPP_BOT_ID` | The Muster bot ID this channel is attached to |

## One-day setup

1. **Morning (45 min):** In the Meta developer dashboard, create an app, add the WhatsApp product, note the phone number ID, generate a system-user access token, copy the app secret. Store all five values in the deployment environment (secret manager / host env vars) — not in any repo file.
2. **Late morning (30 min):** Import the chosen pack (below) into Muster as a team; fill in the business's hours, menu or service list, and booking policy in the member prompt.
3. **Midday (30 min):** Point the Meta webhook at your Muster WhatsApp channel endpoint, subscribe to `messages`, and set the verify token. Send the test message from the dashboard.
4. **Afternoon (30 min):** Enable the pack's sentry routine, pick the schedule and delivery chat, and dry-run it once.
5. **Wrap-up (30 min):** Walk the owner through what the agent will and won't do, test 5–10 real customer phrasings, and set the escalation wording the owner wants.

## Selling it as a managed service

- **Setup fee:** charge a flat one-day build (a day of your time covers both packs plus tuning).
- **Monthly retainer:** bill for monitoring + prompt/policy updates + Meta conversation costs passed through at cost plus a margin. Meta prices per conversation (marketing/utility/service categories vary by market) — check current rates before quoting, and put a usage cap in the contract.
- **Scope guard:** quote the customer on text answering + scheduled summaries only. Anything requiring computer-use bookings is quoted separately, since every action is human-approved and adds handling time.
- **Renewal hook:** the monthly bookings/summary reports the sentries produce are the value proof — include them in every invoice.

## Packs

- [`restaurant-host.muster.team`](./restaurant-host.muster.team) — reservations, menu/hours questions, booking confirmations.
- [`salon-concierge.muster.team`](./salon-concierge.muster.team) — bookings, cancellations, service menu, deposit reminders.
