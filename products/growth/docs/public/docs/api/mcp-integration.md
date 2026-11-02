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
| `growth:publish` | Reviewed publication, scheduling, message sending and other external effects. |
| `growth:manage` | Reviewed destructive or account-management operations. |

`tools/list` returns only currently permitted canonical operations. Current membership,
credential scope and entitlements are rechecked when a tool runs. The same operations, schemas,
results and review rules serve [REST](./agent-rest.md) and internal Growth agents; internal agents
call the application directly rather than making an MCP request. The standalone Agents product
retains separate identity, storage and configuration.

## Drafts and exact content confirmation

An explicit request to save or change a private content draft can execute directly. This covers
`content.posts.draft.create`, `content.posts.draft.update`, `content.posts.duplicate`,
`content.media.upload` and `content.media.transfer.prepare`. These remain writes: they require
draft scope, current authority and a stable `_requestId`, and return durable receipts. A request
for suggested copy alone does not authorize saving it.

Before publishing, scheduling, retrying, canceling, deleting or editing published content, call
`content.actions.preview` with the action name, exact business `input` and a stable `requestId`.
It returns a bound preview ID, copy and platform variants, media, selected account identities,
timing/timezone, targets and readiness errors. Previewing does not publish or contact providers.
Use `_previewId` with the unchanged action input; `_reviewId` remains supported for existing
reviews. Changing saved content, account state, media or the requested action requires a fresh
preview and confirmation. Provider permissions and format support still apply separately for
Facebook, Instagram, Threads, TikTok, LinkedIn, X and Bluesky.

A capable `2026-07-28` client can present the exact action as an in-chat confirmation form.
Growth accepts the client's protocol-level form response bound to the saved preview; a model
argument such as `approved: true` is not approval. The client must advertise form elicitation
on the current request. Registered ChatGPT clients additionally need the OpenAI form extension.
Native host rendering remains subject to client support and deployment acceptance checks.

Other clients receive `state: "approval_required"` with a payload digest and `review.reviewUrl`.
Open that Growth page to inspect and approve/reject the exact action, then resume with unchanged
arguments, `_requestId` and `_reviewId`. The same fallback applies when the exact preview cannot
fit in the confirmation form. Approval alone does not execute an action. Other non-content
writes retain their existing Growth review flow.

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
