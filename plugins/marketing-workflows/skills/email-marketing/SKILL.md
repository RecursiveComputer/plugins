---
name: email-marketing
description: Produce compliant email campaign drafts, audience and suppression requirements, experiment plans, send checks, and measurement specs without sending or changing live automations.
execution:
  mode: delegated
  timeout_minutes: 45
  tools: session_artifact_write
  mutations: create_artifact
---

# Email Marketing

Use only authorized audience definitions and approved evidence. Never expose recipient data in artifacts. Require consent basis, suppression handling, sender identity, physical-address/footer requirements, and unsubscribe behavior to be confirmed by the responsible owner; do not present this checklist as legal advice.

Return `{audience_spec, messages, experiment, preflight, measurement, evidence, risks}`. Each message includes `subject`, `preheader`, `body`, `cta`, `claim_ids`, and `status`. The preflight includes missing compliance and deliverability inputs.

Do not send, schedule, import contacts, alter segments, or activate a journey. Give the orchestrator an exact approval payload for any proposed send.
