---
name: connecting-cloudflare
description: "Walks through connecting Cloudflare Notifications to Recursive end-to-end: store the webhook secret in plugin settings, create the event automation, create the Cloudflare webhook destination pointed at the inbound trigger URL, and wire a Notification policy to it. Use when the user wants Cloudflare deploy alerts, health checks, or security events to trigger automations."
---

# Connecting Cloudflare

Wire Cloudflare Notifications to Recursive so deploy alerts, health-check
status changes, and security events fire event-mode automations. Follow the
steps **in order** — the webhook secret and the automation must exist in
Recursive *before* you save the webhook destination in Cloudflare, because
saving the destination immediately fires a one-time test delivery that must
pass secret verification.

## Prerequisites

- The **cloudflare-integration** plugin is installed and enabled.
- A **Pro or Teams license** (event-triggered automations require the
  `automation-triggers` feature).
- A **public Remote Access URL** for this Recursive instance (Settings →
  Remote Access), e.g. `https://<your-box>.recursive.computer`. Cloudflare
  must be able to reach it.
- A Cloudflare account with access to **Notifications** (dash.cloudflare.com).

## Step 1 — Store the Webhook Secret in plugin settings

Choose a strong random string (e.g. `openssl rand -hex 32`). Store it in the
**plugin's settings** — NOT in any per-automation `secret` field (that field
only exists for the builtin generic webhook):

- UI: Settings → Plugins → Cloudflare (or the plugin's onboarding wizard),
  field **Webhook Secret** (`webhook_secret`).
- API: `PUT /api/plugin-settings/cloudflare-integration` with
  `{ "webhook_secret": "<value>" }`.

Cloudflare sends this secret verbatim in the `cf-webhook-auth` header on every
delivery (it is a shared secret, not an HMAC signature); `verify()` checks it
with a constant-time compare.

## Step 2 — Create the event automation

Pick a stable `connection_id` (convention: `default`). Create the automation
with `automation_create`:

```json
{
  "name": "Cloudflare deploy alerts",
  "prompt": "Read the triggering Cloudflare notification and investigate or act on it.",
  "triggers": [
    {
      "mode": "event",
      "plugin_id": "cloudflare-integration",
      "event_type": "deployment",
      "connection_id": "default"
    }
  ]
}
```

- `event_type` is one of:
  - `alert` — **any** Cloudflare notification (every delivery fires it).
  - `deployment` — Pages / Workers deploy alerts (`pages_*` / `workers_*`
    alert types).
  - `health_check` — health-check status notifications.
  - `security` — DoS/DDoS, firewall, WAF, and security-insights alerts.
- Optional `filters` narrow which events fire the automation, e.g.
  `"filters": { "project": "my-pages-app" }` or
  `"filters": { "alert_type": "health_check_status_notification" }`
  (supported keys: `alert_type`, `account_id`, `policy_id`, `zone`,
  `project`). All filter entries must match; omit to fire on every event of
  that type.
- The triggering notification (title, summary, raw payload) is injected
  beneath the prompt when the session spawns, so the prompt can stay
  open-ended.

## Step 3 — Create the webhook destination in Cloudflare

In the Cloudflare dashboard: **Notifications → Destinations → Webhooks →
Create**. Set:

- **URL**:

  ```
  <Remote Access URL>/api/triggers/inbound/cloudflare-integration/<connection_id>
  ```

  e.g. `https://<your-box>.recursive.computer/api/triggers/inbound/cloudflare-integration/default`.
- **Secret**: the exact value stored in Step 1.

When you click **Save and Test**, Cloudflare immediately sends a test
delivery; because the secret is already stored (Step 1), Recursive verifies it
and answers OK, Cloudflare marks the destination healthy, and the Recursive
connection is stamped verified. The test delivery does **not** dispatch any
automation.

## Step 4 — Create a Notification policy

Still in Cloudflare: **Notifications → Notifications (policies) → Add**. Pick
the alert type you care about (e.g. *Pages — deployment failed*, *Health
Checks status change*, *DDoS Attack L7*), and under delivery methods select
the **Webhooks destination** created in Step 3. Save.

## Step 5 — Verify

Trigger (or wait for) a matching alert — e.g. push a failing Pages deploy or
use the policy's test option where available. Within a few seconds a new
session should appear in Recursive with the automation's prompt plus a
"Triggering event" block containing the notification. If nothing fires:

- Check the automation is **enabled** and its trigger's `connection_id`
  matches the URL segment.
- Check the webhook destination's delivery history in Cloudflare (401 =
  webhook secret mismatch between plugin settings and the destination; 202
  with `"dispatched": 0` = no matching automation, or filters excluded the
  event).
- Remember every notification also emits the generic `alert` event — an
  automation on `event_type: "alert"` with no filters is a useful catch-all
  while debugging.
