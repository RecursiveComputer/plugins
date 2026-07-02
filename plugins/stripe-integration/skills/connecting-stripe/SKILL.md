---
name: connecting-stripe
description: "Walks through connecting a Stripe account to Recursive end-to-end: add a webhook endpoint in the Stripe Dashboard, store the signing secret (whsec_) in plugin settings, create the event automation, and verify with a test webhook. Use when the user wants Stripe payment events (checkouts, failed payments, subscriptions, refunds, disputes) to trigger automations."
---

# Connecting Stripe

Wire a Stripe account to Recursive so payment events fire event-mode
automations. Follow the steps **in order** — create the Recursive automation
and store the signing secret *before* sending a test webhook, or the delivery
will be rejected (401) or accepted with nothing dispatched (`dispatched: 0`).

Unlike Slack, Stripe has **no URL-verification handshake** — the endpoint is
"verified" simply by the first successfully signed delivery. Use the
Dashboard's **Send test webhook** for that first delivery.

## Prerequisites

- The **stripe-integration** plugin is installed and enabled.
- A **Pro or Teams license** (event-triggered automations require the
  `automation-triggers` feature).
- A **public Remote Access URL** for this Recursive instance (Settings →
  Remote Access), e.g. `https://<your-box>.recursive.computer`. Stripe must
  be able to reach it.

## Step 1 — Add a webhook endpoint in Stripe

Have the user open https://dashboard.stripe.com/webhooks (**Developers →
Webhooks**) → **Add endpoint**. Set the **Endpoint URL** to:

```
<Remote Access URL>/api/triggers/inbound/stripe-integration/<connection_id>
```

e.g. `https://<your-box>.recursive.computer/api/triggers/inbound/stripe-integration/default`.
Pick a stable `connection_id` (convention: `default`) — it is reused in the
automation trigger below.

Mind the Dashboard's **test / live mode toggle**: endpoints created in test
mode only receive test events, and vice versa. Each mode's endpoint has its
own signing secret.

## Step 2 — Select events to send

Under **Select events to listen to**, add the events you want to trigger on
(these match the plugin's catalog):

- `checkout.session.completed`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`

Save the endpoint.

## Step 3 — Store the Signing Secret in plugin settings

On the endpoint's detail page: **Signing secret → Reveal** (`whsec_…`). Store
it in the **plugin's settings** — NOT in any per-automation `secret` field
(that field only exists for the builtin generic webhook):

- UI: Settings → Plugins → Stripe (or the plugin's onboarding wizard), field
  **Signing Secret** (`signing_secret`).
- API: `PUT /api/plugin-settings/stripe-integration` with
  `{ "signing_secret": "whsec_..." }`.

## Step 4 — Create the event automation

Create the automation with `automation_create`, using the same
`connection_id` as the URL:

```json
{
  "name": "Failed payments",
  "prompt": "A Stripe payment event fired. Read the triggering event and follow up appropriately.",
  "triggers": [
    {
      "mode": "event",
      "plugin_id": "stripe-integration",
      "event_type": "invoice.payment_failed",
      "connection_id": "default"
    }
  ]
}
```

- `event_type` is one of the six types above — matching is **exact** (no
  wildcards); add one trigger per event type you care about.
- Optional `filters` narrow which events fire the automation, e.g.
  `"filters": { "livemode": "true" }` to ignore test-mode events, or
  `{ "currency": "usd" }`, `{ "customer": "cus_..." }`,
  `{ "account": "acct_..." }` (Connect). All filter values are strings —
  `livemode` is `"true"` / `"false"`. All entries must match; omit to fire
  on every event of that type.
- The triggering event (formatted amount, customer, dashboard permalink, raw
  Stripe payload) is injected beneath the prompt when the session spawns, so
  the prompt can stay open-ended.

## Step 5 — Send a test webhook

On the endpoint's page in the Stripe Dashboard, use **Send test webhook**
(sometimes "Send test event") and pick one of the subscribed event types.
Recursive verifies the signature and responds `202`. A matching enabled
automation dispatches a session within a few seconds.

Note: dashboard test events are test-mode (`livemode: false`) — a
`{ "livemode": "true" }` filter will (correctly) exclude them, so verify
against an automation without that filter first.

## Step 6 — Verify

Trigger a real event (e.g. complete a test-mode Checkout) or rely on the test
webhook from Step 5. A new session should appear in Recursive with the
automation's prompt plus a "Triggering event" block. If nothing fires:

- **401** on the delivery (Stripe's endpoint page → recent deliveries):
  signing secret mismatch — wrong `whsec_` value, live-mode secret on a
  test-mode endpoint (or vice versa), or a proxy in front of Recursive is
  re-encoding the request body (signatures are computed over the exact raw
  bytes; any body transformation breaks them).
- **202 with `"dispatched": 0`**: no enabled automation matches — check the
  trigger's `connection_id` matches the URL segment, `event_type` exactly
  matches the delivered event, and filters (especially `livemode`) don't
  exclude it.
- **Nothing arrives at all**: test vs live mode confusion — confirm the
  event occurred in the same mode as the webhook endpoint, and the endpoint
  URL is reachable from the internet.
