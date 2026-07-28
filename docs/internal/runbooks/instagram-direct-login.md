# Instagram Direct Login

KasiTek supports two Instagram connection paths:

- Facebook Login discovers professional Instagram accounts linked to Facebook Pages.
- Instagram Login connects a Business or Creator account directly, without requiring a Facebook Page.

The direct path does not support personal consumer Instagram accounts.

## Meta app setup

In the Meta app dashboard, enable **Instagram API with Instagram Login** and configure these permissions:

- `instagram_business_basic`
- `instagram_business_content_publish`
- `instagram_business_manage_messages`
- `instagram_business_manage_comments`
- `instagram_business_manage_insights`

Add the exact OAuth callback for each environment:

- Development: `https://curtis-pastureless-sickerly.ngrok-free.dev/api/social/oauth/instagram/callback`
- Production: `https://app.kasitek.co.za/api/social/oauth/instagram/callback`

Configure the webhook callback:

- Development: `https://curtis-pastureless-sickerly.ngrok-free.dev/api/webhooks/meta`
- Production: `https://app.kasitek.co.za/api/webhooks/meta`

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
2. Open **Connections** and select **Connect Instagram**.
3. Sign in with the Instagram Business or Creator account.
4. Confirm the account appears under the Instagram section.
5. Send a message to the professional account from another Instagram account and confirm it reaches the Inbox.
6. Reply from the Inbox.
7. In Content, create an Instagram post with a public HTTPS image URL and publish it.

Accounts without an app role require the relevant permissions to have Advanced
Access through App Review.
