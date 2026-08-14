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

The versioned capability catalog, including permission scopes, resource selectors, audit
classification, redaction metadata, and JSON Schemas, is generated at
[`docs/generated-capabilities.md`](generated-capabilities.md). Discovery responses are projections
of the same registry, so a capability is not separately redefined for MCP or the Agent UI.

### Key-bound exchange

For agents that should not transmit the copy-once secret on every bootstrap, register a P-256
SPKI public key with the credential (`clientKeyId` and `clientPublicKey`). The key id is unique
among active credentials for an installation. The agent keeps the matching private key and signs a
compact ES256 JWT for each exchange:

```json
{
  "iss": "codex-prod-1",
  "sub": "<credential-id>",
  "aud": "kasitek-agents-token",
  "iat": 1730000000,
  "exp": 1730000120,
  "jti": "<new-random-id>"
}
```

Use `POST /v1/installation-tokens/exchange` with
`{ "clientAssertion": "<header>.<payload>.<signature>", "audience": "mcp" }` (or
`kasitek-public-api`). Assertions use the registered `kid`, expire within five minutes, and each
`jti` is consumed once in the Agent database. The legacy secret exchange remains available for
initial enrollment and key recovery; never send the private key to KasiTek.

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

Clients that only support local stdio can use `pnpm run start:stdio` with `MCP_STDIO_TOKEN` set to an
exchanged MCP installation token. The bridge forwards one JSON-RPC message per input line to the
hosted endpoint, preserves notification silence, and bounds both request and response size. It is a
transport proxy only; authentication, discovery, policy, and durable state remain at the gateway and
Agent API.

## Safety and inspection

Capability policy is evaluated at discovery, invocation, approval, and execution boundaries. The
gateway never receives provider credentials. Inspect a durable operation through the Agent API
`GET /v1/installations/:installationId/operations/:runId` and its paginated events route. The
authenticated Agents activity UI provides the same organization-scoped timeline, approval state,
effect receipt, reconciliation, cancellation, and external-event controls.
