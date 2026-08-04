---
name: marketing-campaign
description: Orchestrate an evidence-backed marketing campaign from a bound channel or Recursive session, especially requests such as "@Recursive launch this" that require project routing, coordinated specialist work, a single review package, publication approval, origin delivery, and performance follow-up.
execution:
  mode: managed
  timeout_minutes: 120
  tools: task_get, task_create, model_advise, session_delegate, todo_write, session_artifact_write, inbox_post, automation_create
  mutations: create_task, create_session, create_artifact, create_decision, create_automation
---

# Marketing Campaign

Treat this Skill as a finite campaign procedure, never as a durable specialist identity. Preserve the originating channel, conversation, principal, audience, and requested delivery target throughout the run.

## Contract

1. Freeze a brief containing objective, audience, offer, constraints, claims, channels, timing, budget, success metrics, and source provenance. Mark assumptions and unresolved claims explicitly.
2. Discover available Project Agent capability cards and optional integrations. Use explicit links, existing bindings, referenced resources, and channel defaults before capability matching. Ask one clarification only when routing remains materially ambiguous.
3. Delegate every project mutation to the owning Project Agent. The Workspace Agent may coordinate, read authorized evidence, and settle outcomes; it must not edit project-owned assets directly.
4. Invoke the smallest relevant set of `product-marketing`, `content-marketing`, `seo-marketing`, `social-marketing`, `email-marketing`, and `marketing-operations`. Pass the frozen brief, evidence ledger, authority ceiling, and required output schema to each.
5. Reconcile specialist outputs into one review package. Resolve contradictions; do not concatenate drafts or expose internal specialist identities.
6. Stop at the publication gate. Drafting, analysis, task creation, and reversible project edits may proceed within resolved authority. Sending email, publishing a site or social post, changing a production campaign, purchasing media, or scheduling an external send requires an effect-bound approval naming exact content, target, account, time, and effect.
7. After approval, delegate the exact approved effect to the owning Project Agent or connected plugin. A changed payload invalidates approval. If approval is absent, deliver the review package as ready for review without publishing.
8. Deliver progress, decisions, artifacts, and the final outcome to the originating conversation/thread by default. Never redirect private-channel evidence to a broader audience.
9. Schedule a performance follow-up only after the campaign has a real launch time. Use a persistent Recursive Automation, scoped to the campaign and origin, with a stable identifier. If scheduling authority or capability is unavailable, include a proposed follow-up and owner in the review package instead of claiming it was scheduled.

## Optional capabilities

Use installed plugins when authorized; absence must degrade to a concrete handoff:

- Notion or another knowledge plugin for approved briefs and source material.
- Product/project plugins for roadmap evidence and all project mutations.
- Website, social, and email plugins for previews and approved publication.
- Analytics plugins for baselines, instrumentation checks, and follow-up measurement.

Never require a named provider and never infer authority from plugin availability.

## Evidence ledger

Record each material claim as `{claim, status, source, observed_at, audience, owner}` where `status` is `verified`, `assumption`, `proposal`, or `blocked`. Cite primary product evidence and first-party analytics where possible. Do not fabricate customer proof, search volume, performance, legal approval, or attribution.

## Review package

Produce one structured artifact:

```json
{
  "campaign": { "objective": "", "audience": "", "offer": "", "status": "draft|awaiting_approval|approved|launched|blocked" },
  "routing": [{ "project_id": "", "outcome": "", "rationale": "", "task_ids": [] }],
  "evidence": [{ "claim": "", "status": "verified|assumption|proposal|blocked", "source": "", "observed_at": "", "audience": "", "owner": "" }],
  "deliverables": [{ "channel": "", "artifact_id": "", "owner_project_id": "", "status": "draft|ready|blocked" }],
  "measurement": { "primary_kpi": "", "baseline": null, "target": null, "instrumentation": [], "follow_up_at": null, "automation_id": null },
  "approval": { "required": true, "effect": "", "decision_id": null },
  "risks": [],
  "origin_delivery": { "conversation_key": "", "target": "", "status": "pending|delivered|failed" }
}
```

Do not mark the campaign `launched` without effect evidence and delivery confirmation.
