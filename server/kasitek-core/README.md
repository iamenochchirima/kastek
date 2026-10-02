# KasiTek Growth Core

_Owner: engineering · Last reviewed: 2026-10-03_

Native Node.js 24 and TypeScript backend for KasiTek Growth.

TypeScript registers all 537 inventoried Core operations and ten worker modes.
The previous Rust Core and Growth-local Rust libraries have been removed from
this checkout after local API, worker, and consumer checks. The preceding Git
commit is the recovery point. SQL, database migrations, OpenAPI assets, and
media storage remain in place.

This source cleanup did not change hosted services. Railway still records the
legacy Rust Core build until private package delivery is verified and a hosted
TypeScript cutover is separately authorized. Some live provider setup and
cross-service producer checks remain pending.

## Setup

1. Use Node.js 24 and pnpm 10.30.1. Configure the service `.env`; the shared-login
   settings are documented in `.env.identity.example`.
2. Prepare the pinned private Labs packages and install locked dependencies from
   this service directory:
   `pnpm prepare:shared /path/to/kasitek-labs && pnpm install --frozen-lockfile`.
   `LABS_SOURCE_DIR` can supply that source path instead. The package preparation
   command verifies the pinned source and artifact checksums.
3. Start Postgres and apply the Core schema from the repository root:
   `pnpm --dir client/packages/database exec prisma migrate deploy`
4. Start the shared Keycloak service from Labs, then run `pnpm dev`.

## Development

```bash
pnpm dev
# Production artifact, without a watcher:
pnpm build
pnpm start
```

## Temporary release access mode

KasiTek starts in invitation-only mode. Set `KASITEK_ACCESS_MODE=private` (or leave it unset) while access is controlled: public signup is blocked, but activated users continue to sign in normally and invitation links can create their accounts.

Early-access self-service invitations are enabled by default. Set `EARLY_ACCESS_SELF_SERVICE_ENABLED=false` to stop new early-access approval, signup, and activation while preserving existing records.

When the release is ready for public registration, set `KASITEK_ACCESS_MODE=public` on the core backend and `NEXT_PUBLIC_KASITEK_ACCESS_MODE=public` on the client app, then redeploy both services. Existing invitations and normal login continue to work in either mode.

During the controlled Agent Platform testing phase, commercial feature and usage-limit enforcement
is disabled by default so authenticated workspace users can test the product. Usage is still
recorded, while authentication, organization isolation, runtime limits, approvals, and provider
safety checks remain active. Set `KASITEK_BILLING_ENFORCEMENT=true` when commercial billing gates
are ready to be re-enabled.

By default, the API server also starts the WhatsApp inbox, WhatsApp marketing, and social publishing workers in the same process.

In private mode, the client app directs users to invitation redemption when they do not yet have an activated account. The invitation link or token is required before a new account can be created.

## Agent Platform bridge

The direct product exposes authenticated KasiAi and platform-agent routes through `kasitek-core`.
The browser authenticates with the normal user session; core resolves the active organization and
calls the separately deployed Agent Platform with a short-lived HMAC token. Configure these values
in the core environment and use the same signing secret in `agents`:

```text
AGENTS_API_URL=http://localhost:4100
AGENTS_INTERNAL_AUTH_SECRET=
AGENTS_INTERNAL_AUTH_AUDIENCE=kasitek-agents
AGENTS_API_TIMEOUT_MS=15000
```

In production, `AGENTS_API_URL` and `AGENTS_INTERNAL_AUTH_SECRET` are required. The browser-facing
routes are under `/api/agents`; they cover KasiAi installation, platform conversation/message
operations, run inspection/cancellation, and the durable SSE event stream. Core deliberately
accepts only route and page-title context from the browser; resource-specific context must be
authorized by a future core read boundary before it is passed to an agent.

Telegram webhooks are exposed at `/api/webhooks/telegram/{connectionId}`. Set the Agent Platform's
`TELEGRAM_WEBHOOK_BASE_URL` to the public core origin so it can register that URL with Telegram.
Core forwards the provider update over the existing Agent Platform bridge; no Telegram secret is
stored in core.

If you need to disable embedded workers for a pure API process, set:

```bash
KASITEK_DISABLE_BACKGROUND_WORKERS=true pnpm start
```

If you want a dedicated worker-only process, use:

```bash
KASITEK_PROCESS=whatsapp-marketing-worker pnpm start
KASITEK_PROCESS=whatsapp-inbox-worker pnpm start
KASITEK_PROCESS=social-publishing-worker pnpm start
KASITEK_PROCESS=billing-reconciliation-worker pnpm start
KASITEK_PROCESS=analytics-publisher pnpm start
KASITEK_PROCESS=analytics-backfill-worker pnpm start
KASITEK_PROCESS=all-workers pnpm start
```

The Analytics publisher is independently scalable and disabled unless
`ANALYTICS_CORE_INGESTION_TOKEN` is configured. Set `ANALYTICS_INGESTION_URL` (default
`http://127.0.0.1:4300`), `ANALYTICS_CORE_PRODUCER_ID`, and `ANALYTICS_CORE_PUBLISHER_ID` in the
Core environment. The token must match the `core` credential configured by the Labs-owned Analytics
service ([source and local setup](https://github.com/Kasitek-Labs/kasitek-labs/tree/main/services/analytics)).
Growth retains the publisher and Core outbox. The actual Core publisher has been verified against
the local TypeScript Analytics API, projection worker, and an authorized campaign report; the
Agency and Agents producer paths remain separate follow-up work. The worker claims Core's durable outbox, sends authenticated batches,
applies each acknowledgement, retries transient failures, and reclaims expired leases. The same
process also runs the bounded Core source backfill loop; deploy `analytics-backfill-worker`
separately when historical reconstruction needs independent capacity.

### Public v1 API webhooks

Authenticated `/v1` clients can create organization-scoped subscriptions at
`/v1/webhooks/subscriptions`. The supported events are
`public_api.request.completed`, `content.post.created`, and
`content.post.updated`. Core stores the signing secret encrypted,
returns it only from the create response, and signs the exact JSON body with
`HMAC-SHA256` over `{unixTimestamp}.{body}`. Receivers should reject stale
timestamps and duplicate event ids. Delivery attempts are durable, use capped
exponential backoff, disable a subscription after ten failed attempts, and are
visible at `/v1/webhooks/subscriptions/{id}/deliveries`.

Set `PUBLIC_WEBHOOK_ENCRYPTION_KEY` in production (the existing social/WhatsApp
encryption key is only a development fallback). A local non-production process
may target `http://localhost`; production destinations must be public HTTPS.
The worker can run embedded or independently with
`KASITEK_PROCESS=public-webhooks-worker`.

The deployment policy knobs `PUBLIC_API_DISABLED_ROUTES`,
`PUBLIC_API_DEPRECATED_ROUTES`, `PUBLIC_API_SUNSET`, and
`PUBLIC_API_DEPRECATION_LINK` control route flags and standard deprecation
headers without changing the contract. `/v1/capabilities` exposes the current
principal matrix: direct product users, workspace Developer API keys, and agent
installations are supported; service accounts and OAuth grants remain explicitly
unsupported until their issuers and resource policies are approved.

Server runs on `http://localhost:4000` by default unless `PORT` is set.

See the [native runtime guide](../../docs/internal/development/typescript-core.md)
for all process modes, shutdown behavior and remaining migration verification.

## Content provider setup

Social credentials are encrypted with `SOCIAL_TOKEN_ENCRYPTION_KEY` (or the existing
`WHATSAPP_TOKEN_ENCRYPTION_KEY` fallback). Configure the following values in the shared
vault-backed environment; do not commit provider secrets.

All social OAuth callback URLs must be reachable at the public API origin. Set
`KASITEK_CORE_PUBLIC_URL` to the public HTTPS origin whose `/api` routes reach
`kasitek-core` (either directly or through the client API proxy). For local testing,
use an active HTTPS tunnel. Set `NEXT_PUBLIC_API_BASE_URL` to the API origin the browser
uses. `FRONTEND_URL` remains the browser app origin used after an OAuth callback completes.

### Meta, Facebook, Instagram, and WhatsApp

Configure the production Meta credentials in the Core vault. The scope value is comma-separated;
the access center derives a smaller request from product capability keys when a user asks for
additional access:

```text
AUTH_META_APP_ID=
AUTH_META_APP_SECRET=
AUTH_META_SCOPES=pages_show_list,pages_manage_metadata,pages_read_engagement,pages_manage_posts,pages_messaging,pages_manage_engagement,read_insights,instagram_basic,instagram_content_publish,instagram_manage_messages,instagram_manage_comments,instagram_manage_insights,instagram_manage_contents
META_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
```

The client build must use the same Live Meta app and its approved Embedded Signup configuration:

```text
NEXT_PUBLIC_META_APP_ID=<the same AUTH_META_APP_ID>
NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID=<the Live Embedded Signup configuration ID>
```

Register these production URLs in the Live Meta app:

```text
https://api.kasitek.co.za/api/social/oauth/meta/callback
https://api.kasitek.co.za/api/social/oauth/instagram/callback
https://api.kasitek.co.za/api/webhooks/meta
https://api.kasitek.co.za/api/webhooks/whatsapp
```

Enable Facebook Login for Business, Instagram API with Facebook Login, and WhatsApp Business
Platform. Request Advanced Access through App Review for every permission used by the deployed
flows:

```text
Meta Login:
pages_show_list
pages_manage_metadata
pages_read_engagement
pages_manage_posts
pages_messaging
pages_manage_engagement
read_insights
instagram_basic
instagram_content_publish
instagram_manage_messages
instagram_manage_comments
instagram_manage_insights
instagram_manage_contents

Direct Instagram Login (separate Instagram app configuration):
instagram_business_basic
instagram_business_content_publish
instagram_business_manage_messages
instagram_business_manage_comments
instagram_business_manage_insights

WhatsApp Embedded Signup:
whatsapp_business_management
whatsapp_business_messaging
```

Add `business_management` only for a reviewed Solution Partner operation that actually performs
business portfolio actions. Meta's Live Embedded Signup flow exposes only permissions approved for
Advanced Access. The app-review submission must demonstrate the real use of each permission; this
external dashboard approval is a release prerequisite and is not automated by Core.

The OAuth callback and the webhook URLs are separate concerns. The production Core origin must be
set in `KASITEK_CORE_PUBLIC_URL`; `FRONTEND_URL` is only the post-callback browser destination.
After applying a Meta configuration change, connect one test Page, one Instagram professional
account, and one WhatsApp WABA, then verify the Access section and webhook health before enabling
the flow for all workspaces.

### Threads

```text
AUTH_THREADS_APP_ID=
AUTH_THREADS_APP_SECRET=
AUTH_THREADS_SCOPES=threads_basic,threads_content_publish
```

Create a Meta app with the Threads use case and register this exact redirect URI:

```text
https://YOUR_APP_HOST/api/social/oauth/threads/callback
```

Configure the remaining Threads callbacks to the public endpoints below:

```text
Uninstall Callback URL:
https://YOUR_APP_HOST/api/social/oauth/threads/uninstall

Delete Callback URL:
https://YOUR_APP_HOST/api/social/oauth/threads/data-deletion
```

Meta sends both callbacks as form-encoded `signed_request` payloads. The backend verifies
their HMAC-SHA256 signatures with `AUTH_THREADS_APP_SECRET` before removing any data. An
uninstall removes encrypted credentials and provider-returned identifiers. A deletion
request performs the same cleanup, records a non-identifying confirmation, and returns the
required public completion-status URL. Apply the `SocialDataDeletionRequest` database
migration before configuring the Delete Callback URL.

Enable `threads_basic` and `threads_content_publish`. Production accounts outside the
app's assigned roles require Meta review/advanced access. The backend exchanges the
short-lived authorization token for a long-lived token and refreshes it during publishing.

### TikTok

```text
AUTH_TIKTOK_CLIENT_KEY=
AUTH_TIKTOK_CLIENT_SECRET=
```

The initial connection requests only `user.info.basic`, which is the Login Kit baseline. Add
optional access from the Connections panel when the TikTok app has the matching approved product
and scope. `video.publish` is required for Direct Post, `video.upload` for uploading a draft, and
`user.info.stats` for profile statistics. Register this redirect URI:

```text
https://YOUR_APP_HOST/api/social/oauth/tiktok/callback
```

For a TikTok sandbox app configured only for **Upload**, request the Use media capability from the
Connections panel. This allows the creator to receive a draft in their TikTok inbox for final
editing and posting. Direct publishing requires the separate `video.publish` scope and Direct Post
configuration.

Add every media host used by Content to TikTok's verified URL properties. Direct posts
from an unaudited client are restricted to private visibility. Public posting requires
TikTok's Content Posting API audit. The composer queries the creator's current privacy
options, requires explicit consent, and sends media by `PULL_FROM_URL`; media URLs must
use HTTPS, must not redirect, and must remain available while TikTok downloads them.
The social worker polls TikTok's publish-status endpoint and keeps the job in Processing
until moderation completes or TikTok reports a failure. Configure the TikTok **Webhooks**
product as well; it delivers the same lifecycle updates with lower latency and handles
authorization removal. The server verifies `TikTok-Signature` against
`AUTH_TIKTOK_CLIENT_SECRET`, persists each event before acknowledging it, and safely
deduplicates retries.

```text
# Sandbox / local tunnel
https://curtis-pastureless-sickerly.ngrok-free.dev/api/webhooks/tiktok

# Production
https://app.kasitek.co.za/api/webhooks/tiktok

# Optional replay-window override; defaults to 300 seconds (allowed range: 30–3600).
TIKTOK_WEBHOOK_MAX_AGE_SECONDS=300
```

Do not use the OAuth redirect URI as the webhook callback URL. TikTok webhooks do not
provide comments, direct messages, or like notifications; those would require a separate
supported TikTok inbox/moderation integration if one becomes available.

### Bluesky

Bluesky uses AT Protocol OAuth rather than a developer-dashboard client secret. KasiTek
acts as a confidential web client and publishes its client metadata and public JWK at:

```text
https://YOUR_APP_HOST/api/social/oauth/bluesky/client-metadata
```

The corresponding callback is:

```text
https://YOUR_APP_HOST/api/social/oauth/bluesky/callback
```

Generate a 32-byte P-256 private scalar, encode it as unpadded base64url, and configure:

```text
AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY=
AUTH_BLUESKY_OAUTH_CLIENT_KEY_ID=kasitek-bluesky-oauth-1
```

Before showing Bluesky as connectable, verify this endpoint returns JSON (not a proxy
404 page) from outside your network:

```bash
curl --fail https://YOUR_CORE_API_HOST/api/social/oauth/bluesky/client-metadata
```

The Connections screen performs this same check before opening Bluesky. If it fails,
fix the public backend route or tunnel first; changing only `FRONTEND_URL` will not
make the OAuth callback reachable.

The connection flow resolves the user's handle and PDS, uses PAR and PKCE, and stores a
separate encrypted DPoP key for every authorized account. Access and refresh tokens are
DPoP-bound and encrypted. The public client metadata declares the maximum requested scope set:
`atproto repo:app.bsky.feed.post blob:*/*`. Initial connections request only
`atproto repo:app.bsky.feed.post`; requesting **Use media** adds `blob:*/*`. Publishing and
deleting an account-owned post use the `repo:app.bsky.feed.post` grant.
