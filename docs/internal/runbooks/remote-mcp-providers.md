---
id: remote-mcp-providers
title: Remote MCP provider operations
sidebar_position: 14
owner: agent-platform
last_reviewed: 2026-09-01
---

# Remote MCP provider operations

Remote MCP providers are organization-owned dependencies. They are not available to an agent
until a human discovers a revision, publishes it, and pins that immutable revision to an agent
version. The provider must also have a healthy reachability projection.

## Lifecycle

1. Create the provider with an HTTPS endpoint and an opaque credential reference.
2. Run discovery. Discovery records the bounded tool schema and marks the endpoint healthy when it
   responds successfully.
3. Review the discovered tool names, schemas, required approval classification, endpoint owner,
   and credential scope.
4. Publish the discovered revision. Publishing is refused unless the latest health check succeeded.
5. Pin the published revision to an agent version. Runtime registration uses only that pinned
   revision.
6. Re-run the health check after provider incidents or before enabling a new installation.

## Reviewed catalogue and OAuth

The Studio reviewed directory is imported from a pinned Hermes revision as metadata. A catalogue
entry is not an active provider until a user connects it. HTTP OAuth entries use the browser
callback flow with protected-resource metadata, authorization-server discovery, PKCE, dynamic
client registration, one-use state, and encrypted token storage. The callback then runs the same
discover, publish, health, and version-pin lifecycle described above.

If a provider does not expose dynamic client registration, Studio accepts a user-supplied OAuth
client ID and optional secret and uses the same PKCE callback. The secret exists only in encrypted
one-use OAuth state until token exchange completes.

Studio only opens that manual client form for the explicit dynamic-registration-unsupported result.
Missing platform OAuth configuration and provider registration failures remain connection errors;
they must not be presented as a request for user-supplied OAuth credentials.

API-key entries write only an encrypted credential reference to the provider record. Stdio entries
remain unavailable until a managed execution adapter exists; do not enable them by copying a
Hermes command into the worker.

## Failure behavior

An unsuccessful discovery or health check records only a bounded error code, latency, timestamp,
and consecutive-failure count. It does not record credentials, response bodies, or prompt content.
Known-unhealthy providers are excluded from effective pinned tools and new pins. Existing database
pins remain intact so an operator can inspect or remove them, but invocation fails closed until the
provider becomes healthy again.

Use `POST /v1/mcp/providers/{providerId}/health` with `agents:write` scope for a manual probe. A
`502` means the provider was unreachable or returned an invalid/bounded response; inspect the
provider's `health_status`, `health_failure_code`, and `health_checked_at` through the provider
list endpoint.

## Disable and rollback

- Revoke the provider when the endpoint, credential, or tool behavior is no longer trusted.
- Unpin the provider revision from affected agent versions before publishing a replacement.
- Deploy the last compatible Agents API/worker artifact if the adapter itself is faulty.
- Keep migration 104 in place; the health projection is additive and does not require deleting
  provider or pin records during rollback.

## Operational evidence

Monitor `kasitek.remote_mcp.operation.count` and
`kasitek.remote_mcp.operation.duration` by bounded operation and outcome. Alert on repeated
`health_check` or `invocation` errors and on providers that remain unhealthy while pinned. The
provider endpoint, authorization token, tool arguments, and result body must never be added to
logs or metric attributes.
