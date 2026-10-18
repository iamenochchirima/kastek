# Kasitek Agents

Owner: Agents engineering. Last reviewed: 2026-10-18.

The standalone product targets mostly plug-and-play customer-service, FAQ, booking, and intake
agents for websites, WhatsApp, Facebook pages, and Instagram, with a shared staff inbox. Research
and campaign experiences belong in Growth or Agencies using the shared execution backend.
The website/widget path includes a shared staff Inbox, assignment, human replies, takeover and
explicit return to automation. Other channel providers and booking operations remain unavailable. See the
[product and inbox contracts](docs/architecture/agent-platform-architecture.md#standalone-agents-product).

The standalone application creates customer agents with approved knowledge, simple chat, website
publication and Inbox support. The shared harness also implements reviewed memory, pinned skills,
bounded specialist tasks, optional isolated analysis and reviewed report workflows for developer
and product contract fixtures. These capabilities do not define the standalone customer catalogue.
Restate coordinates durable execution. The technical kinds remain `business` and `workspace`; workspace
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
node --env-file-if-exists=.env --import tsx src/composition/setup.ts
node --env-file-if-exists=.env --import tsx --watch src/composition/server.ts
node --env-file-if-exists=.env --import tsx --watch src/composition/worker.ts
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

This setup verifies shared runtime capabilities. It does not add research or campaign offerings
to the standalone client. Those customer experiences belong in Growth or Agencies.

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

## Platform interface

This section describes the current management interface. The target customer-service inbox and
guided agent setup are not present. Runtime research/report fixtures do not define the Agents
client catalogue.

The public root restores the landing page. Sign in and Get started use the configured
identity provider; registration requires email verification. A signed, transaction-bound
return destination preserves internal application links through login.

The workspace sidebar contains Inbox, Agents, Tasks, Knowledge, Connections, Automations
and Settings. Creation uses the server offering catalogue: FAQ or customer service; booking is
unavailable. Every runnable business agent opens Chat, with Activity and Configure tabs.
Customer configuration exposes instructions, approved knowledge/revision pins, human support
and website publication. Rich harness configurations use developer/product fixtures. Saving a draft does not
change a runnable version. Create version is explicit, and each conversation keeps
its original version.

Conversation history comes from authorized server records and survives cleared
browser storage. New chat starts a separate conversation; unresolved admission must
be retried with its original request key first. Ordinary navigation does not cancel
accepted work. The initial composer accepts text, with Enter to send and Shift+Enter
for a new line. File imports remain in Knowledge.

Tasks lists authorized root work and links to its conversation or report review.
Inline progress, sources, files and exact report decisions use the same task APIs as
the standalone task page. Refresh conversation, window focus and visibility return
revalidate history against current policy. Older messages and events load in bounded
pages. Settings exposes actual account/workspace identity and persisted appearance.

Desktop uses separate navigation, agent/history and chat panes. Tablet collapses
global navigation; mobile exposes accessible navigation/history drawers and keeps the
composer within the viewport.

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

For the live harness browser journey, leave ordinary local services running. The
fixture starts its own UI, API, worker and Restate on available ports. Set
`AGENTS_BROWSER_FIXTURE_DATABASE_URL` in your shell to a disposable PostgreSQL
administrator connection. From `products/agents/api`, run:

```sh
AGENTS_HARNESS_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file-if-exists=.env --import tsx test/browser-fixture.ts
```

This uses the approved free-model key from the local environment. It creates its
own database, UI, API, worker, Restate and browser session, and
cleans its owned resources. It verifies reviewed memory, a pinned skill,
contextual follow-up, a new conversation, and a real `memory.search` operation.
Run the complete delegation/analysis journey with the same disposable database,
free-model prerequisites, using `AGENTS_ADVANCED_LIVE=1` in place of
`AGENTS_HARNESS_LIVE=1`. It starts owned MinIO storage and a separate reaper,
checks two real specialist tasks, and verifies a downloaded analysis report.

For scheduled report review and delivery, build the API first, then run:

```sh
pnpm --filter @kasitek/agents build
AGENTS_AUTOMATION_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file-if-exists=.env --import tsx test/browser-fixture.ts
```

Use the same disposable PostgreSQL prerequisite. This mode
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

The optional keyed GitHub check requires a separately approved fine-grained read-only PAT
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
worker restarts. Public repository acceptance uses anonymous native GitHub and DeepWiki MCP reads;
it requires no provider key. Keyed GitHub and Stash acceptance are separate opt-in checks.

The combined provider journey is a separate opt-in path. It requires the same
approved GitHub configuration, `OPENROUTER_API_KEY`, an owned fixture database in
`AGENTS_BROWSER_FIXTURE_DATABASE_URL`, the prepared gVisor/document runtimes and
private MinIO fixture. Build the API first; the fixture starts its own UI. From the
repository root:

```sh
AGENTS_GITHUB_JOURNEY=1 AGENTS_AUTOMATION_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file=products/agents/api/.env \
  --import ./products/agents/api/node_modules/tsx/dist/loader.mjs \
  products/agents/api/test/browser-fixture.ts
```

This mode uses matching compiled API/worker adapters. It combines imported source
revisions with native and official hosted-MCP reads in two specialists, then
checks isolated analysis, a dated report with explicit gaps, factual quotes, exact
citations, review and delivery recovery. Expected public text must fit a
16–200 character quote from the actual file. The fixture also
checks a worker restart after completed connected reads. The provider mode stops
before resource allocation when its approved credential or expiry is missing.
Preparing this path does not establish live-provider acceptance; that proof remains
pending until the configured journey exits successfully against GitHub.


For the public repository journey, build the API and
provide an owned disposable PostgreSQL fixture through
`AGENTS_BROWSER_FIXTURE_STATE_PATH` or `AGENTS_BROWSER_FIXTURE_DATABASE_URL`. The
prepared document and analysis runtimes and local MinIO binary are required. From
the repository root:

```sh
AGENTS_PUBLIC_REPOSITORY_JOURNEY=1 AGENTS_AUTOMATION_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file=products/agents/api/.env \
  --import ./products/agents/api/node_modules/tsx/dist/loader.mjs \
  products/agents/api/test/browser-fixture.ts
```

The default approved public repository is `modelcontextprotocol/typescript-sdk`, ref `main`, file
`README.md`. The native specialist reads an issued immutable file handle. The MCP
specialist reads its DeepWiki documentation structure. Each has a distinct imported
source and tool scope. The coordinator has no direct connected tools; its explicit
specialist selections supply the aggregate grant and version pins. The fixture
verifies exact evidence quotes, a dated report
with explicit gaps, isolated analysis, completed-read replay after restart and
reviewed delivery recovery. It uses the approved free model and no provider token.

For private Stash acceptance, use `AGENTS_STASH_JOURNEY=1` with the same automation
and model flags. Supply `STASH_AGENT_KEY`, the explicitly approved project note or
idea ID in `AGENTS_STASH_ACCEPTANCE_ITEM_ID`, and an exact first-passage quote in
`AGENTS_STASH_ACCEPTANCE_EXPECT`. The two specialists use `get_item` and
`read_project_document` respectively. Stash credentials stay in protected local
configuration, never command arguments, model context or browser state.
