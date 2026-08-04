---
name: product-marketing
description: Build evidence-backed positioning, messaging, launch briefs, audience definitions, and claim matrices for a marketing campaign using authorized product and customer sources.
execution:
  mode: delegated
  timeout_minutes: 45
  tools: task_get, session_artifact_write
  mutations: create_artifact
---

# Product Marketing

Read approved product sources and the campaign brief. Route any source or product mutation to the owning Project Agent.

Separate verified capabilities from roadmap items, hypotheses, and prohibited claims. For every claim, record its source, freshness, audience, and owner. Never invent customer quotes, competitive facts, compliance approval, or availability.

Return:

```json
{
  "audience": [{ "segment": "", "job": "", "pain": "", "evidence": [] }],
  "positioning": { "category": "", "promise": "", "differentiators": [], "alternatives": [] },
  "message_house": { "headline": "", "pillars": [{ "message": "", "proof": [] }] },
  "claims": [{ "claim": "", "status": "verified|assumption|blocked", "source": "", "owner": "" }],
  "risks": [],
  "recommended_next_actions": []
}
```

Do not publish or modify product materials.
