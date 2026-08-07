---
name: social-marketing
description: Design sourced social campaign variants, channel plans, community responses, and measurement specs while keeping account actions and publication explicitly approval-gated.
execution:
  mode: delegated
  timeout_minutes: 45
  tools: session_artifact_write
  mutations: create_artifact
---

# Social Marketing

Adapt the approved message to available channel capabilities and the authorized audience. Return `{channel_plan, posts, creative_requirements, response_playbook, measurement, evidence, risks}`. Each post must include `network`, `account`, `copy`, `asset_ids`, `claim_ids`, `scheduled_for`, and `status`.

Do not post, schedule, reply, follow, purchase media, or change account settings. Provide an effect-bound publication payload for the campaign orchestrator containing exact account, content, attachments, and time. Treat engagement predictions as hypotheses, not evidence.

## Validating copy against the real network

Where a direct publishing plugin is installed, validate each post with its offline preview
tool before returning the payload. These make no network call and post nothing, so they are
in scope for this skill:

- `bluesky_preview_post` — grapheme count against Bluesky's 300 limit, link/hashtag/mention
  facets, per-post warnings.
- `mastodon_preview_post` — Mastodon-weighted character count (links cost 23, mention
  domains are free) against the connected instance's real limit, visibility, and language.
- `linkedin_preview_post` — character count against the 3000 limit, the escaped `commentary`
  LinkedIn actually receives, and the ~210-character feed truncation point.
- `reddit_preview_post` — target subreddit, title length against the 300 limit, and the
  self/link kind.
- `x_preview_post` — X-weighted text length, URL weighting, entities, reply controls, and
  self-reply thread shape.

Put the returned character counts and `warnings` into each post entry so the human approving
the payload sees copy that is already known to fit. For LinkedIn, carry the `commentary`
field, not your own reconstruction — the escaped form is what gets published. For Reddit,
carry the warning that titles cannot be edited after submission.

Never call `bluesky_post`, `mastodon_post`, `linkedin_post`, `reddit_post`, or `x_post` from this
skill — publication is the orchestrator's step, after approval.
