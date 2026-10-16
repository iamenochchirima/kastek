# KasiTek Agent Platform

Development model policy, agreed 2026-10-07: use OpenRouter
`nvidia/nemotron-3-super-120b-a12b:free` for synthetic local checks. Local
`KASIAI_MODEL` selects this exact endpoint. Do not use paid models or paid
fallbacks for development checks without the user's approval. Free endpoint
availability and limits can change; fail visibly rather than substitute a paid model.
Historical runs retain the model they actually used.

This is the separately deployable Agent Platform service. It owns agent definitions,
durable run orchestration, conversations, memory, and operational records for the direct
KasiTek product. It does not query or mutate `kasitek-core` tables; consequential product
actions will go through authenticated internal contracts exposed by `kasitek-core`.

## Product direction and current status

The platform supports two planned delivery tracks: hosted API-based agents with short-run or durable execution, and deployment/management of our own filesystem-based personal runtime.

Use the [current architecture](docs/architecture/agent-platform-architecture.md) and [delivery checklist](docs/plans/agents/AGENT_PLATFORM_DELIVERY_PLAN.md). They replace the older broad rewrite roadmap. Personal runtime development has a [linked checklist](docs/plans/agents/PERSONAL_AGENT_RUNTIME_PLAN.md).

This repository owns the API, database migrations, Temporal worker, MCP gateway, knowledge/memory modules, channel adapters and management UI. The local standalone journey now supports shared sign-in, agent configuration, real model replies, knowledge retrieval, approved tools, website publication and inbox teammate replies. External provider/channel acceptance remains explicit; see [client integration status](docs/source-boundary.md) and the [end-to-end checklist](docs/plans/agents/END_TO_END_IMPLEMENTATION_PLAN.md).

Growth and Agency are optional product-tool integrations through authenticated interfaces, not runtime or database dependencies for every agent. Shared login comes from Labs Keycloak; Analytics uses its configured ingestion endpoint, and telemetry uses the Labs Collector. Agents owns its organization authorization and sessions.

## Source layout

- `api/`: backend source, migrations, tests, process scripts and environment templates.
- `web/`: management UI.
- `mcp/`: stdio MCP bridge package.
- `docs/` and `examples/`: product documentation and integration examples.

Use the root Node 24/pnpm workspace to install and build dependencies. From the repository root,
`pnpm dev:agents` starts the UI and `pnpm dev:agents-api` starts the API with its local migration
step. Keep backend secrets in `api/.env`, using `api/.env.example` as the template.

## Processes

The backend commands below run from `products/agents/api/` unless otherwise specified.
The stdio bridge command runs from `products/agents/mcp/`; UI commands run from
`products/agents/web/`.

- `pnpm run dev:api` applies pending local migrations, then starts the HTTP API.
- `pnpm run dev:gateway` starts the stateless external MCP gateway.
- `pnpm run dev:stdio` starts the local line-delimited stdio bridge to that gateway.
- `pnpm run dev:worker` starts the Temporal worker.
- `pnpm run migrate` applies PostgreSQL migrations.
- `pnpm run test:e2e:local` exercises a real local installation through REST, Temporal, and MCP.
- `pnpm run test:telemetry:collector-unavailable` checks API liveness and readiness when OTLP returns HTTP 503 or the Collector connection is refused.
- `pnpm run bootstrap:kasiai` idempotently creates the protected KasiAi definition and initial
  published version after migrations are applied.
- `pnpm run build` compiles the API, worker, and gateway entry points to `dist/`.
- `RUN_AGENTS_DB_INTEGRATION_TESTS=true AGENTS_DATABASE_URL=... pnpm test` enables the
  opt-in PostgreSQL isolation/deletion tests; the normal test command never mutates a database.

The Core public-v1 conformance check consumes the Growth product source. From the API package,
run `KASITEK_GROWTH_REPO_ROOT=../../growth pnpm exec vitest run test/rest-mcp-conformance.test.ts`.

The API and worker are separate process types. The default local-stack mode connects them to a
dedicated Temporal Cloud development namespace. Set `TEMPORAL_MODE=local`,
`TEMPORAL_ADDRESS=localhost:7233`, and `TEMPORAL_NAMESPACE=default` when a completely local
Temporal Server is needed. A hosted runtime needs a dedicated namespace and task queue; configuring
or changing that runtime is separate work.

For the local management app, start PostgreSQL and Labs identity, then the local
Temporal server, API, worker and `pnpm dev` in separate terminals. The current
Playground setup uses Temporal namespace `default` and queue
`kasitek-agents-initial-ui`. Keep local secrets in the ignored `api/.env`. Use
`http://localhost:3100` consistently with `AGENTS_PUBLIC_URL`; starting login on
`127.0.0.1` and returning to `localhost` loses the login transaction cookie.
Check API `/health/live` and `/health/ready` before opening Studio.

For a fully local durable setup, configure these non-secret values in `api/.env`:

```dotenv
HOST=127.0.0.1
PORT=4100
AUTH_MODE=hmac
AGENTS_PUBLIC_URL=http://localhost:3100
TEMPORAL_ENABLED=true
TEMPORAL_MODE=local
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=kasitek-agents-initial-ui
CREDIT_BILLING_MODE=disabled
```

Also configure the separate Agents PostgreSQL URL, internal authentication secret,
credential encryption key and Labs OIDC client settings listed in `api/.env.example`.
Use each model provider's own key. The disabled billing setting above is for local
development only. Start PostgreSQL and Labs Keycloak using their existing setup.

Run Temporal in its own terminal. From the repository root, start each application process in
a separate terminal:

```bash
temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-port 8233
```

```bash
pnpm dev:agents-api
```

```bash
pnpm --dir products/agents/api run dev:worker
```

```bash
pnpm dev:agents
```

The API command applies Agents migrations. Open `http://localhost:3100`, sign in,
and select the workspace. Simple agents run inside the API; durable agents require
the Temporal server and worker. The MCP gateway is needed only for external MCP
clients. Website chat and Discord have separate startup instructions below.

Agent Knowledge creates agent-scoped sources, so the same facts are available in
Playground and separately published website installations. Conversation memory
keeps its own scope. Add page reads one URL through the existing bounded fetch
and indexing path without a crawler key. To try it with the included sample, add
`http://localhost:3200/faq.txt`, then ask website chat about the return period.

Full website knowledge crawling uses `FIRECRAWL_API_KEY` and optionally
`FIRECRAWL_API_BASE_URL`. Without a configured crawler the screen explains the
setup and disables crawl submission. While a crawl runs, the source displays the
provider's processed/total page counts when available. A completed crawl with no
readable pages is a failed source, not ready knowledge.

The gateway is a separate process. It owns no database, Temporal, Core, or product state:
`POST /mcp` forwards the authenticated JSON-RPC request to the private Agent API, and `/health`
reports gateway liveness. `/health/ready` checks the Agent API readiness endpoint and `/metrics`
exposes redacted in-process request counters and latency. Local development binds the gateway to
loopback by default. Hosted routing and production deployment are separate work.

The gateway applies bounded in-process fixed-window limits before forwarding requests. Set
`MCP_GATEWAY_ENABLED=false` for an emergency transport disable, and tune the authenticated and
pre-authentication windows with the `MCP_GATEWAY_*` variables. These controls are transport-local;
installation grants, capability policy, approvals, usage, and audit remain owned by the Agent API.
`MCP_STATELESS_ENABLED` controls the Agent API's 2026 stateless path and
`MCP_GATEWAY_STATELESS_ENABLED` controls the gateway adapter. Both default on for local
development/test and off for production unless explicitly enabled. Turning either switch off
returns an unsupported-version response for 2026 requests while leaving the pre-2026 path intact,
so rollback does not disable existing clients.
The gateway supports the MCP `2026-07-28` stateless path and retains the pre-2026 `2025-06-18`
initialize-based compatibility path during migration. The 2026 path uses per-request metadata,
header/body validation, `server/discover`, deterministic/cacheable tool lists, and optional Tasks
handles for clients that advertise the extension. It currently uses JSON responses for ordinary POST
Streamable HTTP and does not claim standalone GET streaming or resumable session support. Set
`MCP_GATEWAY_ALLOWED_ORIGINS` to a comma-separated allowlist when browser-originated MCP requests
are expected; presented Origins not on the allowlist are rejected.
Gateway metrics include redacted protocol-era, safe method-bucket, result-class, error, in-flight,
and latency counters; they never include tokens, arguments, organization identifiers, or tool
catalog contents.

The machine-readable integration guide for external MCP clients is in
[`docs/mcp-integration.md`](docs/mcp-integration.md).
The rollout-focused migration note is in
[`docs/mcp-2026-migration.md`](docs/mcp-2026-migration.md).
The runtime/Core ownership seam is documented in
[`docs/architecture/agent-runtime-host-boundary.md`](docs/architecture/agent-runtime-host-boundary.md).
The [technical documentation index](docs/README.md) links to the Agent architecture, operations,
and runbooks.

Clients that only support local MCP stdio can run `pnpm run start:stdio` with
`MCP_STDIO_API_KEY` set to a Developer API key and, when needed,
`MCP_STDIO_URL` pointed at the hosted `/mcp` endpoint. The bridge owns no state; it forwards one
JSON-RPC message per input line, selects the 2026 HTTP revision for messages carrying 2026 metadata,
retains the pre-2026 flow for older clients, bounds messages/responses, preserves notifications, and
never logs the bearer token. Before forwarding an old-client message it probes `server/discover`
once (configurable with `MCP_STDIO_PROBE=false`); a modern-only endpoint produces a bounded local
unsupported-version error instead of sending an incompatible initialize request.

The publishable package boundary is being prepared in [`mcp`](mcp). Build its
standalone local adapter with `pnpm run build:mcp`. It is intentionally separate from the Agent API
runtime and does not contain tools, authorization, product data, or a REST client; publication is
blocked until the Developers authentication/setup flow is wired and tested.

The capability catalog used by MCP discovery, public tool discovery, permission UI, audit
descriptions, and agent documentation is generated from the runtime manifest registry. Regenerate
the checked-in catalog with `pnpm generate:capabilities`; the output is
[`docs/generated-capabilities.md`](docs/generated-capabilities.md).

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
pnpm dev:agents-api
pnpm --dir products/agents/api run dev:worker
pnpm run dev:gateway
```

Set a dedicated development ES256 `INSTALLATION_TOKEN_PRIVATE_KEY` in `.env` before starting
the API, and use a non-production `AGENT_GATEWAY_SHARED_SECRET` when the gateway and API communicate
over a non-private local network. Then run `pnpm run test:e2e:local`. The smoke test creates an
isolated organization, agent, installation, credential, and two durable runs. It verifies REST
credential exchange, filtered discovery, idempotent execution, MCP authentication, protocol
negotiation, and MCP tool acceptance; it archives its agent fixture afterwards. Set
`AGENTS_E2E_KEEP_FIXTURES=true` only when investigating a failed run.

Cloud mode requires `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, and `TEMPORAL_API_KEY` in
`.env` (or the environment used to launch the processes). Never commit the API key.

KasiAi uses `KASIAI_MODEL_PROVIDER` and `KASIAI_MODEL` for its pinned initial model target. The
matching provider key is resolved only inside worker activities and is never stored in an agent
definition or workflow input. The Agents model gateway supports independent OpenRouter, OpenAI,
Anthropic, Gemini, DeepSeek, GLM, Kimi, MiniMax, xAI, OpenCode Go and OpenCode Zen credentials.
For local managed credentials, configure only the corresponding key from `.env.example`. An
organization can instead save a provider-specific BYOK key in Agents > Models. A key for one
provider does not enable another provider; OpenRouter is only the sample workspace default.
The model list is discovered from each provider's own catalog when its key is available. Saved
organization keys are resolved server-side for that provider only; when a catalog is unavailable,
the UI keeps that provider's preset models available.
OpenCode Go and Zen route Chat Completions, Responses, Anthropic Messages and Gemini models through
the matching runtime adapter. Typed System One models and unclassified model IDs remain hidden
from the chat picker until their protocol is supported.

Credit settlement is enforced by default. Set `CREDIT_BILLING_MODE=shadow` to calculate pricing
without debiting, or `CREDIT_BILLING_MODE=disabled` to skip credit settlement. User-funded BYOK
credentials do not consume KasiTek credits.

The relocated root `Dockerfile` builds the API and worker package and includes `migrations/`. It
defaults to the API entry point; the gateway and worker entry points are `dist/gateway/server.js`
and `dist/temporal/worker.js`. The root-level `railway.api.json`, `railway.gateway.json`, and
`railway.worker.json` files hold service-specific start commands; the API and gateway configs also
define readiness checks. Moving these files does not change hosted Railway settings or deploy a
service.

Run requests may include an `idempotencyKey`; retries within an organization return the original
run and do not start a second Temporal workflow. Run inspection is available at
`GET /v1/runs/:runId/timeline`, which joins lifecycle events, ordered run steps, and audited tool
invocations. The timeline is organization-scoped and backed by PostgreSQL, so it does not rely
on API process memory or sticky sessions.

For a plain external REST-client check, use the dependency-free Python harness after creating an
installation credential and starting the Agent API:

```bash
AGENTS_REST_SMOKE_INSTALLATION_ID=... \\
AGENTS_REST_SMOKE_SECRET=... \\
python3 scripts/rest-client-smoke.py
```

Set `AGENTS_REST_SMOKE_TOKEN` instead when a public-API token has already been exchanged. The
harness verifies discovery, a durable tool acceptance, idempotent retry, and operation inspection;
it does not claim the n8n or hosted-client gates.

Platform chat clients first call
`POST /v1/installations/:installationId/platform/conversation` to resolve the authenticated
user's durable conversation. They send text through
`POST /v1/installations/:installationId/platform/messages` with a client-generated
`idempotencyKey`. The latter stores the inbound message and run atomically, then dispatches the
idempotently named Temporal workflow. Assistant output is committed as an outbound message in
the same transaction that completes the run. Clients can read durable history from
`GET /v1/conversations/:conversationId` and stream run events from
`GET /v1/runs/:runId/events/stream`.

Model selection follows the conversation boundary. A version's model policy supplies the default
when a new conversation is created; after that, `conversations.model_provider` and
`conversations.model` are authoritative for every run in that conversation. Existing-conversation
message payloads must not be used to switch models per message. Each accepted run snapshots the
conversation model into `agent_runs.resolved_model_provider` and `agent_runs.resolved_model`.

## kasitek-core read boundary

The worker can expose explicitly granted read-only core tools when the core URL and one of these
authentication modes are present:

- `KASITEK_CORE_URL` — the private base URL of `kasitek-core`.
- `KASITEK_CORE_INTERNAL_TOKEN` — a dedicated bearer token configured in core as
  `KASITEK_AGENTS_INTERNAL_TOKEN`.
- `KASITEK_CORE_DELEGATION_PRIVATE_KEY` — an ES256 private key for per-invocation delegation.
- `KASITEK_CORE_DELEGATION_KEY_ID` — optional active signing-key identifier during a core
  delegation-key rotation; it must match core's trusted key map.

Growth's existing `scripts/run_local_stack.sh` supplies `KASITEK_CORE_URL` and the matching local
Core credential to both services, but still loads the Growth checkout's `agents/.env`. For a
standalone Agents checkout, configure `KASITEK_CORE_URL` and either
`KASITEK_CORE_INTERNAL_TOKEN` or `KASITEK_CORE_DELEGATION_PRIVATE_KEY`; Core must retain its
corresponding authentication configuration. If the Agent-side URL or credential is missing, the
tool fails before making an HTTP request with `CORE_UNAVAILABLE`.

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

Agent integrations use the same encrypted-secret boundary without adding provider-specific
credential tables. The catalog in `api/src/integrations/catalog.ts` describes each provider, the
connection API stores installation-scoped state, and `api/src/integrations/tools.ts` exposes provider
operations through the existing capability registry and approval policy. OAuth-backed Google
connections use `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and
`GOOGLE_OAUTH_REDIRECT_URI`; each catalog entry supplies its own requested scopes through the
shared Google OAuth boundary. Add a provider by adding one catalog entry, an adapter in
`IntegrationToolService`, and its connection form; do not add a new tool execution path. The first
adapters are KasiTek Calendar, Google Calendar, Gmail, Google Drive, Tavily Search, and an Apple Tools local bridge.

## Management UI

The Next.js app is in `web` and contains the `/agents/**`, `/studio`,
`/studio/new`, and `/playground` routes. Growth retains its copy until the separate cleanup is
completed. Authentication and API integrations in the relocated app remain transitional; this
source move does not configure a standalone production service. See [the source boundary](docs/source-boundary.md).

Use Node `24.15.0` from the repository `.nvmrc` and pnpm `10.30.1`.

```bash
pnpm install
pnpm dev:agents
```

Focused UI commands:

```bash
pnpm typecheck
pnpm test:studio
pnpm build:ui
```

`pnpm build` builds the API and worker. The UI's `pnpm lint:ui` command is available, while
the relocated source currently reports existing React-hook lint errors.

## Simple and durable agent runs

In Studio Settings → Runtime, choose Simple or Durable, save the version, then
use that version in Playground. The version keeps the execution choice. Simple
Playground and authenticated `/v1/runs` requests use the shared agent harness
inside the API process, without a Temporal workflow. Durability remains explicit
for approvals, waits and workflow graphs. Both paths save their run evidence.

Simple runs honor configured model/tool/token limits and `maxWallTimeMs`, capped
at five minutes, and support cancellation. A graceful API shutdown records an
interrupted failure. On startup and every 30 seconds, the API checks persisted
simple dispatches whose deadlines passed with an additional 30-second grace.
It records an interrupted failure and releases the conversation lease. It never
restarts the request automatically. Check external actions before retrying.
Agent Settings provides server-side API keys for one custom hosted installation.
The public API always attaches messages to a saved conversation. Internal `/v1/runs`
remains a separate service-token interface with runs:write and runs:read. Never give the signing secret to browsers
or customer websites. Agents-owned website replies use the shared simple/durable dispatcher; other channel adapters still need their own end-to-end acceptance.


### Invoke an agent from your server

In Agent details → Settings → Agent API keys, create a labelled key and choose
its expiry. Copy it immediately; refresh/hiding clears the displayed value.
The default expiry is 90 days, with a maximum of 365. Save the key in your server's
secret configuration. It is never a model-provider key and never belongs in a
browser widget. Revoking it stops new requests and closes admitted event streams
at their next authorization check. Accepted runs continue unless separately cancelled.

Send a first message, then reuse the returned `conversation.id` as `conversationId`
on subsequent messages. Use a fresh idempotency key for each new message and reuse
that same key when retrying its delivery. The agent uses its pinned installation
version, model and execution choice.

```sh
AGENTS_ORIGIN='http://127.0.0.1:4100'
# Supply AGENT_API_KEY through your server's secret configuration.
curl "$AGENTS_ORIGIN/api/v1/agent/messages" \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello","createNew":true,"idempotencyKey":"first-request-001"}'

# Replace RUN_ID with the returned runId to read status and the completed answer.
curl "$AGENTS_ORIGIN/api/v1/agent/runs/RUN_ID" \
  -H "Authorization: Bearer $AGENT_API_KEY"
```

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/agent/messages` | Send `message`, `idempotencyKey`, and either `conversationId` or `createNew:true`; returns 202 with conversation and run |
| `POST /api/v1/agent/conversations` | Create an empty saved conversation with `{}` |
| `GET /api/v1/agent/conversations/:conversationId` | Read the saved chat for this installation |
| `GET /api/v1/agent/runs/:runId` | Read persisted run status, output/error and events |
| `GET /api/v1/agent/runs/:runId/events/stream?after=0` | Stream recorded events; reconnect with the last event cursor |
| `POST /api/v1/agent/runs/:runId/cancel` | Cancel an active run with `{}` |

Ordinary errors are 400 for invalid input, 401 for an invalid/expired/revoked key
or inactive installation/member, 403 for browser use, and 404 for a run/conversation
outside the key's installation. A 202 response means accepted; inspect persisted
run status for completion or failure. Provider errors belong to the run outcome.
Keys cannot override model settings, manage agents, authorize tools or call the
internal `/v1` interface. Website customer sessions use their separate scoped
visitor admission below.


Studio shows a durable workflow's saved wait state and offers Send event for its
expected event key. Workspace write permission is required. A mismatched key
returns 409 and does not signal the run. A real local workflow survived worker
restart and resumed through this control; its model reply and terminal state
remained available after reload. Tool-specific approval setup/acceptance remains
part of the tools implementation stage.

### Local website chat and inbox

For a custom customer-service agent, publish its Playground version, open Agent
details → Website chat, add the sample website origin `http://localhost:3200`,
then copy the embed. Each website has an independent live installation pinned to
that published version. Pause/resume acts on backend state. Later draft edits do
not change the live version.

Run the included sample separately from the management app:

```bash
python3 -m http.server 3200 --bind 127.0.0.1 --directory products/agents/examples/website-chat
```

Open `http://localhost:3200`, paste the public deployment ID and open chat.
`AGENTS_PUBLIC_URL` must be the management origin (`http://localhost:3100` locally);
the sample's loader uses that origin. Apply migrations 182/183 to the Agents DB.
Public visitor capabilities expire after one day, are origin/session scoped and
are stored as hashes on the server. No model key belongs in an embed.

Open `/app/inbox` to view the same customer conversation, take over, reply, add a
private note, resolve/reopen or return replies to the agent. Notes remain internal.
Known successful human writes are deduplicated. Live updates reconnect using
lifecycle cursors and saved history. Real visitor API/SSE replies, browser teammate
controls, embedded browser submission, refresh continuity and private-note
isolation passed locally. Temporary failures display a readable error; bounded
streams and periodic history reload recover replies after an interruption. Share links, voice and uploads
are not enabled by this slice. See the end-to-end checklist for external setup and
remaining acceptance.

### Reviewed remote MCP tool results

Open Agent Tools → Remote MCP, discover a provider and check its health. Before
publishing the discovered revision, enter only the top-level result fields the
agent needs, such as `reference,status`. Publication stores those selections in
that immutable provider revision. Pin the published revision to a new agent
version and publish it. Existing live versions keep their earlier pins.

The raw response stays redacted. Reviewed results support bounded JSON scalar
fields, including a JSON object in MCP text or structuredContent. Nested objects
and credential-shaped fields are excluded. A tool reporting isError fails its
attempt instead of producing a success answer. Remote arguments still pass
through the existing grants and approval policy.

### Discord setup prerequisites

The retained Discord dialog and channel list now use scoped Agents browser
endpoints. Use a dedicated bot and an authorized test account. Put the bot token
in the dialog or server credential store; never in a public widget or document.
Enable Message Content Intent for the bot. Configure explicit allowed user and
server-channel IDs; empty server-channel IDs deny server traffic. The default
server policy requires a mention.

Alongside the API, start the retained gateway with its matching Agents database
and internal authentication configuration:

```bash
DISCORD_GATEWAY_ENABLED=true pnpm --dir products/agents/api run dev:discord
```

`DISCORD_GATEWAY_PLATFORM_URL` points to the API, locally
`http://127.0.0.1:4100`. Saving a verified token creates a connection with
`waiting_for_gateway` status. A saved connection alone does not prove inbound
messages or outbound delivery. Check the gateway status, then perform the real
incoming message → reply → inbox takeover → human reply journey before claiming
Discord acceptance. Inbox teammate replies use the matching Discord bot credential
and the retained Discord API adapter directly; they do not depend on Growth. Growth's shared social-account connection contract remains
pending and is not called by this screen.
