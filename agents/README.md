# KasiTek Agent Platform

This is the separately deployable Agent Platform service. It owns agent definitions,
durable run orchestration, conversations, memory, and operational records for the direct
KasiTek product. It does not query or mutate `kasitek-core` tables; consequential product
actions will go through authenticated internal contracts exposed by `kasitek-core`.

## Processes

- `pnpm run dev:api` starts the HTTP API.
- `pnpm run dev:worker` starts the Temporal worker.
- `pnpm run migrate` applies PostgreSQL migrations.
- `pnpm run build` compiles both processes to `dist/`.
- `RUN_AGENTS_DB_INTEGRATION_TESTS=true AGENTS_DATABASE_URL=... npm test` enables the
  opt-in PostgreSQL isolation/deletion tests; the normal test command never mutates a database.

The API and worker are intentionally separate process types so Railway can scale them
independently. Local development may run the API with `TEMPORAL_ENABLED=false`; production
must enable Temporal and provide a dedicated namespace/task queue.

For containers, use the checked-in Dockerfile for the API and override the Railway worker start
command with `node dist/temporal/worker.js`. Run `pnpm run migrate` as a release/deployment step
against the Agent Platform database before routing traffic. The worker should use private
networking and the API should expose `/health/live` and `/health/ready`.

Run requests may include an `idempotencyKey`; retries within an organization return the original
run and do not start a second Temporal workflow. Run inspection is available at
`GET /v1/runs/:runId/timeline`, which joins lifecycle events, ordered run steps, and audited tool
invocations. The timeline is organization-scoped and backed by PostgreSQL, so it does not rely
on API process memory or sticky sessions.

## kasitek-core read boundary

The worker can expose explicitly granted read-only core tools when both of these settings are
present:

- `KASITEK_CORE_URL` — the private base URL of `kasitek-core`.
- `KASITEK_CORE_INTERNAL_TOKEN` — a dedicated bearer token configured in core as
  `KASITEK_AGENTS_INTERNAL_TOKEN`.

The initial tool is `kasitek.core.customer_get`. It calls
`GET /api/internal/agents/v1/customers/:id` with `x-organization-id`, `x-actor-id`, run, and
correlation headers. Core scopes the query by organization and returns only the read model.
The Agent Platform never receives core database credentials. Rotate this service token as a
deployment secret; do not reuse the n8n callback token or a user session token.
