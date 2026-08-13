# KasiTek MCP integration

The hosted MCP gateway is a stateless transport adapter. It does not own installation state,
grants, approvals, or run records; those remain in the Agent API.

## Authentication

1. Create an installation credential from the authenticated Agents UI or the internal Agent API.
2. Exchange the copy-once secret at `POST /v1/installation-tokens/exchange` with
   `{ "secret": "…", "audience": "mcp" }`.
3. Send the returned short-lived `accessToken` as `Authorization: Bearer …` to the gateway.

The gateway rejects invalid, expired, revoked, suspended, wrong-audience, and cross-installation
tokens. MCP and REST credential scopes are independent; `mcp:read` is required for discovery and
`mcp:write` is required for tool calls.

## Streamable HTTP lifecycle

The current protocol revision is `2025-06-18`. The gateway accepts JSON-RPC POST requests at
`/mcp` and returns JSON responses. GET streaming and resumable session behavior are intentionally
not advertised. Every request must include `mcp-protocol-version: 2025-06-18`.

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }
```

Discovery uses `tools/list` and only returns capabilities granted to the installation and available
in the current environment. Calls use `tools/call` with the manifest name, validated arguments,
and an idempotency key:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "platform.current_time",
    "arguments": {},
    "idempotencyKey": "client-generated-key"
  }
}
```

The structured result includes a durable `runId` and status. Reusing an idempotency key returns the
original operation rather than starting a second effect. Approval-required and durable capabilities
continue through Temporal; immediate read manifests may use the explicit local fallback while
still recording run, tool, audit, and usage evidence.

## Safety and inspection

Capability policy is evaluated at discovery, invocation, approval, and execution boundaries. The
gateway never receives provider credentials. Inspect a durable operation through the Agent API
`GET /v1/installations/:installationId/operations/:runId` and its paginated events route. The
authenticated Agents activity UI provides the same organization-scoped timeline, approval state,
effect receipt, reconciliation, cancellation, and external-event controls.
