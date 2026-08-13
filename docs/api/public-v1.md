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
filtered by public lifecycle, direct runtime support, and the authenticated actor type. Internal,
pilot, retired, and incompatible actions are not returned. The response includes required grants,
OAuth scopes, entitlements, idempotency, risk, approval, audit, and usage metadata so a client can
prepare for the later typed resource/action routes.

## Initial content routes

The first typed resource routes reuse the same content capability adapter used by Agent Platform
internal tools:

- `GET /content/posts` — organization-scoped content records;
- `GET /content/posts/{id}` — one organization-scoped content record;
- `POST /content/posts` — create a reviewable draft. Send an `Idempotency-Key` header; duplicate
  keys resolve to the existing draft rather than creating another record.

These routes do not publish content. Publishing remains an approval-controlled capability and is
not exposed through this initial public resource slice.

The canonical OpenAPI document is [`public-v1.openapi.json`](./public-v1.openapi.json).
