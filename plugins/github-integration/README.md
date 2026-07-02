# GitHub integration

Fire Recursive automations from GitHub. Open an issue, push a branch, cut a
release — an event-mode automation picks it up and runs an agent.

> Event-triggered automations are a **Pro/Teams** capability. Creating a
> GitHub-triggered automation requires a valid license (feature
> `automation-triggers`).

## How it works

This plugin is a **trigger source**: its `triggers.module`
(`triggers/index.ts`) exports `verify()` and `normalize()`, which the core
inbound ingress route calls. No core change is needed to add GitHub — the
plugin fully describes the integration.

```
GitHub webhook ──▶ https://<your-box>.recursive.computer
              POST /api/triggers/inbound/github-integration/<connectionId>
   ├─ verify()    — X-Hub-Signature-256 HMAC-SHA256 over the raw body,
   │                and the one-time `ping` handshake (answers "pong")
   ├─ normalize() — issues / issue_comment / pull_request / push / release
   │                → NormalizedTriggerEvent
   └─ core matches subscribed event-mode automations (+ filters) and
      dispatches an agent session per match (same path as the scheduler)
```

## Events

`event_type` is the value of GitHub's `X-GitHub-Event` header:

| `event_type` | Fires when |
| --- | --- |
| `issues` | An issue is opened, edited, closed, reopened, labeled, assigned… |
| `issue_comment` | A comment is created/edited/deleted on an issue or PR |
| `pull_request` | A PR is opened, edited, synchronized, closed, merged… |
| `push` | Commits are pushed to a branch or tag |
| `release` | A release is published, created, edited, deleted… |

The specific sub-action (`opened`, `closed`, `published`, …) is exposed as the
`action` filter key, not as a separate event type.

## Credentials

Credentials live in **plugin settings** (the onboarding wizard collects them,
or Settings → Plugins → GitHub):

- **`webhook_secret`** (required) — the webhook's Secret field (repository or
  org Settings → Webhooks). This is what `verify()` checks
  (`X-Hub-Signature-256`) on every inbound request, including the initial
  `ping`. It is a plugin-level setting, **not** a per-automation `secret`
  field — that field exists only for the builtin generic webhook.
- **`github_token`** (optional) — a fine-grained PAT or classic token
  (`github_pat_…` / `ghp_…`), used only for agents to post results back
  (issue/PR comments). Never used for webhook verification.

## Setup

The `connecting-github` skill (`skills/connecting-github/`) walks an agent
through this end-to-end. In short — order matters, because the secret and
automation must exist before GitHub sends its signed `ping` delivery:

1. Generate a random secret (`openssl rand -hex 32`) and store it as
   **Webhook Secret** in plugin settings (onboarding wizard, plugin settings
   UI, or `PUT /api/plugin-settings/github-integration`).
2. In Recursive, create an automation with an **event** trigger:
   - `plugin_id: github-integration`
   - `event_type: issues` (or `issue_comment` / `pull_request` / `push` /
     `release`)
   - `connection_id`: any stable id (e.g. `default`) — reused in the URL below
   - optional `filters`, e.g. `{ "action": "opened", "repo": "acme/web" }`
3. In the GitHub repo (or org): **Settings → Webhooks → Add webhook** with
   - Payload URL
     `https://<your-box>.recursive.computer/api/triggers/inbound/github-integration/<connectionId>`
   - Content type **application/json**
   - Secret = the same value stored in step 1
4. Select the individual events to send (Issues, Issue comments, Pull
   requests, Pushes, Releases) and add the webhook. GitHub sends a signed
   `ping` — the plugin answers it and the delivery shows green.

The automation prompt can be open-ended — e.g. *"Read this GitHub event and do
what it asks."* The triggering event (title, permalink, raw payload) is
injected beneath the prompt when the session spawns, so the agent sees exactly
what fired it.

## Filters

`normalize()` populates a `match` map: `event_type`, `repo` (full name, e.g.
`acme/web`), `action` (e.g. `opened` — absent on `push`), `sender` (GitHub
login), and `branch` (`push` only). An automation's `filters` must all equal
the corresponding `match` values for it to fire. No filters → fires on every
event of that type for the connection.

It also sets `project_hint` to the bare repository name so dispatch can route
the session at a matching Recursive project.

## Replying on GitHub (follow-up)

`normalize()` carries the reply coordinates (`repo`, `action`, `sender`, plus
the full payload with issue/PR numbers) in the event's `raw` field, so the
agent can see them. Automatic post-back of results using the configured
`github_token` is a planned follow-up; until then the agent can post back
itself (e.g. `gh issue comment`).
