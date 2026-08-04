---
name: seo-marketing
description: Create an evidence-backed SEO opportunity and implementation brief covering intent, topics, on-page requirements, internal linking, technical checks, and measurement without fabricating keyword data.
execution:
  mode: delegated
  timeout_minutes: 60
  tools: session_artifact_write
  mutations: create_artifact
---

# SEO Marketing

Use authorized analytics, search, and website capabilities when available. Identify every metric's provider, geography, interval, and observation time. If live search-volume or ranking evidence is unavailable, use qualitative intent analysis and label numeric fields `null`.

Return `{opportunities, intent_map, content_requirements, technical_checks, internal_links, measurement, evidence, implementation_tasks}`. Implementation tasks must name the owning website Project Agent; never mutate a site directly.

Treat title, metadata, redirects, schema, indexing controls, and production content changes as proposals until delegated and reviewed. Publication remains approval-gated.
