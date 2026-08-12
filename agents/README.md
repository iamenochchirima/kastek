# KasiTek Agent Platform

This is the separately deployable Agent Platform service. It owns agent definitions,
durable run orchestration, conversations, memory, and operational records for the direct
KasiTek product. It does not query or mutate `kasitek-core` tables; consequential product
actions will go through authenticated internal contracts exposed by `kasitek-core`.

## Processes

- `pnpm run dev:api` starts the HTTP API.
- `pnpm run dev:gateway` starts the stateless external MCP gateway.
- `pnpm run dev:worker` starts the Temporal worker.
- `pnpm run migrate` applies PostgreSQL migrations.
- `pnpm run bootstrap:kasiai` idempotently creates the protected KasiAi definition and initial
  published version after migrations are applied.
- `pnpm run build` compiles both processes to `dist/`.
- `RUN_AGENTS_DB_INTEGRATION_TESTS=true AGENTS_DATABASE_URL=... npm test` enables the
  opt-in PostgreSQL isolation/deletion tests; the normal test command never mutates a database.

The API and worker are intentionally separate process types so Railway can scale them
independently. The default local-stack mode connects them to a dedicated Temporal Cloud
development namespace. Set `TEMPORAL_MODE=local`, `TEMPORAL_ADDRESS=localhost:7233`, and
`TEMPORAL_NAMESPACE=default` when a completely local Temporal Server is needed. Production
must enable Temporal and provide a dedicated namespace/task queue.

The gateway is a third independently scalable process. It owns no database, Temporal, core, or
product state: `POST /mcp` forwards the authenticated JSON-RPC request to the private Agent API,
and `/health` reports gateway readiness. Route `agents.kasitek.co.za/mcp` to `start:gateway`; keep
the Agent API `/v1` surface on its private/API origin.

Cloud mode requires `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, and `TEMPORAL_API_KEY` in
`agents/.env` (or the environment used to launch the processes). Never commit the API key.

KasiAi uses `KASIAI_MODEL_PROVIDER` and `KASIAI_MODEL` for its pinned initial model target. The
matching KasiTek-funded provider key, such as `OPENROUTER_API_KEY`, is resolved only inside worker
activities and is never stored in an agent definition or workflow input.

For containers, use the checked-in Dockerfile for the API and override the Railway worker start
command with `node dist/temporal/worker.js`. Run `pnpm run migrate` as a release/deployment step
against the Agent Platform database before routing traffic. The worker should use private
networking and the API should expose `/health/live` and `/health/ready`.

Run requests may include an `idempotencyKey`; retries within an organization return the original
run and do not start a second Temporal workflow. Run inspection is available at
`GET /v1/runs/:runId/timeline`, which joins lifecycle events, ordered run steps, and audited tool
invocations. The timeline is organization-scoped and backed by PostgreSQL, so it does not rely
on API process memory or sticky sessions.

Platform chat clients first call
`POST /v1/installations/:installationId/platform/conversation` to resolve the authenticated
user's durable conversation. They send text through
`POST /v1/installations/:installationId/platform/messages` with a client-generated
`idempotencyKey`. The latter stores the inbound message and run atomically, then dispatches the
idempotently named Temporal workflow. Assistant output is committed as an outbound message in
the same transaction that completes the run. Clients can read durable history from
`GET /v1/conversations/:conversationId` and stream run events from
`GET /v1/runs/:runId/events/stream`.

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

When configured, `KASITEK_CORE_DELEGATION_PRIVATE_KEY` signs a short-lived ES256 delegation per
core invocation. Core verifies it with `AGENTS_DELEGATION_PUBLIC_KEY`, issuer, audience, run,
installation, capability, and correlation claims. The static internal token remains only as a
development compatibility path.

External-effect tools reserve an idempotency-derived effect receipt before execution. Provider
success/failure is persisted separately from the tool result; ambiguous outcomes are surfaced by
`GET /v1/operations/effects/reconciliation` and must be reconciled before retrying.

User-owned model credentials are stored through `/v1/credentials` as encrypted vault records.
Set `AGENTS_CREDENTIAL_ENCRYPTION_KEY` to a random 32-byte hex or base64 key in every API and
worker process. API responses contain only opaque credential IDs; revoke the ID to prevent future
model calls.
