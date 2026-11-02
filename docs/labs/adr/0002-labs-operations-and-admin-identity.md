# Labs Operations and independent administrator identity

Status: Accepted for the owner-approved development implementation.
Date: 2026-10-23.

## Context

Cross-product reporting and customer operations require an operator to discover failures manually.
Browser polling cannot provide durable monitoring. Existing administrator sessions also depend on
Growth, so a Growth outage can block the administrator who must investigate that outage.

## Decision

Labs owns `services/operations`, a dedicated PostgreSQL database, and separate API and worker
processes. Operations owns monitor leases, safe observations, rule revisions, incident episodes,
maintenance, notification intent, and its own administrative audit. Product services calculate
signals and retain ownership of recovery commands. Analytics continues to own event projections.

The worker uses destination-specific observer authority on fixed signal endpoints. A separate
publisher credential reaches Growth's in-app notification bridge. Human admin signing credentials,
identity-client credentials, and browser sessions remain outside the worker. There is no automatic
business recovery and no cross-product database transaction.

The admin uses a dedicated Keycloak client and Operations-owned opaque sessions. An explicit
issuer and subject mapping grants a stable admin ID and role. Shared login, matching email, and
product membership grant no administrative entitlement. Existing product admin records remain
product-owned. Request-bound human assertions carry the verified platform actor into supported
product adapters without customer impersonation.

The admin BFF calls Operations and product services over HTTP. Operations collection continues
without the browser. The API checks worker progress independently. A total Operations outage still
requires an externally hosted uptime check before production rollout.

## Alternatives

Extending browser diagnostics leaves detection dependent on a signed-in tab. Adding incident state
to Analytics mixes authoritative operational workflow with event projections. Adding a general
workflow engine, broker, or telemetry vendor is unnecessary for this bounded PostgreSQL domain.
Reusing Growth sessions keeps the outage dependency. Cached owner authority would weaken revocation.

## Consequences

Operations requires its own deployment, database, backups, migrations, and retention policy.
Product failures and notification delivery failures cannot erase incidents. Administrators retain
access during Growth failure while the identity provider and Operations remain available.
Identity-provider failure still blocks new login and required refresh. Explicit grants and short,
revocable sessions introduce an operational provisioning step.

This decision extends the admin adoption deferred by
[ADR 0001](0001-shared-account-identity-boundary.md). It does not replace product identity,
membership, billing, execution, or support-content authority.

Current contracts, limits, and release decisions are maintained in the
[incident-centre reference](../../operations/incident-centre.md).
