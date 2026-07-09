# GitHub Auth

Sign in to a shared Recursive workspace with GitHub and inherit your role from a
linked repository's collaborator permissions. Proves the **AuthProvider plugin
seam** (Phase A2): identity + permissions are pluggable, and GitHub ships as a
plugin with **zero core edits**.

## What it does

- **Zero-admin onboarding.** Link the workspace to a repo (`org/name`). Anyone
  with repo access can sign in with GitHub and lands at their repo-derived role:

  | GitHub permission | Workspace role |
  | --- | --- |
  | `admin` | `admin` |
  | `maintain`, `push` (write) | `member` |
  | `triage`, `pull` (read) | `guest` |
  | none / not a collaborator | denied |

- **Two sign-in flows.** Device flow for the host owner/admin (no public
  callback — works on a residential Mac). Authorization-code web flow for
  invited guests via the licensing-worker trampoline.
- **Auto-suspend on revoke.** A member removed from the repo upstream is
  suspended on the next directory sync / refresh.
- **Directory sync.** `Sync now` pulls the collaborator list and pre-populates
  the roster at each person's repo-derived role.

## How it plugs in

Declares `provides.auth_provider` in `plugin.json` and ships `provider.ts`
implementing `AuthProvider` from `@recursive/core-identity/auth` (a **type-only**
import). The core-identity provider-registry compiles + instantiates it — exactly
like a `sync_provider`. Roles flow through the shared `CAPABILITY_MATRIX`; the
role-precedence policy (`provider_wins` by default) decides how repo roles
combine with any local invites. `execute_agents` (drive agent sessions on the
host) is surfaced in the invite consent UI.

## Configuration

GitHub App (recommended — installation-scoped, org-approvable) or a personal
access token fallback. See the plugin settings for App id / installation id /
private key, or the PAT, plus the linked repo, an optional role-map override, and
the sync interval.

## Relationship to `github-integration`

`github-integration` stays webhook-only (triggers). This plugin is identity +
permissions only. They can share org/App credentials but do not depend on each
other.
