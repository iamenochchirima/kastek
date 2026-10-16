---
id: repository-structure
title: Repository Structure
sidebar_position: 3
owner: engineering
last_reviewed: 2026-10-16
---

# Repository Structure

Growth lives under `products/growth/` in the KasiTek monorepo. Paths in the table below are
relative to that product directory. Install applications from the root Node 24/pnpm workspace.

| Location | Responsibility |
| --- | --- |
| `web/` | Growth product interface |
| `database/` | Growth Prisma database package |
| `api/` | TypeScript Core API, workers, callbacks and Core-owned data |
| `scripts/` | Growth local development and maintenance tools |
| `docs/public/` | User-facing Growth documentation site |
| `docs/internal/` | Current private technical documentation |
| `docs/internal-site/` | Internal documentation site tooling |
| `docs/plans/`, `docs/archive/` | Historical or parked implementation material |

Other owners are `products/agents/`, `products/agency/`, root `apps/`, `services/analytics/`,
`packages/` and `infra/`. The root `ARCHITECTURE.md` is the full source ownership map.
Root `.github/workflows/` contains CI and root `scripts/` contains workspace tooling.

## Ownership boundaries

Core, Agents, Analytics and Agency keep separate databases and permissions. Cross-service
behavior uses supported HTTP, event, queue or shared-contract interfaces. Shared package exports
are explicit; production code may not import another product's private source. Run
`pnpm verify:boundaries` from the repository root after changes affecting those boundaries.

The Admin UI calls Growth Core and Agency over HTTP. Growth's Kāsiai assistant is an Agents API
consumer; the Agents runtime and management UI remain owned by the Agents product. Each product
retains its independent environment and deployment lifecycle.

## Where a change belongs

Update the owning service or package, its relevant tests and any affected consumers. Keep current
technical and public docs aligned with behavior. Requirements and work status belong in Issues
and the Project; rollout and rollback decisions belong in the release record.
