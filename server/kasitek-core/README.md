# The Architect Server

Actix-web backend for thearchitect.fun.

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. Start Postgres and run migrations: `cargo sqlx migrate run`
3. Run server: `cargo run`

## Development

```bash
cargo run
```

## Temporary release access mode

KasiTek starts in invitation-only mode. Set `KASITEK_ACCESS_MODE=private` (or leave it unset) while access is controlled: public signup is blocked, but activated users continue to sign in normally and invitation links can create their accounts.

When the release is ready for public registration, set `KASITEK_ACCESS_MODE=public` on the core backend and `NEXT_PUBLIC_KASITEK_ACCESS_MODE=public` on the client app, then redeploy both services. Existing invitations and normal login continue to work in either mode.

By default, the API server also starts the WhatsApp inbox, WhatsApp marketing, and social publishing workers in the same process.

If you need to disable embedded workers for a pure API process, set:

```bash
KASITEK_DISABLE_BACKGROUND_WORKERS=true cargo run
```

If you want a dedicated worker-only process, use:

```bash
KASITEK_PROCESS=whatsapp-marketing-worker cargo run
KASITEK_PROCESS=whatsapp-inbox-worker cargo run
KASITEK_PROCESS=social-publishing-worker cargo run
KASITEK_PROCESS=billing-reconciliation-worker cargo run
KASITEK_PROCESS=all-workers cargo run
```

Server runs on `http://localhost:8080` by default unless `PORT` is set.

## Content provider setup

Social credentials are encrypted with `SOCIAL_TOKEN_ENCRYPTION_KEY` (or the existing
`WHATSAPP_TOKEN_ENCRYPTION_KEY` fallback). Configure the following values in the shared
vault-backed environment; do not commit provider secrets.

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
AUTH_TIKTOK_SCOPES=user.info.basic,video.publish
```

Add Login Kit and Content Posting API to the TikTok app, register this redirect URI,
and request approval for `user.info.basic` and `video.publish`:

```text
https://YOUR_APP_HOST/api/social/oauth/tiktok/callback
```

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

The connection flow resolves the user's handle and PDS, uses PAR and PKCE, and stores a
separate encrypted DPoP key for every authorized account. Access and refresh tokens are
DPoP-bound and encrypted. The requested scope is limited to identity and Bluesky post
records: `atproto repo:app.bsky.feed.post`.
