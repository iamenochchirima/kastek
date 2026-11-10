# Evaluation control plane and interactive harness

Control plane for the agent evaluation and observability service. It owns the sandbox
registry, the sandbox version manifest, workspace, agent, outcome and interactive
session references. It also provides a terminal client that uses normal product APIs
to configure an agent, chat, read the transcript and inspect saved outcomes. It does
not run evaluations; the existing Agents eval fixture does.

## Current boundary

- Create, list, inspect and delete persistent Agents sandboxes.
- Record code, image, schema, migration, config, runtime, model-route and adapter
  versions for every sandbox.
- Register the product workspace that belongs to a sandbox.
- Record agent versions, saved outcomes and interactive sessions without storing
  transcript text or customer PII in the control plane.
- Configure and chat through normal Agents product sessions.
- Provision a local Agents sandbox with its own database, bucket, API, worker,
  Restate deployment and workspace.
- Attach a real central-billing sandbox plan to every provisioned Agents
  sandbox and to the Agents runtime paired with a Growth sandbox.
- Fail closed if the sandbox database is not the persistent `agents_evals`
  database, if it matches the product database, or if live models, production
  identity or an open network policy is configured.
- Update, destroy, retention, Agency, MCP and hosted provisioning are later
  phases.

The service is intentionally separate from `apps/evals/`, which remains a client
prototype. The service is the control plane; the client is one consumer.

## Layout

```text
services/evals/
  migrations/          control-plane schema
  src/config.ts        environment and operator configuration
  src/guard.ts         fail-closed sandbox checks
  src/version.ts       sandbox version manifest
  src/store.ts         sandbox, workspace, agent, outcome and session registry
  src/api.ts           Fastify operator API
  src/api-main.ts      service entry point
  src/harness/setup.ts normal-API sandbox setup client
  src/harness/interactive.ts service-backed session, chat and transcript client
  src/cli.ts           terminal client
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
| `AGENTS_BILLING_ENFORCEMENT` | no | Control-plane product environment only. Provisioned child runtimes always override it to `1`. |
| `EVALS_BILLING_SANDBOX_URL` | yes for provisioning | Central billing service URL used to attach sandbox plans. |
| `EVALS_BILLING_SANDBOX_SECRET` | yes for provisioning | Sandbox entitlement secret, at least 32 bytes. Must be provided with the URL. |
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

### Client configuration

The terminal client reads its own environment. It never prints session cookies,
model keys or operator tokens.

| Variable | Required | Purpose |
| --- | --- | --- |
| `EVALS_API_URL` | no | Control-plane URL. Default `http://127.0.0.1:4600`. |
| `EVALS_OPERATOR_TOKEN` | yes | Operator token for session and outcome references. |
| `EVALS_SANDBOX_ID` | no | Default sandbox for commands that omit `--sandbox`. |
| `AGENTS_BASE_URL` | setup, chat, transcript, records | Agents product origin. |
| `AGENTS_ORIGIN` | no | Request `Origin`. Defaults to the origin of `AGENTS_BASE_URL`. |
| `AGENTS_ORGANIZATION_ID` | setup, chat, transcript, records | Agents workspace id. |
| `AGENTS_OWNER_SESSION` | setup, chat, transcript, records | Normal owner session token. |
| `AGENTS_SESSION_COOKIE_NAME` | no | Cookie name. Default `agents_session`. |
| `AGENTS_MODEL_API_KEY` | setup when the file omits it | Model provider key. |
| `AGENTS_MEMBER_SESSION` | no | Optional second-member session used by setup. |

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

Optional fields: `product` (`agents` or `growth`), `codeRevision`, `imageDigest`,
`schemaVersion`, `migrationChecksum`, `configDigest`, `runtimeVersion`,
`modelRoutesDigest`, `adapterVersions`, and an initial `workspaceRef`.

The service computes every missing manifest field. It refuses to create a sandbox
if a required field is incomplete or invalid.

Without `provision: true`, this creates a control-plane record only. The Evals UI uses
the provisioning path:

```sh
curl -sS http://127.0.0.1:4600/v1/sandboxes \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "product":"agents",
    "provision":true,
    "profile":"local",
    "workspaceName":"Acme support",
    "label":"Support experiments"
  }'
```

The response is `202` with status `provisioning`. Poll
`GET /v1/sandboxes/:id` until status is `ready` or `failed`. Each result includes
ordered `provisioningSteps` and, when ready, the local `runtime` metadata.

For `product: "growth"`, the request creates a Growth sandbox and a paired
Agents runtime sandbox. The Growth runtime uses the signed Growth → Agents
service keys and records the pair in `GET /v1/sandboxes/:id`.

The local provisioner currently:

1. Creates `agents_sandbox_<id>` on the local PostgreSQL server.
2. Applies the Agents schema through the product-owned setup command.
3. Creates a dedicated object-storage bucket.
4. Starts a dedicated Agents API and worker with its own ports, detached from the
   control-plane process.
5. Registers the worker with the local Restate deployment.
6. Bootstraps an owner and workspace through the product-owned
   `bootstrap-sandbox` command.
7. Calls `POST /internal/sandbox/entitlement` to attach
   `agents-sandbox-unlimited` and records the billing account, subscription, plan
   key and version in the sandbox runtime.
8. Writes a local owner session file under `.audit/sandboxes/<sandbox-id>/`
   with mode `0600`; the token is not stored in the control plane.

For a Growth pair it then:

1. Creates `growth_sandbox_<id>` and applies the Growth Prisma migrations.
2. Starts a dedicated Growth API with its own port.
3. Bootstraps the Growth owner, business organization, BusinessProfile and a
   local owner session through `src/bootstrap-sandbox.ts`.
4. Attaches `growth-sandbox-unlimited` to the Growth account and
   `agents-sandbox-unlimited` to the paired Agents account.
5. Starts the `growth-agent-setup-worker` against the paired Agents API.
6. Waits for Growth agent setup to reach `ready` and records the Growth
   business workspace on the paired Agents sandbox.
7. Records the Growth/Agents pair, billing metadata and both session files.

Local provisioning requires the product environment files, PostgreSQL access to
create databases, Growth Prisma migration privileges, MinIO/S3 credentials, a
running Restate admin endpoint, Docker socket access to discover the bridge
gateway, the product `tsx` loaders, and a non-production billing service with
sandbox plans seeded and `BILLING_SANDBOX_SECRET` configured. Growth pairing also requires the existing
signed Growth/Agents keys and managed model profile. It is a development/local
provisioner, not the Phase 5 hosted lifecycle. Growth web, non-agent Growth
workers, hosted lifecycle and retention are not implemented yet.

### List and inspect

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes?limit=50" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"

curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

### Delete

Deleting a sandbox stops its recorded API and worker processes, drops its product
database, removes its local files, and retires the control-plane record. Deleting
either side of a Growth/Agents pair deletes both sandboxes.

```sh
curl -sS -X DELETE "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

Bulk deletion requires an explicit confirmation body:

```sh
curl -sS -X DELETE "http://127.0.0.1:4600/v1/sandboxes" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"confirm":"DELETE"}'
```

The registry record and its session/outcome references remain retired for audit;
the runtime resources and product database are removed. Central-billing sandbox
accounts and zero-priced subscriptions are retained. Object-storage bucket deletion
is best effort because a non-empty bucket may require manual cleanup.
Provisioning sandboxes cannot be deleted until their current step fails or
finishes.

### Restart a runtime

Local sandbox processes can be stopped by a desktop or host restart. The runtime
restart endpoint starts the recorded Agents API and worker again and re-registers the
worker with Restate. For a Growth sandbox it restarts the paired Agents runtime.

```sh
curl -sS -X POST "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/runtime/restart" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

The Evals client exposes the same action as **Restart runtime** on the sandbox detail
page and on the chat error state. The service also checks ready sandboxes every 10
seconds and restarts a stopped local runtime automatically. If the Growth runtime is
unavailable, the Agents tab returns a clear error instead of an empty list.

### Agent setup profiles

Agent setup profiles make sandbox agent configuration repeatable. A profile targets
either the existing platform Assistant or a new business agent, and is applied
through normal Agents APIs.

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/agent-profiles" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"

curl -sS -X POST "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/agent-profiles" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "workspaceRefId":"<workspace-ref>",
    "spec":{
      "targetType":"business_agent",
      "agentName":"Customer support",
      "instructions":"Answer from approved knowledge only.",
      "knowledge":{"title":"Support policy","content":"..."},
      "responsibilities":["answer-questions","customer-support"]
    }
  }'

curl -sS -X POST "http://127.0.0.1:4600/v1/agent-profiles/$PROFILE_ID/apply" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"idempotencyKey":"setup-one"}'
```

Applying a profile creates an immutable profile version, configures/publishes the
agent, reads it back, and records the agent reference. A new version can be created
with `POST /v1/agent-profiles/:id/versions`. The first tool capability uses the
product's built-in knowledge and handoff tools. External calendar credentials are
not copied into the sandbox; a calendar connection fixture remains a separate
provider-integration step.

### Sandbox sync

`POST /v1/sandboxes/:id/sync` applies current product migrations, force-restarts the
runtime, runs smoke checks and records a new immutable sandbox version. Active
conversations block the update. For Growth it updates both the Growth runtime and
the paired Agents runtime. The client exposes this as **Update sandbox**.

```sh
curl -sS -X POST "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/sync" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"confirm":"UPDATE"}'
```

### Product agents and chat

The service reads the product workspace through the normal product API and registers
each available agent as an immutable control-plane reference. Growth returns its
default agents (`Growth assistant`, `Research`, `Content`, `Campaigns`). Agents
returns the workspace agents, including the platform Assistant.

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/product-agents" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

Start or continue a conversation through the product API:

```sh
curl -sS -X POST "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/chat" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"agentRefId":"<agent-ref>","message":"Hello"}'
```

Include `sessionId` to continue an existing conversation. The service records the
product task and digests in the control plane. Read the full product transcript with:

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/sessions/$SESSION_ID/messages" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

The client uses these routes for its Agents tab and chat page.

Growth model selection is feature-level and applies to new messages, matching the
Growth product. The sandbox provisioning expands the Growth model grant to the full
local provider catalogue, so the chat model picker is not limited to the single
managed default.

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/agents/$AGENT_REF_ID/models" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"

curl -sS -X POST "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/agents/$AGENT_REF_ID/model" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"connection","connectionId":"<connection>","modelId":"<model>"}'
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

### Record and read outcome references

An outcome reference links a submitted product outcome to the exact sandbox,
workspace, agent version and task. It is independent of the task transcript.

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/outcomes" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "workspaceRefId":"<workspace-ref-id>",
    "agentRefId":"<agent-ref-id>",
    "kind":"enquiry",
    "productOutcomeId":"<enquiry-id>",
    "productRecordId":"<customer-record-id>",
    "status":"submitted",
    "taskId":"<task-id>",
    "requestDigest":"<64-hex>",
    "responseDigest":"<64-hex>"
  }'

curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/outcomes" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

`GET /v1/sandboxes/:id/outcomes/:outcomeRefId` reads one reference. A duplicate
sandbox/kind/product outcome returns `409 OUTCOME_REF_EXISTS`. The reference
must belong to the same sandbox, workspace and agent reference.

### Record and read interactive sessions

An interactive session links one product conversation to the sandbox, workspace and
agent reference. Each turn links the product task and stores only input/output
digests and state. Transcript text stays in the product.

```sh
curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/sessions" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "workspaceRefId":"<workspace-ref-id>",
    "agentRefId":"<agent-ref-id>",
    "productConversationId":"<conversation-id>",
    "productTaskId":"<first-task-id>",
    "inputDigest":"<64-hex>",
    "outputDigest":"<64-hex>",
    "state":"completed"
  }'

curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/sessions/$SESSION_ID/turns" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "productTaskId":"<second-task-id>",
    "inputDigest":"<64-hex>",
    "outputDigest":"<64-hex>",
    "state":"completed"
  }'

curl -sS "http://127.0.0.1:4600/v1/sandboxes/$SANDBOX_ID/sessions" \
  -H "authorization: Bearer $EVALS_OPERATOR_TOKEN"
```

`GET /v1/sandboxes/:id/sessions/:sessionId` returns the session and ordered turns.
Session creation is idempotent by product conversation. Turn creation is idempotent
by product task; a different input digest returns `409 TURN_CONFLICT`.

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

## Interactive terminal client

The client drives the product through normal HTTP APIs and records session and turn
references in the control plane.

```sh
pnpm --filter @kasitek/evals-service client view --sandbox "$SANDBOX_ID"
pnpm --filter @kasitek/evals-service client setup --sandbox "$SANDBOX_ID" --file setup.json
pnpm --filter @kasitek/evals-service client chat --sandbox "$SANDBOX_ID" --agent-ref "$AGENT_REF" --message "What are the opening hours?"
pnpm --filter @kasitek/evals-service client chat --sandbox "$SANDBOX_ID" --session "$SESSION_ID" --message "Can you repeat that?"
pnpm --filter @kasitek/evals-service client transcript --sandbox "$SANDBOX_ID" "$SESSION_ID"
pnpm --filter @kasitek/evals-service client records --sandbox "$SANDBOX_ID" --outcome "$OUTCOME_REF"
```

Add `--json` for machine-readable output. `view` shows the sandbox version,
workspaces, agent references, sessions and saved outcomes. `transcript` shows both
sides of each turn, operations and tool calls, task events and evidence citations.
`records` reads the saved enquiry and projected customer record through staff APIs.

The setup file contains product configuration, not credentials:

```json
{
  "model": {
    "providerId": "openrouter",
    "name": "Sandbox model",
    "modelId": "nvidia/nemotron-3-super-120b-a12b:free"
  },
  "knowledge": {
    "title": "Opening hours",
    "content": "The office opens at nine.",
    "visibility": "private"
  },
  "agent": {
    "name": "Interactive fixture",
    "configuration": {},
    "instructions": "Answer using approved knowledge."
  },
  "member": { "email": "member@example.test" }
}
```

Pass the model key in `AGENTS_MODEL_API_KEY` and any member session in
`AGENTS_MEMBER_SESSION`. `setup` reuses an existing model connection, knowledge
source and member, publishes an immutable agent version only when it creates a new
agent, and records the agent reference in the control plane.

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

For interactive use, build the service first so `services/evals/dist/cli.js`
exists, then run the same fixture with `AGENTS_EVAL_OUTCOME=interactive` and a
distinct `AGENTS_EVAL_INTERACTIVE_AGENT_NAME`. The fixture configures the
agent through the terminal client, sends two turns in one conversation, records the
session and turns, reads the transcript and saved outcome, and runs the client's
`transcript`, `view` and `records` commands. A second run writes
`interactive-restart.json` after reading the same session and outcome without
creating another task. Evidence is written under the sandbox directory as
`interactive-session.json`, `interactive-restart.json`, `cli-transcript*.json`,
`cli-view*.json` and `cli-records*.json`.

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
They cover sandbox, workspace, agent, outcome, interactive session/turn and
provisioning-state references. Guard and manifest tests do not need a database.

## Release impact

- Documentation: this README and the root architecture map. No Agents user-facing
  route or feature-map entry changes.
- Analytics: not applicable to the local harness.
- Logging: structured session and turn references; authorization redacted and
  transcript text never stored in the control plane.
- Versioning: service package, additive control-plane migrations and sandbox
  version manifest.
- Validation: typecheck, build, service tests, boundary check, a two-turn
  create/restart interactive run and a UI-created local sandbox.
- Rollout: local and development only; no production deployment.
- Rollback: stop the client and service. Product data, prior session references
  and outcome references remain readable.
- Migration: additive `evals` control-plane schema only; no product data
  migration. Each local sandbox creates a fresh product database.
