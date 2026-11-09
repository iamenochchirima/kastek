# Evaluation control plane

Phase 1 control plane for the agent evaluation and observability service. It owns the
sandbox registry, the sandbox version manifest and workspace references. It does not
run evaluations; the existing Agents eval fixture does.

## Phase 1 boundary

- Create, list and inspect persistent Agents sandboxes.
- Record code, image, schema, migration, config, runtime, model-route and adapter
  versions for every sandbox.
- Register the product workspace that belongs to a sandbox.
- Fail closed if the sandbox database is not the persistent `agents_evals`
  database, if it matches the product database, or if billing, live models,
  production identity or an open network policy is configured.
- Update, destroy, retention, Growth, Agency, client UI, MCP and billing test mode
  are later phases.

The service is intentionally separate from `apps/evals/`, which remains a client
prototype. The service is the control plane; the client is one consumer.

## Layout

```text
services/evals/
  migrations/          control-plane schema
  src/config.ts        environment and operator configuration
  src/guard.ts         fail-closed sandbox checks
  src/version.ts       sandbox version manifest
  src/store.ts         sandbox and workspace registry
  src/api.ts           Fastify operator API
  src/api-main.ts      service entry point
  src/harness/setup.ts normal-API sandbox setup client
  src/migrate.ts       migration runner
  tests/               guard, manifest and API tests
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `EVALS_DATABASE_URL` | yes | Control-plane PostgreSQL database. Must differ from the sandbox and product databases. |
| `EVALS_OPERATOR_TOKEN` | yes | Bearer token for the operator API. At least 32 bytes. |
| `EVALS_ENVIRONMENT` | no | `local` or `test` by default. `production` is rejected. |
| `EVALS_HOST` | no | Bind host. Default `127.0.0.1`. |
| `EVALS_PORT` | no | Bind port. Default `4600`. |
| `AGENTS_EVALS_DATABASE_URL` | yes | Persistent Agents sandbox database. Must be exactly `agents_evals`. |
| `AGENTS_PRODUCT_DATABASE_URL` | yes | Product database used only for isolation comparison. Falls back to `AGENTS_DATABASE_URL`. |
| `AGENTS_BILLING_ENFORCEMENT` | yes | Must be `0` in Phase 1. |
| `EVALS_MODEL_MODE` | no | Must be `deterministic`. |
| `EVALS_IDENTITY_MODE` | no | Must be `seed`. |
| `EVALS_NETWORK_POLICY` | no | Must be `loopback`. |
| `EVALS_REPO_ROOT` | no | Repository root for schema and git metadata. |
| `EVALS_CODE_REVISION` | no | Override the git revision when git metadata is unavailable. |
| `EVALS_IMAGE_DIGEST` | no | Image identity. Default `local-build`. |
| `EVALS_RUNTIME_VERSION` | no | Runtime version. Default `1.7.13`. |
| `EVALS_MODEL_ID` | no | Model identity for the route digest. Default `deterministic-provider-fixture`. |
| `EVALS_ADAPTER_VERSIONS` | no | JSON object of adapter versions. Default `{"core":"1","harbor":"0.24.0"}`. |
| `EVALS_LOG_LEVEL` | no | Fastify log level. |

The service never returns database URLs or credentials. The operator token is
redacted from request logs.

## Migrate and run

```sh
pnpm --filter @kasitek/evals-service migrate
pnpm --filter @kasitek/evals-service start
```

For development:

```sh
pnpm --filter @kasitek/evals-service dev
```

The service applies pending migrations on startup as well as through the explicit
migrate command.

## API

All routes except health require `Authorization: Bearer $EVALS_OPERATOR_TOKEN`.

### Create a sandbox

```sh
curl -sS http://127.0.0.1:4600/v1/sandboxes \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
```

Optional fields: `product` (`agents` only), `codeRevision`, `imageDigest`,
`schemaVersion`, `migrationChecksum`, `configDigest`, `runtimeVersion`,
`modelRoutesDigest`, `adapterVersions`, and an initial `workspaceRef`.

The service computes every missing manifest field. It refuses to create a sandbox
if a required field is incomplete or invalid.

### List and inspect

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes?limit=50" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"

curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

### Register a workspace

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/workspaces" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"productWorkspaceId":"<agents-organization-id>","label":"Persistent workspace"}'
```

### Record and read agent references

The control plane stores the product agent, immutable version, source revisions and digest
identity for every configured sandbox agent.

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/agents" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "workspaceRefId":"<workspace-ref-id>",
    "productAgentId":"<agents-agent-id>",
    "productVersionId":"<agents-version-id>",
    "sourceIds":["<source-id>"],
    "compositionDigest":"<64-hex>",
    "modelRoutesDigest":"<64-hex>"
  }'

curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/agents" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

`GET /v1/sandboxes/:id/agents/:agentRefId` reads one reference. Duplicate agent
versions return `409 AGENT_REF_EXISTS`; a workspace reference from another sandbox
is rejected.

### Normal-API setup client

`services/evals/src/harness/setup.ts` configures a sandbox through the normal Agents
HTTP APIs with a workspace user session:

- model provider connection and default
- knowledge import, extraction and approval
- agent creation, configuration and immutable version
- model-route preview
- second workspace member through the member API, including a denied owner action
- agent, version and source read-back
- control-plane agent reference recording

The client does not import product runtime source. The caller supplies the
product-specific agent configuration. The persistent fixture uses the client for
both first-run creation and later-run reuse.

## Persistent sandbox verification

The verification uses one persistent `agents_evals` database, one persistent
object-storage bucket and three sequential fixture runs. Each fixture run starts
and stops its own app and worker, so the later runs also exercise restart
persistence.

1. Create the control-plane database on the eval Postgres.
2. Start a persistent MinIO instance and note its endpoint, bucket and credentials.
3. Start the service with the environment above.
4. Create a sandbox through `POST /v1/sandboxes`.
5. Run the Agents fixture in sandbox mode with the sandbox id and version:

```sh
node --env-file=products/agents/api/.env \
  --env-file=products/agents/api/.env.evals \
  --import ./products/agents/api/node_modules/tsx/dist/loader.mjs \
  products/agents/api/test/harbor-fixture.ts
```

Required fixture environment:

```sh
AGENTS_EVAL_DATABASE_MODE=sandbox
AGENTS_EVAL_SANDBOX_ID=<sandbox-id>
AGENTS_EVAL_SANDBOX_VERSION=<sandbox-version-id>
AGENTS_EVAL_SANDBOX_EVIDENCE_DIR=.audit/sandbox/<sandbox-id>
AGENTS_EVAL_SANDBOX_MODEL_VAULT_KEY=<stable-base64-32-byte-key>
EVALS_API_URL=http://127.0.0.1:4600
EVALS_OPERATOR_TOKEN=<same operator token>
AGENTS_S3_ENDPOINT=http://127.0.0.1:<minio-port>
AGENTS_S3_REGION=us-east-1
AGENTS_S3_BUCKET=agents-evals-sandbox
AGENTS_S3_ACCESS_KEY_ID=<minio-access-key>
AGENTS_S3_SECRET_ACCESS_KEY=<minio-secret>
AGENTS_BILLING_ENFORCEMENT=0
EVALS_MODEL_MODE=deterministic
EVALS_IDENTITY_MODE=seed
EVALS_NETWORK_POLICY=loopback
```

The fixture reuses the same account, workspace, user, knowledge source, model
connection and published agent version on later runs. It writes
`run-*.json`, `latest.json` and the core acceptance evidence under the evidence
directory. The agent and source ids must match across runs.

The fixture looks up the sandbox version before starting. A missing, inactive or
mismatched version fails before any product work begins.

Persistent sandbox runs use normal product tasks. The product's evaluation-trial
API reserves an agent for one isolated trial, so that path remains exclusive to
the per-run mode. Do not use both paths on the same agent.

The fixture's per-run database path remains available with
`AGENTS_EVAL_DATABASE_MODE=per-run`. Use it only for destructive or load tests.
The service does not accept a per-run database as a persistent sandbox.

## Tests

```sh
EVALS_TEST_DATABASE_URL=postgresql://control@127.0.0.1:5432/evals_service_test \
  pnpm --filter @kasitek/evals-service test
```

The API tests migrate the test database and truncate only the `evals` tables.
Guard and manifest tests do not need a database.

## Release impact

- Documentation: this README and the root architecture map.
- Analytics: not applicable to the control plane in Phase 1.
- Logging: structured create, inspect and guard events; authorization redacted.
- Versioning: service package, sandbox version manifest and adapter versions.
- Validation: typecheck, guard tests, API tests, two-run persistence and restart.
- Rollout: local and development only; no production deployment.
- Rollback: stop the service and use the fixture's per-run mode. Sandbox data
  remains isolated.
- Migration: new `evals` control-plane schema only; no product data migration.
