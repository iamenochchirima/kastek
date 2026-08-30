# LinkedIn Page Connections

**Status:** Completed

**Owner:** Engineering

**Last updated:** 2026-08-30

## Objective

Allow a workspace administrator to authorize LinkedIn once, discover the member profile and all
eligible Company Pages through LinkedIn's supported organization APIs, connect them as distinct
workspace channels, and publish text and image posts with the selected LinkedIn actor.

## Scope

### Included

- One LinkedIn OAuth authorization for member and organization access.
- Discovery of approved organization roles and public Page details.
- Discovery of the authenticated LinkedIn member profile in the same callback.
- Persistence of Page channels without a database schema change.
- Page-aware connection inventory and composer selection.
- Text and image publishing through LinkedIn's current Posts API.
- Provider error handling, structured lifecycle logs, documentation, and release evidence.

### Excluded

- LinkedIn Page analytics, inbox, comments, or follower management.
- Automatic granting or changing of a user's LinkedIn Page role.
- Migration of existing personal LinkedIn connections into Page connections.

## Context and constraints

- Existing personal LinkedIn connections must continue to publish as `urn:li:person:*`.
- Page connections use `urn:li:organization:*` and share the OAuth token authorized by the member.
- LinkedIn may require Community Management API access before organization scopes are granted.
- No schema migration is required; `SocialChannelConnection.metadata` already stores the actor URN
  and provider-specific identity data.

## Implementation plan

1. [x] Understand the current OAuth, connection, composer, and publishing boundaries.
2. [x] Replace target-specific OAuth with one combined member and organization authorization.
3. [x] Discover and persist the member profile and eligible Pages in one callback.
4. [x] Simplify the connection surface to one LinkedIn action.
5. [x] Publish text and image posts with a selected LinkedIn actor through the current Posts API.
6. [x] Update runbooks and public feature documentation.
7. [x] Run lint, tests, build checks, and record release/rollback evidence.

## Verification

- [x] Rust format and targeted tests: `cargo fmt --all -- --check`, `cargo check -p kasitek-core`, and `cargo test -p kasitek-core` passed; 201 passed and 3 ignored.
- [x] Client lint and production build: ESLint passed with one pre-existing unrelated warning; `pnpm exec next build --webpack` passed.
- [x] Public documentation build: `pnpm build` in `docs/public` passed.
- [x] No-schema-migration check: existing `SocialChannelConnection.metadata` stores the member/Page actor URN and provider identity; no migration expected.
- [ ] Provider setup and live OAuth smoke test after LinkedIn permissions are approved; this remains an external release prerequisite.

## Release record

```text
Change: Consolidate LinkedIn member and Company Page connections into one OAuth flow.
Owner: Engineering
Risk: standard
Affected services and user surfaces: kasitek-core social OAuth/publishing; client Connections and Content surfaces.
Platform release version or release ID: Core Railway deployment 6d5760e1-272c-4463-b04e-ee6a493262cf; deployed commit 713e352d677a4b06075c1761d9af1bd2828b76cb.
API/schema/migration changes: Combined LinkedIn member/organization OAuth scopes and REST organization/posts calls; no database migration.
Feature flag or rollout method: provider permission-gated; no feature flag required for initial rollout.
Analytics events and success metrics: not applicable; existing connection and publish outcomes remain the metrics surface.
Logs, metrics, dashboards, and alerts: structured provider OAuth/discovery failures; existing connection/publish observability; no new dashboard.
User, API, internal, and operational documentation: update LinkedIn connection runbook and implemented-features documentation.
Validation evidence: backend check/tests, client lint, webpack production build, and public docs build passed on 2026-08-30. Core `/health` returned HTTP 200 after deployment; Vercel reported the connected frontend deployments completed. Live Page OAuth remains pending LinkedIn app permission approval.
Rollback or disable plan: stop exposing the combined LinkedIn action or remove the organization scopes from AUTH_LINKEDIN_SCOPES; existing saved connections remain usable.
Post-release review date: to be scheduled after the first live Page connection.
```

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Page selection | LinkedIn does not provide a Meta-style Page picker in OAuth. One authorization imports all approved Pages; each is independently selectable as a content channel. | Engineering | Decided |
| Page analytics | Keep outside this change until the organization analytics permissions and API contract are verified. | Engineering | Decided |
| LinkedIn access | Require Community Management organization permissions in the LinkedIn developer app. | Product/Engineering | Open with provider |

## Notes and blockers

LinkedIn developer-app approval for organization permissions is an external release dependency. The
code is implemented and verified locally, but live Page discovery cannot succeed until LinkedIn grants
the requested access to the app and the member has an approved Page role.
