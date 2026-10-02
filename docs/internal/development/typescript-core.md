---
id: typescript-core
title: TypeScript Core migration runtime
owner: platform-ops
last_reviewed: 2026-10-02
---

# TypeScript Core migration runtime

Core's native Node.js 24 replacement is in `server/kasitek-core/src-ts`.
The Rust implementation remains during migration. This document describes
the replacement's available startup commands, not a completed production cutover.

From `server/kasitek-core`, run `pnpm build` and `pnpm start`.
The entrypoint loads that service's `.env` regardless of the launch directory.
Existing process environment variables take precedence. It connects to the
configured PostgreSQL database before starting HTTP or workers. It does not
automatically apply Prisma migrations.

The current local API runs on port 4000 with Rust stopped. To start it without
effect-producing background workers:

```sh
KASITEK_DISABLE_BACKGROUND_WORKERS=1 pnpm start
```

Do not start both implementations' workers against the same data. That can send
real messages, publish scheduled content or reconcile payments twice. Tests use
isolated PostgreSQL schemas and local provider fixtures.

## Process modes

Set `KASITEK_PROCESS` to a source process name:

| Process | Workers |
| --- | --- |
| `social-publishing-worker` | Social publishing |
| `social-insights-worker` | Social insights |
| `whatsapp-marketing-worker` | WhatsApp campaigns |
| `whatsapp-inbox-worker` | WhatsApp inbox delivery |
| `email-inbox-worker` | Email inbox synchronization |
| `billing-reconciliation-worker` | Billing reconciliation |
| `public-webhooks-worker` | Developer webhook delivery |
| `analytics-publisher` | Analytics publisher and backfill, concurrently |
| `analytics-backfill-worker` | Analytics backfill |
| `all-workers` | All nine workers, concurrently |

Dedicated worker processes do not open an HTTP listener. Missing or unrecognized
process names select the API, matching the Rust entrypoint. The API starts the
seven non-Analytics workers unless `KASITEK_DISABLE_BACKGROUND_WORKERS` is
`1`, `true`, `yes` or `on`, ignoring case and surrounding whitespace.

SIGINT and SIGTERM abort worker polling. Shutdown waits for in-flight worker
operations before closing the database pool. An uncaught worker failure aborts
its sibling workers and exits unsuccessfully; handled provider failures retain
each worker's existing retry behavior. Workers log bounded structured lifecycle
events without dumping request bodies or credentials.

## Migration release record

The migration owner is the platform team. Risk is high because Core includes
provider callbacks, billing and delivery workers. There is no production release
ID or deployment for this additive implementation. Package version `0.1.0` is a
development artifact version.

Database schema changes are not applicable to this startup wiring. Existing
outbox facts and Analytics schemas remain in use. Provider contracts retain
their source paths and signing rules. The WhatsApp template-start path publishes
its locally stored message ID; the Rust source used the provider ID and silently
missed the realtime event.

Validation includes a Node.js build, all 537 source route registrations,
isolated database/provider fixtures and native worker process checks. All ten
standalone modes poll empty isolated queues and stop on SIGTERM. The combined
publisher includes backfill; the API starts the seven source workers by default
and honors the disable flag. HTTP/provider traces and operation metrics export
to an in-memory fixture. A refused Collector connection leaves health available
and telemetry shutdown bounded.

These checks do not prove every live provider integration, hosted production OTLP
export, full frontend parity or Rust retirement. Those remain migration gates.

Rollout is local only. Native launchers now use TypeScript; Rust source and its
recoverable Git baseline remain until the full deletion gate passes. Stop native
workers before restoring the Rust baseline. Production deployment, private
registry installation and hosted configuration remain pending. Collector changes
and post-release review dates are not applicable before deployment.

## Focused database fixtures

The existing `scripts/test-early-access-db.sh`, `test-referrals-db.sh` and
`test-seeded-core-db.sh` entrypoints now run the TypeScript fixtures. Supply their
existing `EARLY_ACCESS_TEST_DATABASE_URL`, `REFERRALS_TEST_DATABASE_URL` or
`SEEDED_CORE_TEST_DATABASE_URL` variable with a disposable local PostgreSQL URL.
They validate the actual URL hostname, create synthetic isolated schemas and
clean them up. They do not load the historical seed into public tables. The
seed SQL remains available as source evidence.
