---
id: README
title: Kasitek Internal Docs
sidebar_position: 1
slug: /
owner: engineering
last_reviewed: 2026-08-27
---

This is the canonical home for private Kasitek documentation.

## Technical Documents

- [Architecture](./architecture/kasitek-technical-blueprint.md)
- [Credit Billing Coverage](./architecture/credit-billing-coverage.md)
- [Growth agent execution](./architecture/growth-agent-execution.md)
- [Audio input support](./architecture/audio-transcription.md)
- [Admin Analytics and Reporting](./architecture/admin-analytics.md)
- [Customer Analytics Display Semantics](./architecture/customer-analytics.md)
- [Access Control](./access-control.md)
- [Local Development](./development/local-development.md)
- [Release Process](./operations/release-process.md)
- [Platform Versioning](./operations/platform-versioning.md)
- [Environments](./operations/environments.md)
- [Railway Deployment Topology](./operations/deployment-topology.md)
- [Observability](./operations/observability.md)
- [Agents technical docs](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/README.md)
- [Agents target architecture](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/architecture/agent-platform-architecture.md)
- [Agents implementation status](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/source-boundary.md)
- [Documentation Maintenance](./operations/documentation-maintenance.md)
- [Shared workspace email connections](./architecture/shared-workspace-email-connections.md)

## Structure

- `architecture/`: current technical design references
- `contracts/`: API, event, and data-boundary contracts
- `development/`: repository and local-development guidance
- `operations/`: release, environment, versioning, observability, and documentation procedures
- `runbooks/`: step-by-step operational playbooks
- `docs/plans/`: Growth planning material and historical records. Current Agents planning lives
  in the Kasitek Agents Stash project; the repository retains its architecture and status summary.
- `docs/archive/legacy/`: historical or superseded material, not current guidance

## Notes

- This site contains current Growth technical and operational guidance only.
- Work items and short checklists belong in the selected issue tracker and linked pull requests.
  Former active plans are preserved under `docs/plans/parked/`. Agent runtime behavior and its
  current architecture summary belongs to `products/agents/docs/`.
