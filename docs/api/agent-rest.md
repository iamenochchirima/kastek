# Agent installation REST API

For the product-level choice between KasiAi, hosted user agents, and external runtimes, see the
[agent connection guide](./agent-connection-guide.md).

The public agent REST surface is an installation-scoped transport for external agents. It uses the
same tool registry, installation grants, durable run records, Temporal workflow, approval policy, and
event timeline as the MCP transport.

## Authentication

1. Create a dedicated external-connected installation with `POST /v1/external-agents`. Supply the
   runtime, protocols, initial capabilities, optional resource/connector constraints, and desired
   credential scopes. The response contains a copy-once secret.
2. Review or narrow the installation's grants from its control-plane details.
3. Exchange the one-time credential secret at `POST /v1/installation-tokens/exchange` with
   `{ "audience": "kasitek-public-api" }`.
4. Send the returned short-lived bearer token to the endpoints below.

The external creation flow does not accept or discover a KasiAi or hosted-agent installation ID.
Credentials on those modes are rejected by the Agent API.

Credentials are independently revocable and carry `api:read` and/or `api:write` scopes. Read tools
require `api:read`; drafts, writes, and external effects require `api:write`. Both are constrained by
the installation's tool grants and the tool's approval policy.

Management sessions can list and inspect external identities with `GET /v1/external-agents` and
`GET /v1/external-agents/{installationId}`. The detail response includes grants, credential status,
and connection health; `/health` is a smaller health-only projection. `DELETE
/v1/external-agents/{installationId}` archives the external identity and revokes its active
credentials atomically. These management routes use the browser/internal organization session, not
the external bearer token.

## Discover granted tools

```http
GET /v1/installations/{installationId}/tools
Authorization: Bearer <installation-token>
```

The response contains only tools granted to that installation, including their versions, JSON input
and output schemas, risk class, approval requirement, and capability metadata. The endpoint is safe
to call with a read-only API credential. Each tool also exposes an effective-access decision with a
stable reason code such as `available`, `approval_required`, `provider_not_configured`, or
`credential_denied`.

## Invoke a tool

```http
POST /v1/installations/{installationId}/tools/call
Authorization: Bearer <installation-token>
Content-Type: application/json
```

```json
{
  "name": "platform.current_time",
  "arguments": {},
  "idempotencyKey": "client-operation-123",
  "toolCallId": "optional-client-call-id"
}
```

The response is `202 Accepted` and contains an `operationId`/`runId`. The request is accepted only
after authentication, installation isolation, tool grants, and durable execution availability have
been checked. Repeating the same idempotency key for the same credential returns the original run.

## Inspect an operation

```http
GET /v1/installations/{installationId}/operations/{runId}
Authorization: Bearer <installation-token>
```

The response contains the organization-scoped run record and its ordered event timeline. A run from
another installation is intentionally indistinguishable from a missing operation (`404`).

For polling clients, use `GET /v1/installations/{installationId}/operations/{runId}/events?after=42`.
The response includes `nextAfter`, the current status, a terminal flag, and only redacted public
event fields. Persist the cursor and resume from it after reconnecting.

## Cancel an operation

```http
POST /v1/installations/{installationId}/operations/{runId}/cancel
Authorization: Bearer <installation-token>
Content-Type: application/json
```

```json
{ "reason": "stopped by the agent" }
```

Cancellation is a durable workflow signal. It does not mutate an in-memory queue and is safe to
repeat for terminal operations.

MCP clients use the equivalent `/mcp` JSON-RPC methods. Both transports intentionally converge on the
same `agent_runs`, approval, tool invocation, receipt, and event records.
