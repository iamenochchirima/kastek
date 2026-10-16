# Agency source boundaries and migration notes

This note records the source-only relocation covered by [Agency #2](https://github.com/Kasitek-Labs/kasitek-agency/issues/2)
and [Agency #3](https://github.com/Kasitek-Labs/kasitek-agency/issues/3), with the later Growth
cleanup tracked in [Growth #8](https://github.com/Kasitek-Labs/kasitek-growth/issues/8). The source
was read from Growth's tracked `growth/main` at `0ae32bf350a074cf3c643dcf221e47f53ddb4f63`.
Growth's active worktree was left untouched.

## Current TypeScript runtime

Current paths below are relative to `products/agency/`. Historical Rust source paths retain
their original context. The root workspace owns shared packages and dependency installation.

The Tenant API and its API, publisher and backfill processes run from
`api/src/` on Node 24. The Rust service source and Cargo
workspace have been retired; the complete Rust baseline remains recoverable in
Agency commit `2c7902170a8f75257c0e47b86ffaf38068dd2227`. Local migration and
consumer checks passed, but private package-registry authentication and hosted
deployment have not been verified or performed. See the root
[TypeScript migration plan](../../../docs/programs/typescript-migration/IMPLEMENTATION.md)
for current parity status.

## Owned source

- `api/` contains the tenant API, SQL schema changes, and migrations.
- `web/` contains the portal source and its authored `public/` assets.
- `api-client/` is the one internal frontend package imported by the
  portal. It makes same-origin requests under `/api/tenant`.

The Growth portal's tracked `web/dist/` files were not copied. Agency #3
authorizes the portal source and assets but does not authorize generated build output. The authored
favicon and Open Graph image under `public/` were copied.

## Original Rust dependency boundary (historical)

The source-relocation implementation originally referenced these Labs crates.
Agency's TypeScript service no longer has Cargo dependencies; it consumes the
private TypeScript packages `@kasitek-labs/contracts` and
`@kasitek-labs/server-support` instead. The table below records the former
Rust dependency edges for recovery and comparison.

The tenant service directly references these shared crates at `server/crates/` in Growth:

| Crate | Original Growth source path | Tenant API manifest edge |
| --- | --- | --- |
| `analytics-producer` | `server/crates/analytics-producer` | private Git dependency from Labs |
| `analytics-reporting` | `server/crates/analytics-reporting` | private Git dependency from Labs |
| `config` | `server/crates/config` | private Git dependency for generic helpers only |
| `crypto-utils` | `server/crates/crypto-utils` | private Git dependency from Labs |
| `observability` | `server/crates/observability` | private Git dependency from Labs |

In the former Rust implementation, `TenantServerConfig` and
`CookieSameSitePolicy` lived in `api/src/config.rs`; tenant
context DTOs and health types lived in `src/types.rs`. Their current
TypeScript counterparts are in `api/src/config.ts` and
`src/types.ts`.

The Rust dependencies above were private and required Cargo access to Labs;
they are not part of the current TypeScript build. TypeScript shared packages now resolve from the root workspace through explicit exports.
Credentials stay outside the repository.

The TypeScript Analytics publisher calls the Analytics ingestion API using
`ANALYTICS_INGESTION_URL` and tenant publisher credentials. It uses the Labs
TypeScript server-support package for shared event contracts, outbox operations
and the authenticated HTTP client; no Analytics service source was copied into
Agency.

## Portal and Growth integration points

- The portal's Next.js route at `/api/tenant/[...path]` proxies to `TENANT_BACKEND_URL`, falling
  back to `NEXT_PUBLIC_TENANT_API_BASE_URL` and then `http://localhost:8090`. It forwards the
  browser cookie and host/proxy headers to the tenant API.
- Portal authentication uses the tenant API session endpoints and cookies. Tenant context is
  selected from the request host; the portal also fetches `/api/public/tenant-context` from its
  current origin. The destination's hosting and route dispatch are not configured by this move.
- Growth retains its admin provisioning consumer. The Growth admin page posts to `/api/agencies`,
  whose route proxies to the tenant API's `/api/admin/workspaces`. Growth's
  `TENANTS_BACKEND_URL` defaults to `http://localhost:8090`, and its proxy forwards
  `TENANT_ADMIN_SECRET` as `x-admin-secret`. Workspace creation, invites, and returned
  portal/domain URLs still cross the repository boundary.
- Growth's admin UI reads `NEXT_PUBLIC_TENANT_PORTAL_URL` for the portal fallback. Tenant domains
  depend on `TENANT_PLATFORM_BASE_DOMAIN` and `TENANT_PORTAL_HOST_TARGET`; cookie behavior depends
  on `TENANT_SESSION_COOKIE_DOMAIN`, `TENANT_SESSION_COOKIE_SECURE`,
  `TENANT_SESSION_COOKIE_SAME_SITE`, and the tenant/client session-cookie names and TTL settings.
  Domain routing, sign-in integration, and production cutover remain deferred to Agency #4 or
  later integration work.

These are follow-up integration paths. This change does not alter their contracts, restore
cross-product journeys, apply migrations, or modify Growth.

## Original relocation release impact (historical record)

- Change and owner: source relocation for the Agency Tenant Platform; Agency owns the moved source.
- Risk: standard; no runtime or production state is changed.
- Affected surfaces: tenant API source, migration source, and tenant portal source.
- Release version or deployment identity: not applicable; no release or deployment is part of this
  change.
- API/schema/migration behavior: no contract or SQL behavior changed; migrations were relocated
  but not applied.
- Rollout and feature flag: not applicable; no rollout occurred.
- Analytics events and success metrics: not applicable; publisher code and event contracts were
  relocated unchanged.
- Logs, metrics, dashboards, and alerts: not applicable; runtime instrumentation was not changed.
- Documentation: this file and the repository README describe the new source layout and commands.
- Validation: touched Rust files pass rustfmt and ownership searches confirm no shared `types`
  dependency remains. Cargo metadata resolves the private Labs crate dependencies and locks their
  source revision in `server/Cargo.lock`; no API build or API tests ran. The portal passed a frozen dependency install,
  typecheck, and production build under Node 22.22.2. `git diff --check` passed. Portal lint remains
  deferred because the destination has no ESLint config and the attempted temporary config exposed
  existing violations; see the source-move PR for the recorded commands and results.
- Rollback: revert the destination source commit; Growth and production remain unchanged.
- Post-release review: not applicable; this is not a release.
