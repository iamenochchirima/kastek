# KasiAi system context ownership hotfix

**Status:** Active

**Owner:** platform-ops

**Last updated:** 2026-08-30

## Objective

Restore `POST /api/agents/kasiai/ensure` in Production by allowing a protected system agent's
installation context to belong to the customer organization. Success is a completed customer
installation with its seeded knowledge source and no `Agent context organization does not match
its definition` failure.

## Scope

### Included

- Correct the Agents database context-ownership invariant for protected system definitions.
- Apply the additive migration to the Production Agents database.
- Verify the existing protected-system-agent integration flow and the live request path.
- Record the explicit KasiAi release step in the Railway deployment reference.

### Excluded

- Changes to customer-owned agent isolation.
- Changes to the Core proxy or client error presentation.
- Changes to agent versions, prompts, tools, or rollout policy.

## Context and constraints

- Migration `060` already permits customer installations of protected system definitions.
- Migration `057` still requires every context row and definition to share an organization, so
  seeding a customer installation's knowledge source fails inside the installation transaction.
- Context rows must still reference an installation owned by the same customer organization and
  the same definition.
- Production skips development startup synchronization; KasiAi publication is an explicit release
  operation.

## Implementation plan

1. [x] Trace the Core 502 through the Agents API and database error.
2. [x] Add an additive migration that mirrors the protected-system exception used by installation
   ownership while preserving the installation scope check.
3. [x] Update the Railway deployment reference with the system-agent release step.
4. [x] Run static and targeted verification.
5. [x] Apply migration `076` to Production and verify the failing database write sequence.
6. [ ] Confirm one authenticated client ensure request after the migration.

## Verification

- [x] Migration SQL reviewed and parsed by PostgreSQL.
- [x] Agents TypeScript build passes.
- [x] Equivalent Production transactional database check inserts a customer installation,
  knowledge source, and knowledge chunk, then rolls the transaction back without retained data.
- [x] Production migration registry contains `076`, applied at `2026-08-30T15:52:20.624Z`.
- [ ] A fresh ensure request no longer emits the context-ownership exception.

## Release record

| Field | Decision |
| --- | --- |
| Change | Permit customer-owned context for installations of protected platform system agents. |
| Owner | platform-ops |
| Risk | standard; additive function replacement on write-time ownership triggers |
| Affected services and user surfaces | Agents API database writes; Core `POST /api/agents/kasiai/ensure`; client KasiAi entry flow |
| Platform release version or release ID | Agents API Railway deployment `f9800a8b-6d0b-4a6d-b609-1b9b37ecd978`, commit `f8ba1ab86fb2f16d6949a09cc4837d33187648b8`; migration `076` was applied as a database hotfix pending repository deployment |
| API/schema/migration changes | No API contract change; additive Agents migration `076_system_agent_context_ownership.sql` replaces one trigger function |
| Feature flag or rollout method | One-shot Production migration followed by a single-workspace smoke request; no feature flag |
| Analytics events and success metrics | Not applicable; success is an installation created without HTTP 500/502 |
| Logs, metrics, dashboards, and alerts | Existing Core HTTP error span and Agents structured database error logs; no new signal schema |
| User, API, internal, and operational documentation | Railway deployment topology updated; no public API documentation change |
| Validation evidence | `pnpm --dir agents run build` passed; the integration fixture was discovered but skipped without a configured test database; Production accepted the exact installation/source/chunk write sequence inside a rolled-back transaction; live authenticated smoke request pending |
| Rollback or disable plan | Restore the prior trigger function from migration `057`; do not delete customer installation data created by successful requests |
| Post-release review date | 2026-08-31 |

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Cross-organization definition reference | Allowed only when `owner_type = 'system'` and `protected = TRUE` | platform-ops | Decided |
| Customer isolation | Continue requiring the context installation, organization, and definition to match | platform-ops | Decided |

## Notes and blockers

No external blocker. The unrelated local `.codex/config.toml` modification is not part of this
change and must remain untouched.
