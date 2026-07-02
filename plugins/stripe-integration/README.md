# Stripe integration

Fire Recursive automations from Stripe. A checkout completes, an invoice
payment fails, a customer disputes a charge — the webhook delivery lands as an
event-mode automation and an agent picks it up.

> Event-triggered automations are a **Pro/Teams** capability. Creating a
> Stripe-triggered automation requires a valid license (feature
> `automation-triggers`).

## How it works

This plugin is a **trigger source**: its `triggers.module`
(`triggers/index.ts`) exports `verify()` and `normalize()`, which the core
inbound ingress route calls. No core change is needed to add Stripe — the
plugin fully describes the integration.

```
Stripe webhook ──▶ https://<your-box>.recursive.computer
              POST /api/triggers/inbound/stripe-integration/<connectionId>
   ├─ verify()    — Stripe-Signature header: t=<ts>,v1=<sig> where
   │                v1 = HMAC-SHA256(signing_secret, "<ts>.<raw body>"),
   │                constant-time compare, 5-minute replay window on t
   ├─ normalize() — Stripe event → NormalizedTriggerEvent (amounts formatted
   │                from cents, dashboard permalink, filter keys)
   └─ core matches subscribed event-mode automations (+ filters) and
      dispatches an agent session per match (same path as the scheduler)
```

## Events

`event_type` is the Stripe event's `type` field:

| `event_type` | Fires when |
| --- | --- |
| `checkout.session.completed` | A Checkout Session finished successfully |
| `invoice.payment_failed` | A payment attempt for an invoice failed |
| `customer.subscription.created` | A customer started a new subscription |
| `customer.subscription.deleted` | A subscription ended or was canceled |
| `charge.refunded` | A charge was fully or partially refunded |
| `charge.dispute.created` | A customer disputed a charge (chargeback) |

Other Stripe event types the endpoint is subscribed to are normalized too
(with a generic title), so an automation can target any `type` string —
the six above are the ones surfaced in the automation editor's catalog.

## Credentials

Credentials live in **plugin settings** (the onboarding wizard collects them,
or Settings → Plugins → Stripe):

- **`signing_secret`** (required) — the webhook endpoint's **Signing secret**
  (`whsec_…`, from Developers → Webhooks → your endpoint → Signing secret →
  Reveal). This is what `verify()` checks on every inbound request. It is a
  plugin-level setting, **not** a per-automation `secret` field — that field
  exists only for the builtin generic webhook. Note each endpoint (and each
  test/live mode) has its **own** signing secret.

## Setup

The `connecting-stripe` skill (`skills/connecting-stripe/`) walks an agent
through this end-to-end. In short — order matters, because the secret and
automation must exist before Stripe's first signed delivery:

1. In the Stripe Dashboard: **Developers → Webhooks → Add endpoint** with
   - Endpoint URL
     `https://<your-box>.recursive.computer/api/triggers/inbound/stripe-integration/<connection_id>`
     (pick a stable `connection_id`, e.g. `default` — reused in step 3)
   - Events: select the ones you care about (e.g. `checkout.session.completed`,
     `invoice.payment_failed`, `customer.subscription.*`, `charge.refunded`,
     `charge.dispute.created`)
   - Mind the **test / live mode toggle** — endpoints only receive events for
     the mode they were created in.
2. On the endpoint's page, reveal the **Signing secret** (`whsec_…`) and store
   it as **Signing Secret** in plugin settings (onboarding wizard, plugin
   settings UI, or `PUT /api/plugin-settings/stripe-integration`).
3. In Recursive, create an automation with an **event** trigger:
   - `plugin_id: stripe-integration`
   - `event_type: checkout.session.completed` (or any type above)
   - `connection_id`: the same id used in the URL (e.g. `default`)
   - optional `filters`, e.g. `{ "livemode": "true", "currency": "usd" }`
4. Use the endpoint page's **Send test webhook** to fire a signed test event.
   Stripe has no URL-verification handshake — the first successfully signed
   delivery is the verification.

Example automation prompt: *"A Stripe payment failed. Look up the customer and
invoice in the event payload, summarize what happened, and draft a dunning
email."* The triggering event (title, dashboard permalink, raw payload) is
injected beneath the prompt when the session spawns, so the agent sees exactly
what fired it.

## Filters

`normalize()` populates a `match` map: `event_type`, `livemode` (`"true"` /
`"false"` — useful to keep test events from firing production automations),
`currency` (lowercase ISO code), `customer` (`cus_…` id), and `account`
(Connect account id, when present). An automation's `filters` must all equal
the corresponding `match` values for it to fire. No filters → fires on every
event of that type for the connection.

## Troubleshooting

- **401 Signature verification failed** — the signing secret in plugin
  settings doesn't match the endpoint's `whsec_…` value. Common causes: the
  secret from a *different* endpoint (each endpoint has its own), the test-mode
  secret used against a live-mode endpoint (or vice versa), a rolled secret
  that wasn't updated, or a proxy re-serializing the JSON body (the HMAC is
  over the exact raw bytes).
- **401 Stale Stripe request (replay window exceeded)** — the `t=` timestamp
  in the signature header is more than 5 minutes off. Usually clock skew on
  the Recursive host, or a very old retried delivery; check NTP.
- **202 with `dispatched: 0`** — the request verified fine but no enabled
  automation matched: no event trigger for this `plugin_id` +
  `connection_id` + `event_type`, or the automation's `filters` didn't equal
  the event's `match` values (e.g. `livemode` filter vs a test event).
- **Stripe shows the delivery as failed** — Recursive wasn't reachable at the
  Payload URL. Confirm the Remote Access URL is public and the path is
  exactly `/api/triggers/inbound/stripe-integration/<connection_id>`.

## Following up in Stripe

`normalize()` carries the full Stripe event (ids, amounts, customer, and the
complete payload) in the event's `raw` field, so the dispatched agent can look
up objects or act via the Stripe CLI/API with credentials it already has.
Automatic post-back is not part of this plugin — webhooks are one-way.
