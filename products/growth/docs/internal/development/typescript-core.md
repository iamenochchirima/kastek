---
id: typescript-core
title: TypeScript Core migration runtime
owner: platform-ops
last_reviewed: 2026-10-03
---

# TypeScript Core migration runtime

Growth Core's supported runtime is native Node.js 24 under
`api/src`. The replaced Rust implementation and Growth-local
Rust libraries are no longer in this checkout; the recoverable Rust source
baseline is commit `abd419c6`. This local source retirement does not change
hosted services; hosted cutover is separate release work.

From `api`, run `pnpm build` and `pnpm start`.
The entrypoint loads that service's `.env` regardless of the launch directory.
Existing process environment variables take precedence. It connects to the
configured PostgreSQL database before starting HTTP or workers. It does not
automatically apply Prisma migrations.

The local API runs on port 4000. To start it without effect-producing background
workers:

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
ID or deployment for this source retirement. Package version `0.1.0` is a
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

These checks do not prove every live provider integration, full frontend parity,
or authenticated private-package delivery. Those remain migration gates. Hosted
production OTLP export depends on deployed Collector configuration and is release
work outside this implementation task.

Rollout is local only. Native launchers use TypeScript; the retired Rust source
remains recoverable from baseline commit `abd419c6`. Stop TypeScript workers
before restoring that baseline. Private registry installation remains pending.
Hosted deployment and configuration are outside this implementation task.
Collector changes and post-release review dates are not applicable before
deployment.

## Focused database fixtures

The existing `scripts/test-early-access-db.sh`, `test-referrals-db.sh` and
`test-seeded-core-db.sh` entrypoints now run the TypeScript fixtures. Supply their
existing `EARLY_ACCESS_TEST_DATABASE_URL`, `REFERRALS_TEST_DATABASE_URL` or
`SEEDED_CORE_TEST_DATABASE_URL` variable with a disposable local PostgreSQL URL.
They validate the actual URL hostname, create synthetic isolated schemas and
clean them up. They do not load the historical seed into public tables. The
seed SQL remains available as source evidence.

## Native build and Railway preparation

Run `bash products/growth/scripts/verify_native_core.sh` from the repository root. It installs
from the frozen root workspace lockfile, builds shared packages and Core, and checks
transport/telemetry without database or provider effects. It no longer accepts an external Labs
source directory. The observability workflow uses the same workspace-owned sources.

For Railway, use the monorepo root as the build context and the Growth API package at
`products/growth/api/`. Build shared packages then `@kasitek/growth-core`; start in the API package
with `pnpm start`. HTTP binds to `0.0.0.0` and reads `PORT`. Configure `/health` as the health path.
Keep `openapi/` beside `dist/` and preserve durable media storage and its environment path.
See the root hosting cutover record before changing any hosted settings.

Set `KASITEK_DISABLE_BACKGROUND_WORKERS=1` for an API deployed with separate
workers. Each worker uses the same artifact/start command with its documented
`KASITEK_PROCESS`. These commands must not run both old and new effect producers.

Prisma migration ownership stays in `products/growth/database/`. From the repository root,
the release command is `pnpm --dir products/growth/database exec prisma migrate deploy`.
The root lockfile/dependencies and service database credentials must be available to that job.
API startup does not migrate. No schema or migration content changes are part of this restructure.

Railway's hosted root/build/start/release settings and secrets have not been
changed. Provider source paths and hosted cutover belong to release work. Stop TypeScript effects
before restoring the Rust source baseline or rolling back a future deployment.
