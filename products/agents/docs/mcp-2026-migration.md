# MCP 2026 migration note

KasiTek now has a dual-era `/mcp` endpoint. The 2026 stateless path uses MCP revision
`2026-07-28` and per-request metadata; the pre-2026 compatibility path keeps the existing
`2025-06-18` `initialize` flow. Both paths use the same installation authentication, filtered
capability registry, invocation service, approval boundary, idempotency, audit, and durable run
state.

The authenticated installation is always the dedicated `external_connected` identity created for
the customer-operated runtime. The stateless transport does not turn KasiAi or a KasiTek-hosted
user agent into an external client and cannot be used with credentials attached to those modes.

## Client changes

For the 2026 path, send `params._meta` on every request with:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

HTTP clients must mirror the request with `MCP-Protocol-Version`, `Mcp-Method`, and
`Accept: application/json, text/event-stream`. `Mcp-Name` is required for named calls such as
`tools/call`. Do not send `initialize`, `Mcp-Session-Id`, `Last-Event-ID`, or standalone `GET /mcp`
for the stateless path.

`server/discover` returns the supported revisions, filtered server capabilities, result metadata,
and cache hints. `tools/list` is deterministic and installation-private; tools that are not
effectively available are omitted and their reason codes remain visible in management discovery.
Ordinary results include
`resultType: "complete"`; clients that advertise `io.modelcontextprotocol/tasks` receive a durable
task handle for non-immediate work and can poll/cancel it with `tasks/get` and `tasks/cancel`.
Approval and human waits remain durable run state. MRTR input requests are not advertised yet.

## Rollout and rollback

The API flag is `MCP_STATELESS_ENABLED`; the gateway flag is
`MCP_GATEWAY_STATELESS_ENABLED`. They default to `true` in development/test and `false` in
production. Enabling the path in production requires local conformance and staging smoke evidence.
Turning either flag off returns `-32022` with `supported: ["2025-06-18"]` for 2026 requests while
leaving compatibility clients operational. This is the rollback switch for the migration.

The local stdio bridge selects 2026 per message when metadata is present. Before forwarding an old
client message it probes `server/discover` once (disable with `MCP_STDIO_PROBE=false`) and falls
back to compatibility only when the endpoint supports it. It never upgrades an old client message
or invents client identity/capability claims.

## Security and boundaries

Installation bearer tokens remain the only authority for organization and installation scope. The
gateway forwards only protocol and explicitly permitted transport headers; it never forwards
client-controlled organization, actor, installation, or internal trust headers. `Mcp-Param-*` is
reserved for non-sensitive declared tool fields; credential-like names and control characters are
rejected. Gateway browser requests require an explicit `MCP_GATEWAY_ALLOWED_ORIGINS` allowlist.

The migration is locally tested, but external MCP Inspector/generic-client conformance, hosted
proxy behavior, staging rollout, provider effects, and compatibility retirement remain release
gates in `docs/internal/execution/TEMP_MCP_2026_STATELESS_MIGRATION_CHECKLIST.md`.
