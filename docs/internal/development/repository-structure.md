---
id: repository-structure
title: Repository Structure
sidebar_position: 3
owner: engineering
last_reviewed: 2026-10-03
---

# Repository Structure

Growth is one product repository in a multi-repository system. Keep Growth-owned product code and
consumer-side integrations here; each separate product repository owns its service implementation,
build, and deployment source. A source move may leave an integration disconnected until its later
integration work is approved.

## Main areas

| Location / repository | Responsibility |
| --- | --- |
| `client/apps/client` | Growth product interface |
| `client/packages/database` | Growth client database package |
| `server/kasitek-core/` | TypeScript Core runtime, Core-owned business capabilities, and Core database |
| [`kasitek-agents`](https://github.com/Kasitek-Labs/kasitek-agents) | Agent API, worker, MCP gateway, Temporal workflows, migrations, contracts, and Agent Platform UI |
| [`kasitek-labs`](https://github.com/Kasitek-Labs/kasitek-labs) | Admin UI, Labs website, Analytics API and worker, schemas, migrations, OpenTelemetry Collector source/configuration, and private packages |
| [`kasitek-agency`](https://github.com/Kasitek-Labs/kasitek-agency) | White-label tenant API, migrations, portal, and tenant-owned workers |
| `scripts/`, `.github/workflows/` | Growth-owned local, release, migration, and verification automation only; service-specific automation belongs with its service |
| `docs/public/` | User-facing Growth documentation site source |
| `docs/internal/` | Current private Growth technical documentation site source |
| `docs/plans/` | Temporary implementation plans and checklists, outside the documentation sites |
| `docs/archive/` | Historical or superseded material retained for reference |

The Labs website, Analytics service, and OpenTelemetry Collector source live in the Labs
repository. Growth retains product-side publishers and integrations where they are still needed.

## Ownership boundaries

- Core, Agents, Labs Analytics, and Agency own separate service and data boundaries. Do not
  connect one service directly to another service's database.
- Cross-service behavior uses an explicit HTTP, event, queue, or shared contract boundary.
- The Labs-owned Admin UI talks to Growth Core and Agency through their existing HTTP APIs.
- Growth's Kāsiai assistant remains a product-side Agent API consumer. Agent runtime and
  management surfaces are owned by `kasitek-agents`; this repository does not own or launch them.
- Do not keep a second service implementation, service-owned build/deployment wiring, or fallback
  copy in Growth after the destination repo takes ownership.
- Frontend packages call supported service APIs or shared client packages; they should not encode
  server persistence rules locally.
- `docs/internal/` describes current technical behavior. A plan belongs in `docs/plans/`, even if
  it contains useful implementation detail.

## Where a change belongs

1. Find the service or package that owns the behavior.
2. Update its tests and contract first.
3. Update consumers and generated bindings if the contract changed.
4. Update current internal or public documentation as part of the same change.
5. Put short-lived sequencing and blockers in the issue or pull request. Record rollout and
   rollback decisions in the release record.
