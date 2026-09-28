# ADR 0001: Agent Platform runtime

- Status: accepted
- Date: 2026-08-11

## Decision

The Agent Platform uses TypeScript on Node.js. The API and worker are separate process
types in the same monorepo and share domain contracts, repositories, and adapters. The
runtime has no authoritative filesystem state.

`kasitek-core` remains a Rust service and the authority for product identity, entitlement,
authorization, connected provider credentials, and consequential product actions.

## Consequences

The platform can scale API and workers independently and remains portable across Railway,
AWS, Google Cloud, and Kubernetes. Internal calls to core must use typed authenticated
contracts; the platform must not query core tables directly.
