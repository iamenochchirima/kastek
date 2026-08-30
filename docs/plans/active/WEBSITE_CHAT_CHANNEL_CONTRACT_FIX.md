# Website Chat channel contract fix

**Status:** Active

**Owner:** platform-ops

**Last updated:** 2026-08-30

## Objective

Restore Website Chat deployment creation by aligning Core and Agents API channel validation with
the existing Website Chat routing contract.

## Scope

### Included

- Admit the existing `website` channel type through Core and Agents API validation.
- Preserve the dedicated Website Chat deployment API and its origin validation.
- Add regression coverage for the Core contract and Agents connection route.

### Excluded

- Widget appearance or embed changes.
- Database schema changes.
- Website Chat support for protected or personal agents.

## Implementation plan

1. [x] Trace the deployment request across Client, Core, and Agents API.
2. [x] Align both channel allowlists with the existing Website Chat route.
3. [x] Add targeted regression coverage.
4. [x] Run Core and Agents verification.
5. [ ] Deploy Agents API before Core and run a Production Website Chat creation smoke check.

## Release record

| Field | Decision |
| --- | --- |
| Change | Accept the existing `website` routing channel when Core creates a Website Chat deployment. |
| Owner | platform-ops |
| Risk | low; additive validation change for an existing internal channel contract |
| Affected services and user surfaces | Core, Agents API, Agent Integrations → Website Chat |
| Platform release version or release ID | Patch release; commit and deployment IDs pending |
| API/schema/migration changes | Existing internal channel API now accepts `channelType=website`; no schema migration |
| Feature flag or rollout method | Deploy Agents API before Core, then create one Website Chat deployment as a smoke check |
| Analytics events and success metrics | Not applicable; success is HTTP 201 and a persisted Website Chat deployment |
| Logs, metrics, dashboards, and alerts | Existing request/error telemetry; no new signal schema |
| User, API, internal, and operational documentation | This release record documents the corrected existing contract; public embed instructions are unchanged |
| Validation evidence | Targeted Agents HTTP regression passed; Agents TypeScript build passed; targeted Core unit test passed; `cargo check -p kasitek-core` passed |
| Rollback or disable plan | Revert the additive allowlist entries and redeploy; existing deployments remain unchanged |
| Post-release review date | 2026-08-31 |
