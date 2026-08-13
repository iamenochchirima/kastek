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
- `pnpm run test:e2e:local` exercises a real local installation through REST, Temporal, and MCP.
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
and `/health` reports gateway liveness. `/health/ready` checks the Agent API readiness endpoint and
`/metrics` exposes redacted in-process request counters and latency. Route `agents.kasitek.co.za/mcp` to `start:gateway`; keep
the Agent API `/v1` surface on its private/API origin.

The gateway applies bounded in-process fixed-window limits before forwarding requests. Set
`MCP_GATEWAY_ENABLED=false` for an emergency transport disable, and tune the authenticated and
pre-authentication windows with the `MCP_GATEWAY_*` variables. These controls are transport-local;
installation grants, capability policy, approvals, usage, and audit remain owned by the Agent API.
The gateway accepts MCP protocol revision `2025-06-18` and returns an explicit incompatibility
error for other revisions. It currently uses JSON responses for POST Streamable HTTP and does not
claim GET streaming or resumable session support.

The machine-readable integration guide for external MCP clients is in
[`docs/mcp-integration.md`](docs/mcp-integration.md).

Approval decisions have a separate bounded per-organization/run/actor fixed-window guard. Tune it
with `APPROVAL_DECISION_RATE_LIMIT_PER_WINDOW`, `APPROVAL_DECISION_RATE_LIMIT_WINDOW_MS`, and
`APPROVAL_DECISION_RATE_LIMIT_MAX_KEYS`; PostgreSQL remains the authoritative compare-and-set and
duplicate-decision boundary. When Temporal is unavailable in a development environment, only read
manifests that explicitly declare `execution: immediate` may execute directly; the run and tool
evidence are still persisted. Durable writes and all approval-required capabilities continue to
require Temporal.

## Local end-to-end smoke test

After migrations, start the API, worker, and gateway in separate terminals:

```bash
pnpm run dev:api
pnpm run dev:worker
pnpm run dev:gateway
```

Set a dedicated development ES256 `INSTALLATION_TOKEN_PRIVATE_KEY` in `agents/.env` before starting
the API, and use a non-production `AGENT_GATEWAY_SHARED_SECRET` when the gateway and API communicate
over a non-private local network. Then run `pnpm run test:e2e:local`. The smoke test creates an
isolated organization, agent, installation, credential, and two durable runs. It verifies REST
credential exchange, filtered discovery, idempotent execution, MCP authentication, protocol
negotiation, and MCP tool acceptance; it archives its agent fixture afterwards. Set
`AGENTS_E2E_KEEP_FIXTURES=true` only when investigating a failed run.

Cloud mode requires `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, and `TEMPORAL_API_KEY` in
`agents/.env` (or the environment used to launch the processes). Never commit the API key.

KasiAi uses `KASIAI_MODEL_PROVIDER` and `KASIAI_MODEL` for its pinned initial model target. The
matching KasiTek-funded provider key, such as `OPENROUTER_API_KEY`, is resolved only inside worker
activities and is never stored in an agent definition or workflow input.

For containers, use the checked-in Dockerfile for the API and override the Railway worker start
command with `node dist/temporal/worker.js`. Run `pnpm run migrate` as a release/deployment step
against the Agent Platform database before routing traffic. The worker should use private
networking and the API should expose `/health/live` and `/health/ready`.

The gateway service has a checked-in Railway descriptor at `agents/railway.gateway.json`. Configure
that service with the `agents/` directory as its Railway root, set `AGENT_PLATFORM_URL` to the private
Agent API origin, provide `AGENT_GATEWAY_SHARED_SECRET`, and attach the `agents.kasitek.co.za` custom
domain. Scale gateway replicas independently; `/health/ready` is the service health check and no
gateway replica requires a database or sticky session.

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

The worker can expose explicitly granted read-only core tools when the core URL and one of these
authentication modes are present:

- `KASITEK_CORE_URL` — the private base URL of `kasitek-core`.
- `KASITEK_CORE_INTERNAL_TOKEN` — a dedicated bearer token configured in core as
  `KASITEK_AGENTS_INTERNAL_TOKEN`.
- `KASITEK_CORE_DELEGATION_PRIVATE_KEY` — an ES256 private key for per-invocation delegation.
- `KASITEK_CORE_DELEGATION_KEY_ID` — optional active signing-key identifier during a core
  delegation-key rotation; it must match core's trusted key map.

The core capability boundary currently includes customer/workspace reads and the first content
vertical. Content tools call `GET /api/internal/agents/v1/content/posts` and
`GET /api/internal/agents/v1/content/posts/:id` for scoped reads, `POST
/api/internal/agents/v1/content/posts` for idempotent drafts, and approval-bound publish/schedule
routes for later rollout. Every request carries organization, actor, run, correlation, and (for
writes) idempotency context. Core scopes all queries and writes by organization and returns only
the typed read/write result; the Agent Platform never receives core database credentials.
The Agent Platform never receives core database credentials. Rotate this service token as a
deployment secret; do not reuse the n8n callback token or a user session token.

When configured, `KASITEK_CORE_DELEGATION_PRIVATE_KEY` signs a short-lived ES256 delegation per
core invocation. Core verifies it with its legacy `AGENTS_DELEGATION_PUBLIC_KEY` or the rotating
`AGENTS_DELEGATION_PUBLIC_KEYS_JSON` map, issuer, audience, run, installation, capability, and
correlation claims. The static internal token remains only as a development compatibility path.

External-effect tools reserve an idempotency-derived effect receipt before execution. Provider
success/failure is persisted separately from the tool result; ambiguous outcomes are surfaced by
`GET /v1/operations/effects/reconciliation` and must be reconciled before retrying.

User-owned model credentials are stored through `/v1/credentials` as encrypted vault records.
Set `AGENTS_CREDENTIAL_ENCRYPTION_KEY` to a random 32-byte hex or base64 key in every API and
worker process. API responses contain only opaque credential IDs; revoke the ID to prevent future
model calls.
