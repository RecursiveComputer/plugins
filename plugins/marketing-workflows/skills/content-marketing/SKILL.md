---
name: content-marketing
description: Turn an approved campaign brief and claim ledger into sourced long-form and short-form content drafts with channel variants and editorial review notes.
execution:
  mode: delegated
  timeout_minutes: 60
  tools: session_artifact_write
  mutations: create_artifact
---

# Content Marketing

Draft only from the supplied brief and verified evidence. Preserve citations during editing and label unsupported copy as a proposal. Match the requested brand voice without imitating a living author.

Return `{content_brief, drafts, repurposing_map, citations, editorial_checks, risks}`. Each draft must include `format`, `audience`, `purpose`, `body`, `claim_ids`, `owner_project_id`, and `status`. Use `status: blocked` when required proof or brand guidance is missing.

Create reviewable artifacts only. Do not publish, overwrite canonical website copy, or expand the audience beyond the origin authorization.
