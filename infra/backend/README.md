# Backend images

Build from the monorepo root with Node 24 and the pinned pnpm lockfile. This image
packages one backend and its built workspace dependencies. It includes runtime SQL,
Analytics contracts and metric definitions; it does not apply migrations at build or startup.
Agency retains its existing startup migration behavior.

```sh
docker build -f infra/backend/Dockerfile \
  --build-arg SERVICE_PACKAGE=@kasitek/growth-core \
  --build-arg SERVICE_PATH=products/growth/api \
  -t kasitek-growth-api:RELEASE_ID .
```

| Package / path | API command | Worker command | Health path | Migration |
| --- | --- | --- | --- | --- |
| `@kasitek/growth-core` / `products/growth/api` | `node dist/bootstrap.js` | Same command, `KASITEK_PROCESS=analytics-publisher` | `/health` | Apply reviewed Growth database migrations as a separate release job; the image includes API SQL but no Prisma CLI. |
| `@kasitek/agency-tenants` / `products/agency/api` | `node dist/bootstrap.js` | Same command, `KASITEK_PROCESS=analytics-publisher` | `/health` | Existing startup runner applies the packaged `migrations/` with its database lock. |
| `@kasitek/analytics` / `services/analytics` | `node dist/api-main.js` | `node dist/worker-main.js` | `/health/ready` | Run `node dist/migrate-main.js` once before API and worker. |
| `@kasitek/operations` / `services/operations` | `node dist/api-main.js` | `node dist/worker-main.js` | `/health/ready` | Run `node dist/migrate-main.js` once before API and worker. |

Analytics and Operations must override the default image command. Workers without an HTTP
listener use process and queue monitoring rather than the API health path. Set service-specific
environment variables in the hosting provider, never Docker build arguments. The runtime runs
as `node`; persistent mounts must be writable by that user.

Growth keeps its default embedded workers on the API, which owns the persistent media volume.
The separate Growth publisher runs analytics publication and backfill only; leave
`KASITEK_DISABLE_BACKGROUND_WORKERS` unset on the API. Publication reads files from
`KASITEK_MEDIA_STORAGE_PATH`, so independent API/worker volumes would not provide shared media.
Preserve the existing encryption keys when restoring Growth data. Each product uses its own database.

Agents uses its existing `products/agents/api/Dockerfile` and Railway API/worker configurations.
Run `node dist/composition/setup.js` as a release job against the fresh dedicated Agents database,
then register its deployed worker with the pinned Restate runtime. The retired gateway and
Temporal commands are not supported.

## Release decisions

These files define packaging, not an observed hosted deployment. Record the tested commit,
image digest, configuration revision, migrations and runtime `KASITEK_RELEASE_ID` before promotion.
Verify each API readiness endpoint and worker processing in an isolated environment. Rollback
uses the preceding image and configuration; retain applied additive database migrations and
durable work receipts. Database backup/restore and live provider acceptance belong to the rollout.

New analytics events, application logs and API contracts: not applicable; packaging adds no
product behavior. Existing telemetry and lifecycle events remain configured per service.
Version identity, validation, rollout and post-release review evidence must be recorded by the
deployment owner for the actual artifacts. No credentials are embedded in these images.
