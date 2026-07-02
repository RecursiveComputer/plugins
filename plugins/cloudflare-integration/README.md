# Cloudflare integration

Fire Recursive automations from Cloudflare Notifications. A Pages deploy
fails, a health check flips, a DDoS alert fires — the notification lands as a
webhook delivery and an event-mode automation picks it up and runs an agent.

> Event-triggered automations are a **Pro/Teams** capability. Creating a
> Cloudflare-triggered automation requires a valid license (feature
> `automation-triggers`).

## How it works

This plugin is a **trigger source**: its `triggers.module`
(`triggers/index.ts`) exports `verify()` and `normalize()`, which the core
inbound ingress route calls. No core change is needed to add Cloudflare — the
plugin fully describes the integration.

```
Cloudflare notification ──▶ https://<your-box>.recursive.computer
            POST /api/triggers/inbound/cloudflare-integration/<connectionId>
   ├─ verify()    — cf-webhook-auth shared-secret check (constant-time),
   │                and the one-time destination-creation test delivery
   ├─ normalize() — notification → NormalizedTriggerEvent(s): the generic
   │                `alert` event plus a typed convenience event
   │                (deployment / health_check / security) by alert_type
   └─ core matches subscribed event-mode automations (+ filters) and
      dispatches an agent session per match (same path as the scheduler)
```

## Credentials

Credentials live in **plugin settings** (the onboarding wizard collects them,
or Settings → Plugins → Cloudflare):

- **`webhook_secret`** (required) — the shared secret you set on the
  Cloudflare webhook destination (Notifications → Destinations → Webhooks).
  Cloudflare sends it verbatim in the `cf-webhook-auth` header on every
  delivery (plain shared secret, **not** an HMAC signature); `verify()` checks
  it with a constant-time compare. It is a plugin-level setting, **not** a
  per-automation `secret` field — that field exists only for the builtin
  generic webhook.

## Setup

The `connecting-cloudflare` skill (`skills/connecting-cloudflare/`) walks an
agent through this end-to-end. In short — order matters, because the secret
and automation must exist before Cloudflare sends its destination-creation
test delivery:

1. Store a strong random **Webhook Secret** in plugin settings (onboarding
   wizard, plugin settings UI, or
   `PUT /api/plugin-settings/cloudflare-integration`).
2. In Recursive, create an automation with an **event** trigger:
   - `plugin_id: cloudflare-integration`
   - `event_type: alert` (any notification), or `deployment` /
     `health_check` / `security`
   - `connection_id`: any stable id (e.g. `default`) — reused in the URL below
   - optional `filters`, e.g. `{ "project": "my-pages-app" }`
3. In the Cloudflare dashboard, create a **Webhooks destination**
   (Notifications → Destinations) with the URL
   `https://<your-box>.recursive.computer/api/triggers/inbound/cloudflare-integration/<connectionId>`
   and the same secret (Cloudflare tests it once on save — the plugin answers
   the test delivery without dispatching anything).
4. Create a **Notification policy** for the alert types you care about and
   point it at that destination.

The automation prompt can be open-ended — e.g. *"Read this Cloudflare
notification and investigate."* The triggering notification (title, summary,
raw payload) is injected beneath the prompt when the session spawns, so the
agent sees exactly what fired it.

## Events and filters

`normalize()` buckets Cloudflare's `alert_type` into typed events and always
emits the generic `alert` event alongside:

| `event_type` | Fires on |
|---|---|
| `alert` | Every notification (catch-all). |
| `deployment` | `pages_*` / `workers_*` / deploy alert types. |
| `health_check` | `health_check*` alert types. |
| `security` | DoS/DDoS, firewall, WAF, security-insights alert types. |

`normalize()` populates a `match` map (`alert_type`, `account_id`,
`policy_id`, `zone`, `project` — whichever the payload carries). An
automation's `filters` must all equal the corresponding `match` values for it
to fire. No filters → fires on every event of that type for the connection.
Pages alerts carry the project name as `project` (also used as the event's
`project_hint`).

Payload shapes vary by alert type, so normalization is defensive: unknown or
partial shapes still emit a valid `alert` event with whatever fields were
present.
