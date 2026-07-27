---
name: connecting-github
title: Connecting GitHub
description: "Walks through connecting a GitHub repository to Recursive end-to-end: store the Webhook Secret in plugin settings, create the event automation, add the repository webhook pointed at the inbound trigger URL, and verify via GitHub's ping delivery. Use when the user wants issues, pull requests, pushes, comments, or releases to trigger automations."
---

# Connecting GitHub

Wire a GitHub repository (or org) to Recursive so issues, pull requests,
pushes, comments, and releases fire event-mode automations. Follow the steps
**in order** — the Webhook Secret and the automation must exist in Recursive
*before* GitHub sends its one-time `ping` delivery, or the ping fails
signature verification and the webhook shows a red ✕.

## Prerequisites

- The **github-integration** plugin is installed and enabled.
- A **Pro or Teams license** (event-triggered automations require the
  `automation-triggers` feature).
- A **public Remote Access URL** for this Recursive instance (Settings →
  Remote Access), e.g. `https://<your-box>.recursive.computer`. GitHub must be
  able to reach it.
- Admin access to the target repository (or org) — webhooks live under
  Settings → Webhooks.

## Step 1 — Generate and store the Webhook Secret

Generate a random secret (e.g. `openssl rand -hex 32`). Store it in the
**plugin's settings** — NOT in any per-automation `secret` field (that field
only exists for the builtin generic webhook):

- UI: Settings → Plugins → GitHub (or the plugin's onboarding wizard), field
  **Webhook Secret** (`webhook_secret`).
- API: `PUT /api/plugin-settings/github-integration` with
  `{ "webhook_secret": "<value>" }`.

Keep the value handy — Step 4 pastes the same string into GitHub.

Optionally store a **GitHub Token** (`github_token`, a fine-grained PAT or
classic `ghp_…` token) — it is used only for agents to post results back
(issue/PR comments), never for webhook verification.

## Step 2 — Create the event automation

Pick a stable `connection_id` (convention: `default`). Create the automation
with `automation_create`:

```json
{
  "name": "GitHub issues",
  "prompt": "Read the triggering GitHub event and do what it asks.",
  "triggers": [
    {
      "mode": "event",
      "plugin_id": "github-integration",
      "event_type": "issues",
      "connection_id": "default",
      "filters": { "action": "opened" }
    }
  ]
}
```

- `event_type` is one of `issues`, `issue_comment`, `pull_request`, `push`,
  `release` — the value of GitHub's `X-GitHub-Event` header.
- Optional `filters` narrow which events fire the automation. All filter
  entries must match; omit to fire on every event of that type. Supported keys:
  - `repo` — repository full name, e.g. `"acme/web"`
  - `action` — the payload's action, e.g. `"opened"`, `"closed"`,
    `"published"` (not applicable to `push`)
  - `sender` — GitHub login of the user who triggered the event
  - `branch` — branch or tag name, `push` events only, e.g. `"main"`
- The triggering event (title, permalink, raw payload) is injected beneath the
  prompt when the session spawns, so the prompt can stay open-ended.

## Step 3 — Add the webhook in GitHub

In the repository: **Settings → Webhooks → Add webhook** (or org-level
Settings → Webhooks to cover every repo in the org). Configure:

- **Payload URL**:

  ```
  <Remote Access URL>/api/triggers/inbound/github-integration/<connection_id>
  ```

  e.g. `https://<your-box>.recursive.computer/api/triggers/inbound/github-integration/default`.
- **Content type**: `application/json` (required — the default
  `application/x-www-form-urlencoded` is not supported).
- **Secret**: the exact value stored in Step 1.
- **SSL verification**: leave enabled.

## Step 4 — Choose the events

Under "Which events would you like to trigger this webhook?" pick **Let me
select individual events** and check the ones your automations subscribe to:
Issues, Issue comments, Pull requests, Pushes, Releases. (Sending extra event
types is harmless — unsubscribed types are accepted and ignored.)

Click **Add webhook**.

## Step 5 — Verify

GitHub immediately sends a signed `ping` delivery. Because the Webhook Secret
is already stored (Step 1), Recursive verifies the signature and answers
`{"ok":true,"message":"pong"}` — the webhook's Recent Deliveries shows a
green ✓. Then trigger a real event (e.g. open an issue). Within a few seconds
a new session should appear in Recursive with the automation's prompt plus a
"Triggering event" block containing the issue.

If nothing fires, check the webhook's **Recent Deliveries** in GitHub:

- **401** — Webhook Secret mismatch: the value in plugin settings differs
  from the webhook's Secret field, or the secret was saved after the delivery.
  Fix the setting and use "Redeliver".
- **202 with `"dispatched": 0`** — the request verified, but no automation
  matched: the automation is disabled, its trigger's `connection_id` doesn't
  match the URL segment, the `event_type` differs, or a `filters` entry
  excluded the event (e.g. `action: "opened"` on an `edited` delivery).
- **404** — the plugin is disabled, or the Payload URL's plugin id segment is
  wrong (`github-integration`).
- **Timeout / connection error** — the Remote Access URL is not reachable
  from the internet; re-check Settings → Remote Access.
