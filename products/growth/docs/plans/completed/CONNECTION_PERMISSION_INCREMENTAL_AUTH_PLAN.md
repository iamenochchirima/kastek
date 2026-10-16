# Incremental connection permission authorization plan

**Status:** Completed

**Owner:** Platform Integrations

**Last updated:** 2026-09-02

## Objective

Allow users to grant connection permissions incrementally without losing permissions that were
already granted. A new OAuth authorization must request the union of the connection's current
verified grants and the newly selected capabilities. A provider response that is narrower than the
existing verified inventory must not silently downgrade the connection.

## Scope

- Shared access-request planning for OAuth-backed social connections.
- Provider scope construction for X and the other OAuth providers using the same access-request
  path.
- Callback persistence and downgrade protection.
- UI behavior that continues to allow selecting missing permissions without exposing provider
  scopes.
- Regression tests, documentation, release evidence, and deployment verification.

## Constraints

- Provider responses remain authoritative; the system must not invent grants that the provider did
  not return.
- Existing granted permissions must be included in a reauthorization request because OAuth token
  replacement can otherwise remove them.
- Unsupported and provider-approval permissions must never be added to a request.
- Credentials, raw tokens, and provider payloads must not appear in logs or user-facing responses.
- A provider that cannot represent incremental authorization must fail safely rather than replace a
  working token with a narrower token.

## Implementation approach

1. Extend the shared access-request plan with effective capabilities: the requested missing
   capabilities plus currently `GRANTED` capabilities for that connection.
2. Use effective capabilities at every OAuth start path and authorization-attempt record, including
   X, Threads, TikTok, LinkedIn, Meta, Instagram Login, and Bluesky.
3. Preserve the existing provider-returned permission inventory on callback when the callback has no
   usable scope/permission inventory or would narrow a verified inventory without explicit revocation.
4. Keep the UI's missing-permission selection model, while ensuring the server makes requests
   additive and the next access snapshot reflects the provider response.
5. Add a focused regression test for sequential X grants and shared tests for effective capability
   planning and narrow callback inventory handling.

## Release record

Change: Make OAuth connection permission requests additive and downgrade-safe.

Owner: Platform Integrations.

Risk: standard; affects OAuth callbacks and connection access state for existing providers.

Affected services and user surfaces: `kasitek-core`, Connections access panel, X and other OAuth
connection flows, Agent preflight that consumes connection permission state.

Platform release version or release ID: commit `68d4a43f008016008fd40e306e4bd694f5fc6c30`; Railway
Core deployment `8fea78c5-aeb1-49ab-9879-c7936e0ed5ba`.

API/schema/migration changes: not applicable; existing access-request and OAuth callback contracts
remain compatible.

Feature flag or rollout method: not applicable; additive behavior is safe for existing requests.

Analytics events and success metrics: reuse existing connection authorization-attempt lifecycle
events; success is a completed request whose verified permission inventory retains prior grants and
adds the requested grants.

Logs, metrics, dashboards, and alerts: reuse structured OAuth attempt and connection capability
events; verify no raw scopes, tokens, or provider payloads are logged. New dashboard/alert: not
applicable.

User, API, internal, and operational documentation: update the public social-connections guide and
connection-failure runbook to explain additive reauthorization and safe recovery.

Validation evidence: 254 Core tests passed (251 active, 3 environment-dependent ignored), Core
release build passed, formatting and diff checks passed, and the deployed Core `/health` endpoint
returned `status: ok`. A production X access snapshot still requires one user reauthorization.

Rollback or disable plan: revert the application commit. Existing tokens remain valid; do not
delete or mutate stored connection credentials during rollback.

Post-release review date: 2026-09-04.
