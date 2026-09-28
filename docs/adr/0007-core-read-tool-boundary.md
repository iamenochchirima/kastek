# ADR 0007: Authenticated Agent-to-Core Read Boundary

- Status: Accepted for the initial KasiTek Agent Platform slice
- Date: 2026-08-11

## Decision

The Agent Platform calls `kasitek-core` over a private HTTP boundary. The first contract is
read-only:

`GET /api/internal/agents/v1/customers/:id`

The request uses a dedicated bearer token configured as
`KASITEK_AGENTS_INTERNAL_TOKEN` in core and `KASITEK_CORE_INTERNAL_TOKEN` in the Agent Platform.
It also carries `x-organization-id`, `x-actor-id`, `x-agent-run-id`, and `x-correlation-id`.
Core scopes the query by the organization header before reading its authoritative tables. The
Agent Platform has no core database credentials and cannot bypass core's data model.

## Why

Browser sessions are the wrong credential for a durable worker: they expire, are tied to a user
cookie, and do not identify a run. A dedicated service credential gives the internal boundary a
clear rotation and deployment lifecycle while run headers preserve audit correlation. Keeping
the first endpoint read-only limits blast radius while the tool and approval contracts mature.

## Constraints

- The token is a deployment secret, not an agent-visible credential.
- Do not reuse the n8n callback token or a user session token.
- Core remains responsible for organization scoping and the response read model.
- New write-capable tools require separate typed endpoints, capability checks, idempotency, and
  approval policy; they must not be added to this route by convention.
- The initial implementation uses a static service token. Production key rotation and a signed
  short-lived service token/issuer are follow-up deployment work.
