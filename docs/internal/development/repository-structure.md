---
id: repository-structure
title: Repository Structure
sidebar_position: 3
owner: engineering
last_reviewed: 2026-09-29
---

# Repository Structure

Growth is one product repository in a multi-repository system. Keep Growth-owned product code and
consumer-side integrations here; each separate product repository owns its service implementation,
build, and deployment source. A source move may leave an integration disconnected until its later
integration work is approved.

## Main areas

| Location / repository | Responsibility |
| --- | --- |
| `client/apps/client`, `client/apps/admin` | Growth product interfaces |
| `client/packages/database` | Growth client database package |
| `client/apps/labs` | Labs-branded site source; its source move is tracked separately |
| `server/kasitek-core/` | Core runtime, Core-owned business capabilities, and Core database |
| [`kasitek-agents`](https://github.com/Kasitek-Labs/kasitek-agents) | Agent API, worker, MCP gateway, Temporal workflows, migrations, contracts, and Agent Platform UI |
| [`kasitek-labs`](https://github.com/Kasitek-Labs/kasitek-labs) | Analytics API, worker, schemas, migrations, and OpenTelemetry Collector source/configuration |
| [`kasitek-agency`](https://github.com/Kasitek-Labs/kasitek-agency) | White-label tenant API, migrations, portal, and tenant-owned workers |
| `server/crates/` | Shared Rust libraries used by Growth services |
| `scripts/`, `.github/workflows/` | Growth-owned local, release, migration, and verification automation only; service-specific automation belongs with its service |
| `docs/public/` | User-facing Growth documentation site source |
| `docs/internal/` | Current private Growth technical documentation site source |
| `docs/plans/` | Temporary implementation plans and checklists, outside the documentation sites |
| `docs/archive/` | Historical or superseded material retained for reference |

## Ownership boundaries

- Core, Agents, Labs Analytics, and Agency own separate service and data boundaries. Do not
  connect one service directly to another service's database.
- Cross-service behavior uses an explicit HTTP, event, queue, or shared contract boundary.
- Growth Admin's tenant provisioning bridge remains a product-side integration and may be
  disconnected until its separately tracked integration work is completed.
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
