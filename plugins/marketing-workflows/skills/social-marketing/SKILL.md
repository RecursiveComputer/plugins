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
