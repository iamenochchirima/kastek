# Connection Permission State Fix

**Status:** Complete

**Owner:** Platform integrations

**Last updated:** 2026-09-02

## Objective

Make connection access status truthful and usable for Bluesky and Threads. Bluesky deletion must
not be shown as unsupported when the provider deletion path exists, and a successful Threads OAuth
connection must record enough verified scope information for the access panel to show the grants.

## Scope

### Included

- Advertise Bluesky published-content deletion through the shared capability adapter.
- Preserve and verify Threads scopes when the provider token response omits its scope field.
- Keep incremental Threads reauthorization additive and avoid treating an OAuth redirect as proof
  of permissions that were not requested or returned.
- Add regression tests, update user and operational documentation, and record the release.

### Excluded

- New frontend permission controls; the existing access sheet consumes the server snapshot.
- Provider app-review changes or account reconnection automation.
- Database schema or migration changes.

## Context and constraints

- The Bluesky delete operation already calls `com.atproto.repo.deleteRecord` through the account's
  PDS, but its capability adapter currently falls through to `unsupported()`.
- Threads token exchange responses may omit `scope`; the OAuth attempt retains the capability set
  used to build the consent request and can provide the fallback inventory for that attempt.
- Stored metadata must not contain access tokens in logs or user-facing responses.
- A scope fallback may only use the exact effective capabilities requested for the current OAuth
  attempt or the configured initial Threads scope set; it must not claim unrelated access.

## Implementation plan

1. [x] Reproduce the Bluesky unsupported state with a failing adapter test and isolate the Threads
   missing-scope state with a failing metadata test.
2. [x] Add the Bluesky delete capability mapping and Threads scope fallback at the callback/storage
   seam.
3. [x] Cover additive reauthorization, unsupported capabilities, and provider-scope normalization.
4. [x] Update public and internal documentation and complete the release record.
5. [x] Run targeted/full verification, commit, push, and deploy the tested Core artifact.

## Release record

Change: Correct provider capability and Threads OAuth permission inventory reporting.

Owner: Platform integrations.

Risk: standard.

Affected services and user surfaces: `kasitek-core`; Connections access panel; Threads and Bluesky
content authorization/deletion flows.

Platform release version or release ID: implementation commit `ccd82eba743205da188b1ef7e98a2f83f76f921f`;
Railway Core deployment `d3b4c93e-6b9b-4527-b5db-cce2b22eb08f`.

API/schema/migration changes: not applicable.

Feature flag or rollout method: not applicable; provider-specific backward-compatible behavior.

Analytics events and success metrics: not applicable; existing connection lifecycle and capability
analytics remain sufficient.

Logs, metrics, dashboards, and alerts: not applicable; no new failure mode or telemetry signal is
introduced. Existing provider errors remain bounded and redacted.

User, API, internal, and operational documentation: updated `social-connections.md`,
`connection-failures.md`, and the Core README.

Validation evidence: targeted permission tests pass; full Core suite passes (255 passed, 3
environment-dependent ignored); Core build, client production build, changed-file ESLint, rustfmt,
and diff checks pass.

Frontend production deployment: handed to the user; the client production build passed, and no
Vercel deployment was performed after the user requested to deploy the frontend themselves.

Rollback or disable plan: revert the implementation commit; existing publishing and deletion
paths remain available according to their prior capability declarations.

Post-release review date: 2026-09-09.

## Notes and blockers

No external blocker currently.
