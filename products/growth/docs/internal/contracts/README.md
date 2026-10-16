---
id: contracts
title: Contracts
sidebar_position: 6
slug: /contracts
owner: engineering
last_reviewed: 2026-09-29
---

# Contracts

Contracts are the compatibility boundaries between services, clients, providers, and durable
data. A contract change must identify its consumers, compatibility period, validation, and
versioning rule.

## Contract types

- HTTP and REST request/response shapes
- MCP and agent protocol behavior
- Analytics event and metric schemas
- Internal service-to-service authentication and delegation
- Database migrations and durable state transitions
- Webhook validation and provider reconciliation

## Change rules

1. Define the contract in the owning service or registry.
2. Add examples and validation for accepted and rejected input.
3. Decide whether the change is compatible, requires a compatibility window, or needs a new
   contract version.
4. Update generated bindings and all known consumers.
5. Document user-visible or integrator-visible changes.
6. Test the migration and rollback or forward-compatibility path.

API, migration, event, and agent versions are separate identifiers from the coordinated platform
release. See [Platform Versioning](../operations/platform-versioning.md) for the distinction.

Analytics contracts and registry definitions live in the
[Labs Analytics service](https://github.com/Kasitek-Labs/kasitek-labs/tree/main/services/analytics),
under `contracts/` and `metrics/`. Growth producer packages and the Agent Platform keep their
product-owned publishers and generated consumer artifacts. Cross-repository generation and
compatibility checks remain follow-up work. The Agent Platform capability catalog is generated
from its runtime manifest registry; do not edit generated output as the source of truth.
