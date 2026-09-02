---
title: Connection Failure Runbook
---

# Connection Failure Runbook

Use this when a provider account shows `NEEDS_ATTENTION`, messages stop arriving, publishing fails, or a webhook is not healthy.

## First checks

1. Confirm the user selected the correct organisation.
2. Open `/connections` and identify the provider account, current status, credential status, and webhook status.
3. Check the API and worker logs using the connection source ID and organisation ID. Do not log or copy access tokens.
4. Confirm the organisation still has the entitlement required by the failed capability.

## WhatsApp

1. Run the connection health check from the WhatsApp maintenance section.
2. If token validation fails, replace the access token. The replacement is encrypted before it is stored.
3. If webhook validation fails, confirm the WABA is subscribed to the Meta app and that `WHATSAPP_WEBHOOK_VERIFY_TOKEN` matches the callback configuration.
4. Confirm the callback is reachable over HTTPS and inspect recent webhook response codes.
5. Refresh the connection and re-run template synchronization after health is restored.
6. In the connection **Access** section, treat `GRANTED` messaging as the combination of the
   inspected Meta permission, a valid phone lookup, and a subscribed WABA webhook. A token with
   `whatsapp_business_messaging` alone is not sufficient.
7. Embedded Signup uses the fixed Meta configuration. If a requested access action opens setup,
   complete Embedded Signup for the same business and phone; do not create a duplicate manual
   connection unless the setup flow is unavailable.

## Facebook and Instagram

1. Open the affected account in `/connections` and inspect the **Access** section before disconnecting anything.
2. Use **Grant access** for requestable missing access. Reauthorization updates the existing connection and does not remove drafts, history, or agent assignments.
3. Confirm the expected Page and Instagram professional account were returned by Meta.
4. Confirm required Page, messaging, publishing, and Instagram permissions are approved for the app and granted by the customer.
5. Meta Login Instagram published-media deletion requires the provider's
   `instagram_manage_contents` permission and the appropriate Instagram account access. Use the
   connection Access section to request it. Direct Instagram Login remains unsupported for
   published-media deletion; local draft deletion is a separate operation.
6. Confirm `META_WEBHOOK_VERIFY_TOKEN` or `AUTH_META_WEBHOOK_VERIFY_TOKEN` matches the Meta webhook subscription.
7. Confirm the Meta app's `page` subscription callback is the production Core URL: `https://api.kasitek.co.za/api/webhooks/meta`. A stale local or ngrok callback means Page messages will never reach Core even when each Page is marked connected.
8. Confirm each Page is subscribed to the app's messaging fields. Loading the workspace social-channel list re-applies the app-level Page callback and refreshes connected Page subscriptions.
9. If Inbox receives the message but the agent does not respond, open the agent's **Integrations** tab and confirm the account is **Assigned**. The route key is the workspace `ExternalConnection` owned by Core.
10. Check Core logs for `provider.webhook.received`/`webhook.receive`, `agent_platform.meta_ingest` and Agent Platform logs for `channel.ingest`. A route conflict means another active customer-service agent owns the same Page or Instagram account; remove that route before assigning it elsewhere.
11. If agent replies fail, inspect the Core `channel.delivery` event and Meta response. Core must remain the only service holding the Meta access token.
12. If Instagram publishing reports `Media ID is not available`, the media container was not ready
    when publishing was attempted. The adapter now polls the container status for a bounded period
    before calling `media_publish`; a terminal timeout or provider error is a real failed publish,
    so retry the same idempotent action after checking the connection rather than claiming success.
13. An approved-publish reply that says only “check the channel connection” is not a reliable
    diagnosis. Current Agent responses distinguish media processing, missing publish access,
    unusable media, connection credentials, and temporary provider failures. Use the specific
    remediation in the reply and inspect the Core error code if the message is still generic.
14. If the provider post exists but the agent reported a failure, treat the result as an
    indeterminate confirmation rather than immediately retrying. Inspect the `SocialPublishJob`
    status and `externalPostId` first. The Agent publish boundary has a longer bounded timeout for
    provider media processing, and Core preserves a persisted publish when post readback or usage
    recording degrades after the provider effect. Retry only after confirming that no published
    provider ID exists; the same idempotency key is safe to replay.

## Production Meta approval gate

Before enabling production connections, verify all of the following in the production Meta app:

- App mode is **Live**.
- Facebook Login for Business, Instagram API with Facebook Login, and WhatsApp Business Platform
  are configured for the app.
- Advanced Access/App Review is approved for the exact Meta Login permissions listed in the public
  Social Connections documentation.
- WhatsApp Embedded Signup is configured for `whatsapp_business_management` and
  `whatsapp_business_messaging`; add `business_management` only for a reviewed Solution Partner
  operation that needs it.
- The registered OAuth callback is `https://api.kasitek.co.za/api/social/oauth/meta/callback`.
- The WhatsApp webhook is `https://api.kasitek.co.za/api/webhooks/whatsapp` and the Meta messaging
  webhook is `https://api.kasitek.co.za/api/webhooks/meta`.
- The production `AUTH_META_APP_ID`, `AUTH_META_APP_SECRET`, `AUTH_META_SCOPES`, and webhook verify
  token belong to the same Live app.

Record the Meta App Review decision and configuration revision with the release evidence. This is
an external dashboard gate and cannot be completed by a repository commit.

When an agent returns a typed authorization requirement, the runtime carries it with the durable
response. Dashboard agent transcripts render **Grant access** or **Review access** using the
connection reference; WhatsApp, Telegram, Discord, and Core-backed delivery adapters append the
same provider-neutral recovery action while preserving their native formatting. Do not copy a
connection ID, provider scope, token, or raw provider error into a user message.

## LinkedIn and X

1. Reconnect through the provider OAuth action on `/connections`.
2. Confirm the provider returned the publishing scopes used by the connection.
3. For LinkedIn profiles, use the single **Connect** action. Publishing and media access are requested
   by default; member analytics and comment-management access remain visible but locked until the app
   receives the required Community Management approval.
4. For LinkedIn Company Pages, use **Sync Pages** after the app has Community Management access and `AUTH_LINKEDIN_SCOPES` includes `r_organization_admin` and `w_organization_social`. The signed-in member must have an approved Page publishing role.
5. If those organization permissions are unavailable, the profile connection should still complete and the UI will report that Page discovery is unavailable.
6. Treat repeated authorization or publishing failures as provider configuration issues until the account and app permissions are confirmed.

LinkedIn Page connections are stored as separate content channels with an organization actor URN.
The Content composer can select one connected Page for a LinkedIn destination and publish text or one
image through LinkedIn's Posts API. Page analytics, inbox, comments, and follower management are not
part of the current adapter.

## Threads

Threads deletion uses the account owner's `threads_delete` permission. If deletion is unavailable,
reconnect or use **Grant access** from the connection details and verify that the returned token
includes that permission. Threads post editing is not part of the adapter.

## Disconnect and revoke

- `DISCONNECTED` stops normal use but keeps the inventory record for diagnosis and reconnection.
- `REVOKED` records an explicit administrative revocation. Revoke the token at the provider as well when supported.
- Do not delete provider records to handle a temporary outage. Deletion removes the source record and the shared inventory will mark it missing.

## Recovery confirmation

1. Re-run the provider health check or OAuth flow.
2. Confirm `/connections` reports `CONNECTED` and the expected capabilities are enabled.
3. Test one low-risk action, such as loading templates or creating a draft. Do not start a live campaign as the first test.
4. Confirm inbound webhook delivery separately for messaging providers.
5. Record the cause, affected organisation, recovery action, and timestamps in the support ticket.
