# KasiTek Public API v1

The Growth public API uses `/v1`, separately from private `/api/*` product routes.
The standalone Agents product and its execution service have a separate contract.
Growth product agents use their own authenticated product routes and signed shared-execution commands.

## Authentication

Use an authenticated Growth user session or a workspace Developer API key created
in **Developers → API Keys**. Developer keys are opaque bearer credentials. The raw
value is shown once when created or rotated; Growth stores its SHA-256 digest.

Send `Authorization: Bearer <developer-api-key>` to the REST API. Initial keys carry
`api:read` and `api:write` scopes; expiry, revocation, scope and product permissions
are checked on each request. A key does not grant unrestricted business access.

The removed Agents installation-token exchange and MCP gateway are not supported
setup paths. Growth OAuth MCP access remains unavailable.

`GET /health` is intentionally unauthenticated and contains no workspace or capability data.

## Capability discovery

`GET /capabilities` returns a stable DTO generated from the shared action catalog. Discovery is
filtered by public lifecycle, direct runtime support, authenticated actor type, active organization
entitlements and the caller's applicable permissions and API scopes.
Internal, pilot, retired, unentitled, and incompatible actions are not returned. The response
includes required grants, OAuth scopes, entitlements, idempotency, risk, approval, audit, and usage
metadata so a client can prepare for the later typed resource/action routes.

Discovery accepts `limit` (1–200, default 100), `cursor` (a zero-based offset), and `version=v1`.
The `pagination` object returns the effective limit, cursor, total, stable version, and an optional
`nextCursor`.

## Initial content routes

The typed content routes use Growth-owned capability adapters and business operations:

- `GET /content/posts` — organization-scoped content records;
- `GET /content/posts/{id}` — one organization-scoped content record;
- `POST /content/posts` — create a reviewable draft. Send an `Idempotency-Key` header; duplicate
  keys resolve to the existing draft rather than creating another record.

These routes do not publish content. Publishing remains an approval-controlled capability and is
not exposed through this initial public resource slice.

## Organization read routes

Authenticated callers can also use the typed read resources below. They all resolve a normalized
organization context, apply the catalog grant and entitlement policy, and remove provider/customer
fields classified as restricted before returning the response:

- `GET /contacts` — contact inventory and consent/list summaries (phone and metadata redacted);
- `GET /inbox/conversations` — conversation and unread summaries (phone and last-message content redacted);
- `GET /inbox/conversations/{id}/messages` — a scoped message timeline with message content and attachments redacted;
- `GET /bookings` — organization bookings (contact phone and notes redacted);
- `GET /campaigns` and `GET /campaigns/{id}` — campaign status and delivery summaries (template and recipient fields redacted);
- `GET /templates?status=...` — template inventory and approval status (message body/buttons redacted).

These are read-only resources. Every authenticated request reserves a durable `PublicApiRequest`
row before dispatch, keyed by organization and principal. The shared `/v1` middleware finalizes the
row with the action and HTTP status, and uses those reservations for a distributed per-principal
one-minute rate limit. The default limit is 120 requests per minute and can be changed with
`KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE`; a rejected request returns `429` with `Retry-After: 60`.
The reservation also writes the registered `public_api_requests` workspace meter with a stable
idempotency key. It is request-level usage, not a provider-effect meter. Writes, provider effects,
webhooks, and additional principal types remain separate release gates in the audit checklist.

The canonical OpenAPI document is [`public-v1.openapi.json`](./public-v1.openapi.json).
