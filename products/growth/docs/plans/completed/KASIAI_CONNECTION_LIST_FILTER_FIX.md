# KasiAi Connection List Filter Fix

**Status:** Complete

**Owner:** Platform engineering

**Last updated:** 2026-08-30

## Objective

Ensure KasiAi returns the same connected workspace accounts shown by the Connections page when
the model omits filters or uses an `all`/empty filter sentinel.

## Scope

### Included

- Normalize optional provider and status filters in the Agents tool and Core internal boundary.
- Clarify the protected KasiAi instruction to make one unfiltered workspace query.
- Add regression coverage and regenerate the capability contract documentation.

### Excluded

- Changes to connection storage, OAuth flows, provider credentials, or account synchronization.
- Changes to the Connections page data source.

## Context and constraints

- Existing connected-account records and organization scoping remain authoritative.
- The public Connections page uses Core's authenticated product boundary; KasiAi uses Core's
  delegated/internal agent boundary.
- Empty strings and `all` are compatibility inputs meaning no filter; actual provider and status
  values remain supported for filtered queries.

## Implementation plan

1. [x] Understand the current implementation and affected boundaries.
2. [x] Make the smallest coherent Agents and Core boundary changes.
3. [x] Update KasiAi guidance and generated capability documentation.
4. [x] Cover validation and compatibility edge cases without a migration.
5. [x] Verify the change and record the result.

## Verification

- [x] Lint or type check: Agents TypeScript build passed; Core formatting check passed. Client ESLint remains blocked by an unrelated pre-existing error in the dirty agent-details file.
- [x] Targeted tests: Agents suite passed with 444 tests; Core suite passed with 203 tests and 3 ignored database-dependent tests.
- [x] Build or runtime check: client production webpack build passed; production database inspection confirmed 14 connected accounts under the workspace organization.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Filter semantics | Omitted, empty, and case-insensitive `all` values mean no filter. | Platform engineering | Decided |
| Data model | No migration; existing connection records are unchanged. | Platform engineering | Decided |

## Release record

| Field | Decision |
| --- | --- |
| Change | Fix KasiAi workspace connection discovery when models emit empty or `all` filters. |
| Owner | Platform engineering |
| Risk | low |
| Affected services and user surfaces | Agents API/worker, Core internal agent boundary, KasiAi chat, generated capability documentation. |
| Platform release version or release ID | `kasiai-initial-v9-connection-filters`; platform release ID not applicable in this uncommitted change. |
| API/schema/migration changes | Tool input compatibility widened for empty filter strings; Core normalizes empty/`all`; no database migration. |
| Feature flag or rollout method | Not applicable; protected KasiAi version release/rollout is the deployment gate. |
| Analytics events and success metrics | Not applicable; existing connection-list request logs and analytics remain sufficient. |
| Logs, metrics, dashboards, and alerts | Not applicable; no new failure mode or telemetry signal. |
| User, API, internal, and operational documentation | Regenerated `agents/docs/generated-capabilities.md`; this plan records the operational change. |
| Validation evidence | Agents full suite (444 passed) and TypeScript build passed; Core `cargo test -p kasitek-core` (203 passed, 3 ignored) and `cargo fmt --check` passed; client webpack production build passed; production Core database contained 14 connected accounts under the KasiAi organization. Client ESLint reports an unrelated pre-existing error in `agent-detail-page-client.tsx`. |
| Rollback or disable plan | Roll back the Agents/Core/client artifact to the previous release; no data rollback required. |
| Post-release review date | Not applicable until production rollout. |

## Notes and blockers

The production database inspection confirmed the workspace contains 14 connected accounts. The
previous empty result was caused by model-supplied filter values, not missing connection data.
