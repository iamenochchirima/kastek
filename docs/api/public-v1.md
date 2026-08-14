# KasiTek Public API v1

The general public API is served by `kasitek-core` at `https://api.kasitek.co.za/v1`. It is separate
from the private `/api/*` product routes and from the Agent Platform transport at
`agents.kasitek.co.za`.

## Authentication

`GET /capabilities` currently accepts either:

- an authenticated KasiTek user session bearer token; or
- an Agent Platform ES256 installation token issued for the `kasitek-public-api` audience.

Core validates the installation token signature, issuer, audience, expiry, subject, organization,
and credential claims using `AGENTS_INSTALLATION_TOKEN_PUBLIC_KEY`. Installation credential
revocation/introspection and full scope/grant/entitlement evaluation remain required before broad
machine access is enabled.

`GET /health` is intentionally unauthenticated and contains no workspace or capability data.

## Capability discovery

`GET /capabilities` returns a stable DTO generated from the shared action catalog. Discovery is
filtered by public lifecycle, direct runtime support, authenticated actor type, active organization
entitlements, installation grants/availability, and API scope where the caller is an installation.
Internal, pilot, retired, unentitled, and incompatible actions are not returned. The response
includes required grants, OAuth scopes, entitlements, idempotency, risk, approval, audit, and usage
metadata so a client can prepare for the later typed resource/action routes.

Discovery accepts `limit` (1–200, default 100), `cursor` (a zero-based offset), and `version=v1`.
The `pagination` object returns the effective limit, cursor, total, stable version, and an optional
`nextCursor`.

## Initial content routes

The first typed resource routes reuse the same content capability adapter used by Agent Platform
internal tools:

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

These are read-only resources. Writes, provider effects, webhooks, rate/meter enforcement, and
additional principal types remain separate release gates in the audit checklist.

The canonical OpenAPI document is [`public-v1.openapi.json`](./public-v1.openapi.json).
