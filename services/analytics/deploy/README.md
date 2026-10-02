# Analytics on Railway

Deploy Analytics as three Railway processes from the Labs repository: the API, the projection and
maintenance worker, and a one-time migration command. The TypeScript package builds from the
repository root so its private workspace packages are available.

## Build

Set the service build command to:

```bash
corepack pnpm install --frozen-lockfile \
  && corepack pnpm --filter @kasitek-labs/contracts build \
  && corepack pnpm --filter @kasitek-labs/server-support build \
  && corepack pnpm --filter @kasitek/analytics build
```

The API start command is:

```bash
corepack pnpm --filter @kasitek/analytics start
```

Create a second long-running service with this command:

```bash
corepack pnpm --filter @kasitek/analytics start:worker
```

Run migrations as a one-time release job before starting API or worker deployments:

```bash
corepack pnpm --filter @kasitek/analytics migrate
```

API and worker startup never changes the database schema. The migration process takes the same
application advisory lock as the existing SQLx runner and validates the existing migration ledger.

## Railway variables

Configure `ANALYTICS_DATABASE_URL` with a dedicated private PostgreSQL database. Railway's `PORT`
is used when `ANALYTICS_API_PORT` is unset; the default is `4300`. Keep Core, Agency, and Agents
database credentials separate. Redis is optional and only caches report and rollout decisions;
PostgreSQL remains authoritative.

Set the required service credentials and signing keys for the integrations you enable:

- `ANALYTICS_INGESTION_CREDENTIALS_JSON` for registered source publishers.
- `ANALYTICS_REPORTING_PUBLIC_KEY` or `ANALYTICS_REPORTING_PUBLIC_KEYS_JSON` for signed report grants.
- `ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON` for Core/Tenant scope resolution.
- `ANALYTICS_ROLLOUT_ADMIN_PRODUCERS` for authorized rollout-control producers.
- `ANALYTICS_METRICS_TOKEN` for internal metrics access.
- `ANALYTICS_REDIS_URL` only when using the optional cache.

Use Railway's private networking for PostgreSQL and Redis. Do not expose database ports publicly.
Configure the API health check at `/health/ready`; it returns `503` until PostgreSQL is reachable
and the base Analytics migration has been applied. The worker is a background process and does not
open an HTTP port.

## Backups and recovery

`scripts/backup.sh` creates a custom-format PostgreSQL dump with a checksum and metadata. Keep all
three files together in a protected backup location. Run `scripts/restore.sh` only against an
isolated recovery database or while the target service is stopped; the script requires explicit
confirmation variables.

Runbooks preserved from Growth are under [`runbooks/analytics/`](runbooks/analytics/README.md).
They remain drafts until operations has reviewed them.
