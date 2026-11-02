---
title: MCP integration
owner: engineering
last_reviewed: 2026-11-02
---

# MCP integration

Growth implements an OAuth-protected MCP endpoint at `<Growth API origin>/mcp`.
It accepts HTTP POST with JSON responses. Legacy clients use Streamable HTTP; clients using
protocol `2026-07-28` use stateless discovery and per-request capabilities. GET/SSE sessions and
DELETE session termination are not supported. Availability depends on the deployment's agent-access flag;
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
| `growth:draft` | Requested private content drafts/media; reviewed changes to other internal records. |
| `growth:publish` | Content publication and scheduling; reviewed message sending and other external effects. |
| `growth:manage` | Authorized content deletion; reviewed non-content destructive or account-management operations. |

`tools/list` returns currently permitted business operations. Current membership, credential
scope and entitlements are rechecked when a tool runs. MCP, [REST](./agent-rest.md) and internal
Growth agents share the same handlers and content execution rules. Internal agents call the
application directly; the standalone Agents product retains separate identity and storage.

## Content actions and optional previews

Authorized content writes execute directly with a stable `_requestId`. This includes private
drafts/media, publication, scheduling, retries, cancellation, deletion and supported published-post
updates. Growth does not require a separate approval page, form, card or approval token. Client
confirmation follows the MCP client's settings. A client tool call is delegated execution authority,
not evidence that Growth observed a human approval.

Use `content.actions.preview` when you need to inspect exact content before execution. Supply the
action name, business `input` and a stable `requestId`. The model-readable result includes saved
copy and platform variants, ordered media, selected accounts, timing/timezone, proposed changes
and readiness errors. Previewing does not change content or contact a provider. It is optional.

To bind an action to that preview, pass its `_previewId`, unchanged business input and the same
`_requestId`. Changed content, media, account state or input invalidates that preview. Without a
preview, execution validates the current snapshot. Both paths enforce current scopes, workspace
membership, entitlements, provider readiness, durable receipts and duplicate prevention.
Provider permissions and supported formats still differ across Facebook, Instagram, Threads,
TikTok, LinkedIn, X and Bluesky. Non-content operations retain their existing review rules.

Never create a new request identity to retry an uncertain result. Tool results are bounded;
follow `_continuation` with unchanged business arguments to read further JSON chunks. Large media
uses staged transfers rather than placing entire files in tool results.

Access tokens expire after one hour; refresh tokens expire after 30 days. Refresh rotates the
access and refresh tokens. Reusing an old refresh token revokes that connection. Clients must
serialize refreshes and retain only the replacement token. `POST /oauth/revoke` accepts the
connection's token and client ID. **Developers → MCP** can disconnect an individual connection.
Ordinary browser logout retains independent agent connections; account-wide logout and verified
identity-provider subject revocation invalidate them. Each connection is independently revocable.

OAuth metadata, consent and token routes remain available for discovery and connection lifecycle;
operation access and effects can be disabled separately by the operator. Additional browser MCP
origins must be explicitly allowed. Do not send tokens or private customer data to support logs.
