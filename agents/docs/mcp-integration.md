# KasiTek MCP integration

The hosted MCP gateway is a stateless transport adapter. It does not own installation state,
grants, approvals, or run records; those remain in the Agent API.

MCP credentials belong only to an `external_connected` installation created through
`POST /v1/external-agents`. KasiAi (`system_hosted`) and KasiTek-hosted user agents
(`kasitek_hosted`) do not receive MCP credentials; their channels and hosted runtime controls stay
on their own installation details.

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

The management UI can preflight the same projection with `GET /v1/external-agents/catalog` before
creating an installation. It reports registry lifecycle, subscription entitlement, provider
readiness, feature policy, approval requirement, and the final `reasonCode`. If the owning product
source has not supplied entitlement or provider state, those fields are `unknown`; clients must not
interpret an unknown dependency as a product guarantee.

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

The gateway is dual-era during migration. The 2026 stateless path uses protocol revision
`2026-07-28`; the pre-2026 compatibility path currently supports `2025-06-18` and its
`initialize` handshake. Both use the same `/mcp` POST endpoint, installation token, filtered
capability registry, shared invocation service, approvals, idempotency, and durable run state.
The 2026 path is rollout-controlled: `MCP_STATELESS_ENABLED` gates the Agent API and
`MCP_GATEWAY_STATELESS_ENABLED` gates the gateway. They default on in development/test and off in
production. When disabled, a 2026 request receives `-32022` with `supported: ["2025-06-18"]`,
while pre-2026 `initialize` and subsequent compatibility calls continue to work.

### 2026 stateless path

The 2026 path has no `initialize`/`initialized` handshake and no protocol session. Every request
carries the protocol version, client capabilities, and optional client identity in
`params._meta`. HTTP clients must also send `MCP-Protocol-Version`, `Mcp-Method`, and `Accept:
application/json, text/event-stream`; `Mcp-Name` is required for named methods such as
`tools/call`. The gateway and Agent API validate that mirrored headers match the JSON body.
`Mcp-Param-*` is reserved for explicitly declared, non-sensitive `x-mcp-header` tool fields. The
current capability registry declares no such fields; transport adapters still reject control
characters and names that indicate credentials, tokens, secrets, cookies, or private keys.

```http
POST /mcp HTTP/1.1
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: platform.current_time
Accept: application/json, text/event-stream
Authorization: Bearer <installation-token>
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "example-agent", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    },
    "name": "platform.current_time",
    "arguments": {},
    "idempotencyKey": "client-generated-key"
  }
}
```

`server/discover` returns supported protocol revisions, capabilities, server identity, private
cache metadata, and instructions. `tools/list` is installation-filtered, deterministically ordered,
and excludes capabilities that are not effectively available. Each returned tool carries a private
`kasitek/effectiveAccess` decision with a stable reason code. Ordinary results include
`resultType: "complete"` and server
identity metadata. The gateway advertises the `io.modelcontextprotocol/tasks` extension. A client
that opts into Tasks receives a durable task handle for non-immediate calls and can use
`tasks/get`, `tasks/cancel`, and `tasks/update`; clients that do not opt in retain the structured
KasiTek operation result and `tools/status` reference. MRTR input requests are not advertised yet;
approval and human waits remain represented by the durable run state until that extension is added.

Modern Streamable HTTP does not use standalone GET streams, `Mcp-Session-Id`, `Last-Event-ID`, or
`notifications/cancelled` for HTTP cancellation. Closing an in-flight response is the cancellation
signal; the gateway propagates that disconnect upstream. `GET /mcp` and `DELETE /mcp` therefore
return `405`. Long-lived change notifications require `subscriptions/listen` and are not advertised
until enabled.

### Pre-2026 compatibility path

Existing clients may continue using the initialize-based contract:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }
```

The compatibility path continues to support `tools/list`, `tools/call`, `tools/status`, and the
existing notification/cancellation behavior. It is intentionally retained while clients migrate;
it must not be removed based only on local tests.

The 2026 path exposes `server/discover`; the compatibility path uses `tools/list`. Both only return
capabilities granted to the installation and available in the current environment. Calls use
`tools/call` with the manifest name, validated arguments, and an idempotency key:

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
Agent API. It selects the 2026 HTTP revision when a stdio message carries 2026 `_meta`. Before
forwarding an older message, it probes `server/discover` once (disable with `MCP_STDIO_PROBE=false`)
and retains the pre-2026 header/initialize flow when compatibility is available; a modern-only
endpoint returns a local unsupported-version error rather than sending an incompatible handshake.

## Safety and inspection

Capability policy is evaluated at discovery, invocation, approval, and execution boundaries. The
gateway never receives provider credentials. Inspect a durable operation through the Agent API
`GET /v1/installations/:installationId/operations/:runId` and its paginated events route. The
authenticated Agents activity UI provides the same organization-scoped timeline, approval state,
effect receipt, reconciliation, cancellation, and external-event controls.
