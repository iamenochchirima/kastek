# Kasitek Agents

The standalone Agents product creates, configures, tests, and publishes knowledge-backed
website FAQ agents. Business tasks run through Restate. The platform has exactly two
execution kinds, `business` and `workspace`; workspace execution is unavailable until
its Lina adapter is implemented.

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

Provision a fresh, dedicated PostgreSQL database and set `AGENTS_DATABASE_URL`.
The setup command rejects a database containing other application tables. It does
not migrate or delete an existing product database.

Start Restate from the repository root:

```sh
docker compose -f infra/agents-runtime/compose.yaml up -d
```

From `products/agents/api`, initialize the schema, then run the API and worker in
separate terminals. Each command explicitly loads the local environment file:

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
`nvidia/nemotron-3-super-120b-a12b:free`, with no paid fallback.

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

[Runtime setup and recovery limits](../../infra/agents-runtime/README.md) cover
pinned versions, duplicate delivery, cancellation, and retention. Login and the
full create/test/publish browser path require separate live acceptance.
