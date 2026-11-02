# Instagram Direct Login

KasiTek supports two Instagram connection paths:

- Facebook Login discovers professional Instagram accounts linked to Facebook Pages.
- Instagram Login connects a Business or Creator account directly, without requiring a Facebook Page.

The direct path does not support personal consumer Instagram accounts.

Direct Instagram Login cannot delete published media. Use Meta/Facebook Login for an agent or user
that must delete a published Instagram post; the Meta flow requests `instagram_manage_contents`.
See [Meta's Instagram Media deletion reference](https://developers.facebook.com/docs/instagram-api/reference/ig-media/).

## Meta app setup

In the Meta app dashboard, enable **Instagram API with Instagram Login** and configure these permissions:

- `instagram_business_basic`
- `instagram_business_content_publish`
- `instagram_business_manage_messages`
- `instagram_business_manage_comments`
- `instagram_business_manage_insights`

Add the exact OAuth callback for each environment:

- Development: `https://dev-client.kasitek.co.za/api/social/oauth/instagram/callback`
- Production: `https://api.kasitek.co.za/api/social/oauth/instagram/callback`

Configure the webhook callback for the intended deployment. An existing app-host webhook URL can continue through the `/api` proxy; verify deliveries before changing a registered URL:

- Development: `https://dev-client.kasitek.co.za/api/webhooks/meta`
- Production: `https://api.kasitek.co.za/api/webhooks/meta`

The webhook verify token must match `META_WEBHOOK_VERIFY_TOKEN` or
`AUTH_META_WEBHOOK_VERIFY_TOKEN` on the server.

## Server environment

Set the Instagram-specific credentials shown by the Instagram Login setup:

```dotenv
AUTH_INSTAGRAM_APP_ID=
AUTH_INSTAGRAM_APP_SECRET=
```

These are the Instagram App ID and Instagram App Secret shown in the Instagram
API setup. They are not the Facebook/Meta App ID and App Secret. The server does
not fall back to the Meta credentials because Instagram rejects the Meta App ID
as an invalid platform app.

The optional scope override is:

```dotenv
AUTH_INSTAGRAM_SCOPES=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights
```

Restart the server after changing environment variables.

## Test flow

1. Add the Instagram professional account as an app tester while the app is in development mode.
2. Open **Connections** → **Connect Instagram**, then choose **Connect Instagram** under **Instagram Login**. The **Continue to Meta** action is the separate Page-linked flow.
3. Sign in with the Instagram Business or Creator account.
4. Confirm the account appears under the Instagram section.
5. Send a message to the professional account from another Instagram account and confirm it reaches the Inbox.
6. Reply from the Inbox.
7. In Content, create an Instagram post with a public HTTPS image URL and publish it.

Accounts without an app role require the relevant permissions to have Advanced
Access through App Review.

## Hosted verification and limits

On 2026-11-02 the live Instagram app ID matched the Instagram Login product, and its allowed
redirect already matched the current public API callback. No Meta settings or credentials were
changed. Starting the direct flow from the authenticated live Connections page reached
Instagram's own login screen with the Instagram-specific client ID and business scopes.
This does not establish completed authorization until an eligible account signs in and is imported.

Meta's dashboard currently labels this Instagram Login setup as legacy and states that it still
works. This restoration preserves that existing integration; a Unified Login migration is separate
work. The credential fields being populated does not prove the stored secret is valid.

Direct Instagram long-lived-token refresh is not implemented in the current runtime. Initial
connection and explicit reconnect must be verified separately from long-term unattended operation.
Source tests cover the direct short/long-token/profile path without Page discovery, direct
publishing and webhook signature validation; they do not establish live delivery or publishing.
See `docs/operations/instagram-direct-restoration.md` for release evidence and remaining acceptance.
