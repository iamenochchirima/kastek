---
id: repository-structure
title: Repository Structure
sidebar_position: 3
owner: engineering
last_reviewed: 2026-08-25
---

# Repository Structure

The repository is a monorepo. Keep changes in the boundary that owns the behavior and update the
corresponding contract or documentation when the boundary changes.

## Main areas

| Path | Responsibility |
| --- | --- |
| `client/` | Frontend workspace, direct client, admin, labs, tenant portal, and shared packages |
| `agents/` | Agent API, worker, MCP gateway, Temporal workflows, migrations, and agent contracts |
| `server/kasitek-core/` | Core product runtime, shared business capabilities, and core database |
| `server/kasitek-tenants/` | White-label tenant runtime and tenant database |
| `server/kasitek-analytics/` | Analytics ingestion, registry, reporting, projections, and analytics database |
| `server/crates/` | Shared Rust crates used by server runtimes |
| `scripts/` | Local stack, environment, release, migration, and verification automation |
| `docs/public/` | User-facing documentation site source |
| `docs/internal/` | Current private technical documentation site source |
| `docs/plans/` | Temporary implementation plans and checklists, outside the documentation sites |
| `docs/archive/` | Historical or superseded material retained for reference |

## Ownership boundaries

- Core, Tenant Platform, Agents, and Analytics use separate data boundaries. Do not connect one
  service directly to another service's database.
- Cross-service behavior uses an explicit HTTP, event, queue, or shared contract boundary.
- Frontend packages call supported service APIs or shared client packages; they should not encode
  server persistence rules locally.
- `docs/internal/` describes current technical behavior. A plan belongs in `docs/plans/`, even if
  it contains useful implementation detail.

## Where a change belongs

1. Find the service or package that owns the behavior.
2. Update its tests and contract first.
3. Update consumers and generated bindings if the contract changed.
4. Update current internal or public documentation as part of the same change.
5. Put short-lived sequencing, rollout, or blocker notes in `docs/plans/active/`; move them to
   `docs/plans/completed/` when finished.
