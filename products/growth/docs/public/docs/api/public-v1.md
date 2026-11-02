# KasiTek Public API v1

The Growth public API uses `/v1`, separately from private `/api/*` product routes.
The standalone Agents product and its execution service have a separate contract.
Growth product agents use their own authenticated product routes and signed shared-execution commands.

## Authentication

Use a Growth user session, a workspace Developer API key, or a delegated Growth OAuth
access token. OAuth tokens issued for the configured Growth MCP resource are also accepted
by the REST operations and typed aliases. Connect through the [OAuth MCP flow](./mcp-integration.md).
Developer keys are created in **Developers → API Keys**; their raw value is shown once.

Send `Authorization: Bearer <credential>`. The operation's `growth:read`, `growth:draft`,
`growth:publish`, or `growth:manage` scope and current workspace access are checked at execution.
Choose the required scopes when creating a Developer API key. Rotation preserves that key's scopes. Legacy `api:read` permits reads and `api:write` permits drafts; neither grants publication or
destructive authority. Revoked credentials never fall back to a browser session.

`GET /health` is intentionally unauthenticated and contains no workspace or capability data.

## Capability discovery

`GET /capabilities` returns the same canonical Growth operation definitions used by
`GET /operations`, MCP tools, and internal agents, filtered by current workspace access,
entitlements and credential scopes. Definitions include the input schema, effect, required
scope, review and idempotency policy.

Discovery accepts `limit` (1–200, default 100), `cursor` (a zero-based offset), and `version=v1`.
The `pagination` object returns the effective limit, cursor, total, stable version, and an optional
`nextCursor`.

## Initial content routes

Typed content aliases invoke the canonical operations:

- `GET /content/accounts`, `/content/posts`, `/content/posts/{id}` and `/content/posts/{id}/activity`;
- `GET /content/media/{id}` and `/content/media/{id}/preview`;
- `POST /content/posts` and `PATCH /content/posts/{id}` for drafts.

Draft writes require an `Idempotency-Key` header or `_requestId`. The first request returns
`202` with `state: "approval_required"` and an exact review link; it does not save a draft.
After the workspace user approves, repeat the same input and request identity with `_reviewId`.
A completed create returns `201`; an update returns `200`. Reusing the approved receipt returns
the recorded result. Changing the input requires a new review. These aliases reject publication
and scheduling fields; use the corresponding canonical operations for those actions.

## Organization read routes

The following typed aliases share canonical authorization, service results and credential
sanitization with MCP and internal agents. Authorized contact details, message content and
business records are present when the operation permits them; the aliases do not apply an
additional independent redaction policy.

- `GET /contacts` accepts `q`, `optIn`, `excluded`, `tag`, `location`, `listLabel`, `limit` and `cursor`;
- `GET /inbox/conversations` and `/inbox/conversations/{id}/messages`;
- `GET /bookings`;
- `GET /campaigns` and `/campaigns/{id}`;
- `GET /templates?status=...`.

Read aliases project the canonical operation's `result` into the typed response. Collection
pagination uses `limit`, `cursor` and `nextCursor`; totals are returned only by services that
provide them. Large canonical observations return a JSON chunk and continuation rather than
an unbounded response. Repeat the same typed read URL and business query with `_continuation=<returned cursor>` to read subsequent chunks. Reconstruct the canonical JSON envelope from its ordered chunks. Draft write aliases accept `_continuation` in the body on the same approved request; receipt replay does not repeat the effect.

These are read-only resources. Every authenticated request reserves a durable `PublicApiRequest`
row before dispatch, keyed by organization and principal. The shared `/v1` middleware finalizes the
row with the action and HTTP status, and uses those reservations for a distributed per-principal
one-minute rate limit. The default limit is 120 requests per minute and can be changed with
`KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE`; a rejected request returns `429` with `Retry-After: 60`.
The reservation also writes the registered `public_api_requests` workspace meter with a stable
idempotency key. It is request-level usage, not a provider-effect meter. Provider-effect usage is recorded by the owning domain.

The OpenAPI documents are generated from the runtime operation catalogue; `pnpm exec tsx scripts/refresh-openapi.ts` from the API directory checks drift.

The canonical OpenAPI document is [`public-v1.openapi.json`](./public-v1.openapi.json).
