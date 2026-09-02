# Bluesky OAuth Scope Fix

**Status:** Complete

**Owner:** Platform integrations

**Last updated:** 2026-09-02

## Objective

Prevent Bluesky authorization from requesting undeclared AT Protocol permissions. Bluesky
publishing and deletion must remain requestable, while unsupported messaging access must not be
offered to users or sent to the provider.

## Scope

### Included

- Align the Bluesky provider adapter and connection access list with the client metadata scopes.
- Add a regression test for the `transition:chat.bsky` invalid-scope failure.
- Update the affected documentation and release record.

### Excluded

- Implementing Bluesky Chat support or changing AT Protocol client metadata to add it.
- TikTok, Threads, or batch publishing behavior.
- Vercel deployment.

## Context and constraints

- The reported provider error is `invalid_scope`: `transition:chat.bsky` is not declared in the
  current Bluesky client metadata.
- Bluesky post publishing and deletion use the declared `repo:app.bsky.feed.post` grant.
- Unsupported capabilities must be represented as unsupported, not as requestable missing access.
- No provider token or client credential may be logged or copied into user-facing diagnostics.

## Implementation plan

1. [x] Reproduce the invalid Bluesky scope with a deterministic adapter/access-list test.
2. [x] Remove the undeclared messaging request from the Bluesky capability and UI access list.
3. [x] Add regression coverage and update documentation.
4. [x] Run verification, commit, and push the fix.

## Verification

- [x] Targeted Bluesky tests: invalid Chat scope regression passed.
- [x] Full Core tests/build: 258 passed, 3 environment-dependent ignored; build passed.
- [x] Frontend changed-file lint/build: changed-file ESLint and client production build passed.
- [x] Diff checks: rustfmt and `git diff --check` passed.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Bluesky Chat | Not supported until a declared client-metadata permission and adapter exist. | Platform integrations | Decided |

## Release record

Change: Stop Bluesky OAuth from requesting the undeclared `transition:chat.bsky` scope.

Owner: Platform integrations.

Risk: low.

Affected services and user surfaces: `kasitek-core`; Connections access panel; Bluesky OAuth.

Platform release version or release ID: implementation commit `757e4dd9`.

API/schema/migration changes: not applicable.

Feature flag or rollout method: not applicable.

Analytics events and success metrics: not applicable; existing connection lifecycle analytics are
sufficient.

Logs, metrics, dashboards, and alerts: not applicable; this removes an invalid provider request.

User, API, internal, and operational documentation: updated `social-connections.md`,
`connection-failures.md`, and the Core README where the provider behavior is documented.

Validation evidence: the regression initially failed because Bluesky messaging was marked
requestable and emitted `transition:chat.bsky`; after the fix, targeted and full Core tests passed
(258 passed, 3 environment-dependent ignored), the Core build passed, frontend lint/build passed,
and formatting/diff checks passed.

Rollback or disable plan: revert the implementation commit.

Post-release review date: 2026-09-09.

## Notes and blockers

The implementation is ready for release. Vercel deployment remains user-owned; the server and
frontend changes are pushed together so they can be deployed from the same `main` revision.
