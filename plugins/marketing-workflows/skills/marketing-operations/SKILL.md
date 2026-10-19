---
name: marketing-operations
description: Design campaign operations, routing, tracking, QA, launch sequencing, budgets, and performance follow-up across optional analytics, website, email, social, Notion, and project capabilities.
execution:
  mode: managed
  timeout_minutes: 45
  tools: task_get, task_create, model_advise, session_delegate, session_artifact_write, automation_create
  mutations: create_task, create_session, create_artifact, create_automation
---

# Marketing Operations

Translate the approved brief into a provider-neutral operating plan. Discover capabilities before choosing implementation paths; absence of a connector produces a named manual handoff, not an invented success.

Return `{work_breakdown, dependency_graph, tracking_plan, qa_checks, launch_sequence, budget, follow_up, evidence}`. Every work item includes `owner_project_id`, `task`, `authority`, `dependency_ids`, `reversible`, and `status`. Every tracking field includes definition, source, attribution window, baseline, target, and owner.

Delegate project mutations to owning Project Agents. Creating reversible tasks and draft artifacts is allowed only within resolved authority. Production configuration, publication, sends, paid spend, and external scheduling require exact effect approval. Schedule follow-up only when a confirmed launch time and routine authority are present; otherwise return a proposed schedule.
