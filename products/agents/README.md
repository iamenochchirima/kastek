# Kasitek Agents

The standalone Agents product creates, configures, and tests business agents with
conversation context, reviewed personal memory, pinned skills, bounded tool rounds,
recorded context compaction, bounded business subagents and optional isolated Python analysis. Restate coordinates durable execution. A minimal
knowledge-backed website FAQ uses the same harness with optional capabilities
disabled. The technical kinds remain `business` and `workspace`; workspace
execution is unavailable until its separate Lina adapter is implemented.

The [architecture](docs/architecture/agent-platform-architecture.md) defines the target.
The [implementation boundary](docs/source-boundary.md) records current behavior and limits.
Growth and Agencies are later integrations. Neither is required to run Agents.

## Start locally

Use Node 24 and the repository's pnpm workspace. Install dependencies from the root:

```sh
pnpm install
```

Configure [local identity](../../infra/identity/README.md). Its Keycloak 26.6.0
registration includes the separate `agents` client. Copy `api/.env.example` to
`api/.env`, set independent local secrets, and use the matching Agents client secret.
Keep that file private. Use `http://localhost:3100` consistently for the browser.

Provision a fresh, dedicated PostgreSQL 17 database with pgvector 0.8.7 and set `AGENTS_DATABASE_URL`.
The setup command rejects a database containing other application tables. It does
not migrate or delete an existing product database.

The verified local database image is
`pgvector/pgvector@sha256:cd4ccfdaf62cbfeb5c6ee19ef0dd663406d4ed740c320b324d016a90e85385b3`,
which contains PostgreSQL 17.11 and pgvector 0.8.7. Schema setup requires permission to create
the `vector` extension in this dedicated database.

For document imports, configure private S3-compatible storage, prepare the isolated document
runtime, and set `AGENTS_DOCUMENT_RUNTIME_ENABLED=1`:

```sh
bash infra/agents-runtime/document-prepare.sh
```

This setup downloads pinned public runtime/model artifacts. Import processing and embeddings
run without guest network access. From `products/agents/api`, run the independent cleanup
processes alongside the worker:

```sh
pnpm dev:document-reaper
pnpm dev:source-object-reaper
```

The document reaper needs the Agents database and runtime, and the source-object reaper needs
the database and private storage. Storage outages do not stop physical resource cleanup.

Start Restate from the repository root:

```sh
docker compose -f infra/agents-runtime/compose.yaml up -d
```

The worker defaults to loopback. For the private Docker bridge above, set these
values in your local `api/.env` so Restate can reach it:

```dotenv
RESTATE_WORKER_HOST=0.0.0.0
AGENTS_ALLOW_UNSIGNED_WORKER=1
```

Restrict that development listener with host network controls. Production requires
`RESTATE_REQUEST_IDENTITY_KEYS` even when the unsigned development override is set.
Use the cluster's `publickeyv1_` keys and keep the worker private. The
[environment example](api/.env.example) lists these settings.

From `products/agents/api`, initialize the schema, then run the API and worker in
separate terminals. Each command loads the local environment file:

```sh
node --env-file-if-exists=.env --import tsx src/platform/setup.ts
node --env-file-if-exists=.env --import tsx --watch src/platform/server.ts
node --env-file-if-exists=.env --import tsx --watch src/platform/worker.ts
```

After the worker starts on port 9080, register its HTTP/2 endpoint with Restate.
Run this local registration from the repository root:

```sh
curl --fail-with-body -X POST http://127.0.0.1:19070/deployments \
  -H 'Content-Type: application/json' \
  -d '{"uri":"http://host.docker.internal:9080","use_http_11":false,"force":false}'
```

Start the management app from the repository root:

```sh
pnpm dev:agents
```

Open `http://localhost:3100`. The web server proxies `/api` to port 4100.
API diagnostics are `http://127.0.0.1:4100/health` and `/ready`.
The worker needs `OPENROUTER_API_KEY`. Development permits only
`nvidia/nemotron-3-super-120b-a12b:free`, with reasoning disabled and no paid fallback.

Private storage is required for knowledge, connected evidence and isolated analysis. Conversations without those capabilities can run without it. Configure all five `AGENTS_S3_*` settings
from the environment example and provision a private S3-compatible bucket.
Without them, artifact storage remains unavailable. Context snapshots and memory
revisions remain in private PostgreSQL records.

## Enable local analysis

The analysis profile requires Linux x86_64, user namespaces, a working systemd user
manager with delegated CPU/memory/process controls, and the pinned gVisor runtime.
Prepare and verify the local backend from the repository root:

```sh
bash infra/agents-runtime/prepare-sandbox.sh
bash infra/agents-runtime/verify-sandbox.sh
```

Configure private S3 storage and set `AGENTS_SANDBOX_ENABLED=1` in the local API
`.env`. From `products/agents/api`, run the independent cleanup process alongside
the worker:

```sh
pnpm dev:sandbox-reaper
```

The reaper shares the private allocation directory with the worker. Generated code
receives no credentials or network. Select the analysis capability in an immutable
agent version. Missing storage or a missing backend blocks analysis admission.
This runtime is temporary compute; it does not create a persistent workspace.

A coordinator can pin at most two permitted business specialist versions with
explicit source/tool subsets and child allocations. Specialists have no inherited
personal memory, sandbox or delegation permission. Parent and children share the
original root budget.

## Reviewed reports and automation

Configure the connection keyring and destination allowlist in `api/.env` using
`api/.env.example`. Keys contain 32 random bytes encoded as base64; keep them
outside Git and PostgreSQL. Every destination names one HTTPS `/deliveries`
endpoint and resource. Loopback HTTP is restricted to local development.

Create a scoped connection in **Connections**, enable **Report delivery** on an
agent, select its connection and artifact name, and publish an immutable version.
**Automations** binds that version to a one-shot UTC time, fixed UTC interval, or
authenticated event. Each occurrence has its own task and exact human report
review. Automation authorization is finite and does not preapprove any delivery.

The first adapter implements ReportDeliveryHTTP, with a persistent acceptance
receiver for local verification. It does not configure a third-party provider,
OAuth or external MCP connection. See the [implementation boundary](docs/source-boundary.md#connected-reports-and-automation)
for policy, expiry and uncertainty behavior.

## Verify

From the repository root:

```sh
pnpm --dir products/agents/api typecheck
pnpm --dir products/agents/api test
pnpm --dir products/agents/api test:runtime
pnpm verify:boundaries
```

PostgreSQL integration suites require `AGENTS_TEST_DATABASE_URL` pointing to a
separate disposable test server with permission to create databases. They create
and drop uniquely named test databases. The business suite also starts its own
Restate container and uses deterministic provider responses. These checks do not
prove a real model reply or the complete browser journey.

Verify real private storage and memory against disposable PostgreSQL and MinIO:

```sh
bash infra/agents-runtime/verify-storage.sh
```

For the live harness browser journey, keep Vite running on `localhost:3100` and
stop the ordinary API and worker so fixture ports 4100 and 9080 are free. Set
`AGENTS_BROWSER_FIXTURE_DATABASE_URL` in your shell to a disposable PostgreSQL
administrator connection. From `products/agents/api`, run:

```sh
AGENTS_HARNESS_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file-if-exists=.env --import tsx test/browser-fixture.ts
```

This uses the approved free-model key from the local environment. It creates its
own database, API, worker, and browser session, starts Restate if needed, and
cleans its owned resources. It verifies reviewed memory, a pinned skill,
contextual follow-up, a new conversation, and a real `memory.search` operation.
Run the complete delegation/analysis journey with the same disposable database,
Vite and free-model prerequisites, using `AGENTS_ADVANCED_LIVE=1` in place of
`AGENTS_HARNESS_LIVE=1`. It starts owned MinIO storage and a separate reaper,
checks two real specialist tasks, and verifies a downloaded analysis report.

For scheduled report review and delivery, build the API first, then run:

```sh
pnpm --filter @kasitek/agents build
AGENTS_AUTOMATION_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file-if-exists=.env --import tsx test/browser-fixture.ts
```

Keep Vite running and use the same disposable PostgreSQL prerequisite. This mode
starts a compiled worker, private Restate instance, MinIO, gVisor, and a separate
authenticated receiver. It restarts the worker while review is pending, then
interrupts the sender after the receiver has persisted the approved report. It
checks the original artifact, two specialist tasks, one delivery POST, and receipt
recovery through a real status request. The receiver never contacts real people.
The runtime cache and MinIO binary prerequisites are the same as the advanced
journey (`AGENTS_TEST_MINIO_BINARY` can select the local MinIO executable).

Identity is seeded for these fixtures. Real OIDC is checked separately:

```sh
bash infra/agents-runtime/verify-identity.sh
```

[Runtime setup and recovery limits](../../infra/agents-runtime/README.md) cover
pinned versions, worker signatures, duplicate delivery, cancellation, storage, and
retention. Local checks do not establish production deployment readiness.

## Verify connected knowledge

The ordinary backend suite uses explicit protocol/model/storage fixtures where
noted. It never turns on paid provider calls:

```sh
pnpm --filter @kasitek/agents exec vitest run --maxWorkers=1
```

Actual document, local embedding, PostgreSQL/pgvector, private MinIO and compiled
worker checks are opt-in. In `api/`, load your approved local configuration and
point `AGENTS_TEST_DATABASE_URL` at an owned disposable-database-capable server:

```sh
AGENTS_INGESTION_LIVE=1 AGENTS_INGESTION_FREE_MODEL=1 \
  node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run \
  test/platform-ingestion-live.test.ts --maxWorkers=1
```

The fixture expects private MinIO at port 19000 with the explicit test credentials
in its source. It creates and deletes its own bucket/database/Restate/worker. It
checks PDF tail evidence, private candidates, duplicate admission, worker SIGKILL
recovery and a real free-model website FAQ. No external connector is mocked into
that free-model proof. `AGENTS_INGESTION_BROWSER=1` additionally requires the local
Vite fixture on port 3113 and drives import, preview, approval and withdrawal.

The real GitHub check requires a separately approved fine-grained read-only PAT
in `AGENTS_GITHUB_ACCEPTANCE_TOKEN` and its actual finite ISO expiry in
`AGENTS_GITHUB_ACCEPTANCE_EXPIRES_AT`. It reads the default approved public
`github/github-mcp-server` repository; the test header lists explicit overrides.
Never put the token in a command argument or chat. From `api/`:

```sh
AGENTS_GITHUB_LIVE=1 node --env-file-if-exists=.env \
  node_modules/vitest/vitest.mjs run test/github-live-acceptance.test.ts --maxWorkers=1
```

That check uses fixed official native/hosted-MCP endpoints, records negotiated
protocol/schema hashes and has no model calls. A skipped check is not provider
acceptance. The scheduled knowledge journey has passed with the free model, two
specialists, gVisor analysis, exact report review and delivery recovery across two
worker restarts. The combined real-provider journey remains incomplete until the
credential gate and authenticated native/MCP reads pass.
