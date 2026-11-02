---
title: MCP integration
owner: engineering
last_reviewed: 2026-11-01
---

# MCP integration

Growth implements an OAuth-protected MCP endpoint at `<Growth API origin>/mcp`.
It uses Streamable HTTP POST with JSON responses. GET/SSE sessions and DELETE session
termination are not supported. Availability depends on the deployment's agent-access flag;
source support does not establish that a hosted endpoint has been enabled.

Open **Developers → MCP** for the configured endpoint and your agent connections. Add that
endpoint to an OAuth-capable MCP client. Growth publishes protected-resource and authorization
server metadata, supports dynamic public-client registration and HTTPS client metadata documents,
and requires authorization-code flow with PKCE S256. Client metadata documents can list supported
token authentication methods; Growth selects `none` only when that list includes it, even if
the legacy preference names another method. Clients requiring confidential authentication remain
unsupported. No separate Growth password or shared
agent API key is needed. A client with preconfigured metadata can be registered through
`POST /oauth/register`; confidential-client secrets and client-credentials grants are unsupported.

Sign in through Growth's existing identity provider, select a workspace, and approve the requested
permissions. A connection belongs to that user, workspace, client and exact MCP resource. Tokens
issued for another audience are rejected. A connected social account still needs its provider's
permissions and supported account type for the requested operation.

| Scope | Authority |
| --- | --- |
| `growth:read` | Authorized workspace records, including content and customer data permitted by the operation. |
| `growth:draft` | Reviewed draft and internal record changes. |
| `growth:publish` | Reviewed publication, scheduling, message sending and other external effects. |
| `growth:manage` | Reviewed destructive or account-management operations. |

`tools/list` returns only currently permitted canonical operations. Current membership,
credential scope and entitlements are rechecked when a tool runs. The same operations, schemas,
results and review rules serve [REST](./agent-rest.md) and internal Growth agents; internal agents
call the application directly rather than making an MCP request. The standalone Agents product
retains separate identity, storage and configuration.

Non-read calls require `_requestId`, a stable request identity. The response supplies
`state: "approval_required"`, `_reviewId`'s value in `review.id`, a payload digest and `reviewUrl`.
The user reviews the saved copy, accounts, media and target identity where applicable, and approves or rejects the exact proposed input in Growth. Approval alone does not execute
an action. Resume with the same arguments, `_requestId` and `_reviewId`. Never create a new
request identity to retry an uncertain provider result. Tool results are bounded; follow the
returned `_continuation` using unchanged business arguments to read further JSON chunks.
Large media uses reviewed staged transfers rather than placing entire files in tool results.

Access tokens expire after one hour; refresh tokens expire after 30 days. Refresh rotates the
access and refresh tokens. Reusing an old refresh token revokes that connection. Clients must
serialize refreshes and retain only the replacement token. `POST /oauth/revoke` accepts the
connection's token and client ID. **Developers → MCP** can disconnect an individual connection.
Ordinary browser logout retains independent agent connections; account-wide logout and verified
identity-provider subject revocation invalidate them. Each connection is independently revocable.

OAuth metadata, consent and token routes remain available for discovery and connection lifecycle;
operation access and effects can be disabled separately by the operator. Additional browser MCP
origins must be explicitly allowed. Do not send tokens or private customer data to support logs.
