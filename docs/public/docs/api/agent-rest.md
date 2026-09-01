# Agent installation REST API (advanced compatibility)

For the product-level choice between KasiAi, hosted user agents, and external runtimes, see the
[agent connection guide](./agent-connection-guide.md).

The normal Developers flow uses one workspace Developer API key for Core REST and MCP. This
document describes the lower-level installation-scoped Agent Platform REST surface for advanced
or legacy runtimes. It uses the
same tool registry, installation grants, durable run records, Temporal workflow, approval policy, and
event timeline as the MCP transport.

## Authentication

1. Create a dedicated external-connected installation with `POST /v1/external-agents`. Supply the
   runtime, protocols, initial capabilities, and optional resource/connector constraints. The
   response contains a copy-once secret with read/write transport access.
2. Review or narrow the installation's grants from its control-plane details.
3. Exchange the one-time credential secret at `POST /v1/installation-tokens/exchange` with
   `{ "audience": "kasitek-public-api" }`.
4. Send the returned short-lived bearer token to the endpoints below.

The external creation flow does not accept or discover a KasiAi or hosted-agent installation ID.
Credentials on those modes are rejected by the Agent API.

Credentials are independently revocable and carry both `api:read` and `api:write` transport scopes.
Read tools, drafts, writes, and external effects are still constrained by the installation's tool
grants, resource scopes, availability, and approval policy.

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

## Workspace media

Content tools identify workspace media with stable `assetId` values. If the installation has the
`content.read` grant, it can call these read-only capabilities:

- `kasitek.core.content_media_get` returns organization-scoped metadata and processing/scan state.
- `kasitek.core.content_media_preview` returns the same metadata and a short-lived preview URL.

Do not persist preview URLs. A hosted agent response uses the versioned shape below; the Agent
Platform and each channel gateway resolve the asset at delivery time.

```json
{
  "version": "1",
  "text": "Here is the image.",
  "media": [
    {
      "assetId": "core-asset-id",
      "kind": "image",
      "fileName": "announcement.png",
      "altText": "Payment announcement",
      "disposition": "inline"
    }
  ]
}
```

The durable contract contains no provider URL or file bytes. Unsupported provider media is
delivered through the gateway's documented text/link fallback.

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

## Delete memory or knowledge

`DELETE /v1/memory/{memoryId}` and `DELETE /v1/knowledge/sources/{sourceId}` are permanent within
the authenticated organization and requested scope. Memory deletion removes the stored memory,
its embedding and search representation, and any conversation summary derived from that memory.
Knowledge-source deletion removes the source and all of its chunks. The deletion is rejected while
an applicable legal hold is active. The deletion ledger keeps only the target type, target ID,
organization, requester, and completion state; it does not preserve the deleted content.

## Review memory

Organization users can review an imported or inferred memory candidate after inspecting its
content and provenance:

```http
POST /v1/memory/{memoryId}/review
Authorization: Bearer <organization-session>
Content-Type: application/json
```

```json
{
  "agentId": "agent-uuid",
  "installationId": "installation-uuid",
  "decision": "approve"
}
```

`decision` is `approve` or `reject`. Candidates are not returned by runtime retrieval while they
are `review_pending` or `quarantined`. Approval changes the status to `active`; rejection changes
it to `rejected`. Scope fields are required to prevent reviewing a record belonging to another
agent or installation. Review actions are audited.

MCP clients use the equivalent `/mcp` JSON-RPC methods. Both transports intentionally converge on the
same `agent_runs`, approval, tool invocation, receipt, and event records.
