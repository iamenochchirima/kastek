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
- [Audio Input and Transcription](./architecture/audio-transcription.md)
- [Admin Analytics and Reporting](./architecture/admin-analytics.md)
- [Customer Analytics Display Semantics](./architecture/customer-analytics.md)
- [Access Control](./access-control.md)
- [Local Development](./development/local-development.md)
- [Release Process](./operations/release-process.md)
- [Platform Versioning](./operations/platform-versioning.md)
- [Environments](./operations/environments.md)
- [Railway Deployment Topology](./operations/deployment-topology.md)
- [Observability](./operations/observability.md)
- [Agent Memory Observability](./operations/agent-memory-observability.md)
- [Documentation Maintenance](./operations/documentation-maintenance.md)
- [Agent Platform Implementation Plan](/plans/agents/)
- [Agent runtime host boundary](./architecture/agent-host-boundary.md)
- [Shared workspace email connections](./architecture/shared-workspace-email-connections.md)

## Structure

- `architecture/`: current technical design references
- `contracts/`: API, event, and data-boundary contracts
- `development/`: repository and local-development guidance
- `operations/`: release, environment, versioning, observability, and documentation procedures
- `runbooks/`: step-by-step operational playbooks
- `docs/plans/`: implementation plans; the canonical Agent Platform program map and selected active
  implementation chunks are mounted at `/plans/agents/`
- `docs/archive/legacy/`: historical or superseded material, not current guidance

## Notes

- This site contains current technical and operational guidance only.
- Temporary plans and checklists are maintained in `docs/plans/active/` and moved to
  `docs/plans/completed/` when finished. The Agent Platform program map remains the maintained
  implementation index, while selected active chunks may be mounted under its plan UI for review.
  Current runtime behavior remains documented under `docs/internal/architecture/`.
