# Application API

The application API lets an external product create, publish and run Agents agents without a
workspace user session. It is documented here for HTTP. The equivalent MCP surface and its
OAuth scopes are in [mcp-integration.md](mcp-integration.md).

## Enrollment

An authorized workspace owner completes these steps once per external product:

1. Create an **application** with the agents it may use and its scopes:
   `POST /api/organizations/:organizationId/applications` with
   `{ "name": "...", "agentIds": ["<uuid>"], "scopes": ["agents:read", "agents:manage",
   "agents:publish", "runs:start", "runs:read", "runs:control"] }`.
   The response contains the application and one credential secret. Only the secret hash is
   stored.
2. Assign the agents the application may manage or call with
   `PUT /api/organizations/:organizationId/applications/:applicationId/agents` and
   `{ "agentIds": ["<uuid>"] }`. An empty list removes every assignment.
3. Give the credential secret to the external product over a secure channel. The external
   product sends it as `Authorization: Bearer <secret>` and never needs a workspace cookie,
   origin header or MCP session.

Rotate with `POST .../applications/:applicationId/credentials` and revoke the old credential
with `POST .../credentials/:credentialId/revoke`. Revoke the application itself with
`POST .../applications/:applicationId/revoke`. Revocation stops access and in-flight work.

## Credential scopes

| Scope | Operations |
| --- | --- |
| `agents:read` | list and inspect assigned agents, conversations and runs |
| `agents:manage` | create, edit, preview and configure agents |
| `agents:publish` | publish immutable versions and bind website deployments |
| `connections:manage` | manage application-scoped connection sharing (separate from agent execution) |
| `runs:start` | start runs and create conversations |
| `runs:read` | read run state, activity, results, pending decisions and conversations |
| `runs:control` | queue instructions and request cancellation |
| `reviews:decide` | decide a pending tool review for the application's own run |

A credential may hold several scopes. Every endpoint checks the one operation it needs; a
credential without it receives `403 ACCESS_DENIED`.

## Management and publication

| Operation | Request | Response |
| --- | --- | --- |
| Create agent | `POST /v1/agents` `{ name, purpose?, instructions?, operationId }` | `201 { agent: { id, name } }` |
| Inspect agent | `GET /v1/agents/:agentId` | `{ agent: { id, name, version: { id, number, createdAt } } }` |
| Edit draft | `PATCH /v1/agents/:agentId` `{ name?, configuration, expectedRevision }` | `{ agent: { id, name, draftRevision } }` |
| Preview | `POST /v1/agents/:agentId/preview` `{ configuration }` | `{ ready, errors: [{ code, message }] }` |
| Publish | `POST /v1/agents/:agentId/versions` `{ expectedRevision }` | `201 { version: { id, number, createdAt } }` |
| Bind deployment | `POST /v1/agents/:agentId/deployments` `{ versionId?, allowedOrigins }` | `201 { deployment: { id, versionId, allowedOrigins, publishedAt } }` |
| Create conversation | `POST /v1/conversations` `{ agentId }` | `201 { conversation: { id, agentId } }` |
| Read conversation | `GET /v1/conversations/:conversationId` | `{ conversation, tasks: [{ taskId, state, createdAt }] }` |

Publication validates the selected model, tools, knowledge, memory and workflow assignments and
pins the published digest. `configuration` is the same structure returned by a workspace agent
draft; a minimal generic template ships in
[`examples/independent-client/generic-agent.json`](../examples/independent-client/generic-agent.json).

## Runs and activity

| Operation | Request | Response |
| --- | --- | --- |
| Start run | `POST /v1/runs` `{ agentId, message, requestId, conversationId?, assertion? }` | `202 { taskId, conversationId, state, replayed }` |
| Read run | `GET /v1/runs/:taskId` | run state, public activity, output availability and result |
| Activity stream | `GET /v1/runs/:taskId/events` | server-sent snapshots |
| Pending decisions | `GET /v1/runs/:taskId/pending` | `{ taskId, state, pending: [{ reviewId, state, expiresAt }] }` |
| Steer | `POST /v1/runs/:taskId/instructions` `{ instruction, requestKey }` | accepted or replayed instruction |
| Cancel | `POST /v1/runs/:taskId/cancel` | `{ taskId, accepted }` |

Runs are bound to the application principal and the starting credential. The application sees
only its own runs for currently assigned agents. Removing an agent stops access to existing
runs for that agent.

## Entitlement

API access is bounded by workspace membership, the credential's scopes and the application's
current agent assignments. Plan entitlements gate agent features such as human handoff and
analytics at publication and admission; an application cannot bypass them. Application API
access itself is not a separately plan-gated feature today. The selling points, if any, must
still be enforced by the workspace plan before this statement changes.

## Idempotency

| Field | Where | Behavior |
| --- | --- | --- |
| `operationId` | agent create, key registration | Repeating it returns the same result; a changed body under the same id returns `409 IDEMPOTENCY_CONFLICT` |
| `requestId` | `POST /v1/runs` | Repeating it returns `replayed: true` and the same task; a different body returns `409 IDEMPOTENCY_CONFLICT` |
| `requestKey` | run instructions | Repeating it replays the accepted instruction |
| `expectedRevision` | draft edit, publish | A stale revision returns `409 DRAFT_CONFLICT`; retry only after re-reading |
| Credential rotation | `POST .../credentials` | Old credentials stop working; new credentials continue application-owned conversations |

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_CREDENTIAL` | 401 | Missing, malformed or revoked bearer credential |
| `ACCESS_DENIED` | 403 | The credential lacks the scope or the agent is unassigned |
| `NOT_FOUND` | 404 | The agent, conversation or run is not visible to this application |
| `INVALID_ASSERTION` | 401 | Delegated assertion is malformed, expired or has a bad signature |
| `ASSERTION_SCOPE_DENIED` | 403 | Assertion names another application, workspace or audience |
| `CONFIGURATION_INVALID` | 400 | Bindings or capability prerequisites are unavailable |
| `CONFIGURATION_CONFIRMATION_REQUIRED` | 409 | The change expands permissions; request a workspace review |
| `IDEMPOTENCY_CONFLICT` | 409 | The request key was already used with different content |
| `DRAFT_CONFLICT` | 409 | `expectedRevision` is stale |
| `TOOL_ARGUMENTS_INVALID` | 400 | A tool call or request body does not match its contract |

Errors include `{ error: { code, message } }`. Retry `5xx` and network failures with the same
idempotency key; do not retry `4xx` without changing the request.

## Event replay

`GET /v1/runs/:taskId/events` writes the current authorized snapshot immediately and then a
new snapshot when its public state changes. Reconnect with the same bearer credential to get
the latest snapshot; there is no cursor and no replay of every intermediate change. The stream
closes when the run settles or access is revoked. Use `GET /v1/runs/:taskId` for a one-shot
read and `GET .../pending` to discover decisions that need attention.

## Delegated users

An application can act for one of its own end users without giving that user a workspace
account. Register an Ed25519 public key with
`POST /api/organizations/:organizationId/applications/:applicationId/keys` and
`{ "operationId": "<uuid>", "publicKey": "<SPKI PEM>" }`. Revoke it at
`POST .../applications/:applicationId/keys/:keyId/revoke`. The private key stays with the
application.

Sign a payload containing `applicationId`, `organizationId`, `subject`, `audience`, `issuedAt`
and `expiresAt`, encode it as base64url, sign the encoded string, and send
`<encoded>.<signature>` as `assertion` on `POST /v1/runs`. The assertion must match the calling
application and workspace, name this platform as its audience, and live at most five minutes.
The run keeps the application as its principal and records the subject in
`application_delegations` for attribution. The assertion grants no workspace membership and no
additional tool, agent or connection access.

## Complete example

```sh
BASE=https://agents.example
TOKEN=kat_...
ORG=<organization uuid>

# Owner: create the application and credential (done once; cookie-authenticated).
curl -sS -X POST "$BASE/api/organizations/$ORG/applications" \
  -H 'content-type: application/json' -H "origin: $BASE" -b "agents_session=$SESSION" \
  -d '{"name":"Partner","agentIds":["<seed agent>"],"scopes":["agents:read","agents:manage","agents:publish","runs:start","runs:read"]}'

# External product: create, configure and publish a generic agent.
AGENT=$(curl -sS -X POST "$BASE/v1/agents" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Partner agent","purpose":"Answer partner questions.","operationId":"'$(uuidgen)'"}')
AGENT_ID=$(echo "$AGENT" | jq -r .agent.id)
CONFIG=$(cat examples/independent-client/generic-agent.json)
curl -sS -X PATCH "$BASE/v1/agents/$AGENT_ID" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"configuration\":$CONFIG,\"expectedRevision\":1}"
VERSION=$(curl -sS -X POST "$BASE/v1/agents/$AGENT_ID/versions" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"expectedRevision":2}')
VERSION_ID=$(echo "$VERSION" | jq -r .version.id)
curl -sS -X POST "$BASE/v1/agents/$AGENT_ID/deployments" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"versionId\":\"$VERSION_ID\",\"allowedOrigins\":[\"https://partner.example\"]}"

# External product: invoke and read the result.
RUN=$(curl -sS -X POST "$BASE/v1/runs" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\",\"message\":\"Hello\",\"requestId\":\"$(uuidgen)\"}")
TASK_ID=$(echo "$RUN" | jq -r .taskId)
curl -sS "$BASE/v1/runs/$TASK_ID" -H "authorization: Bearer $TOKEN"
curl -sS "$BASE/v1/runs/$TASK_ID/pending" -H "authorization: Bearer $TOKEN"
curl -N "$BASE/v1/runs/$TASK_ID/events" -H "authorization: Bearer $TOKEN"
```

MCP OAuth permissions are separate from application credentials; see
[mcp-integration.md](mcp-integration.md). Connection sharing for applications is in
[application-connections.md](application-connections.md).
