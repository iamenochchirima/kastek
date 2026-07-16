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

## Facebook and Instagram

1. Reconnect through Meta OAuth from `/connections` when credentials are expired or permissions changed.
2. Confirm the expected Page and Instagram professional account were returned by Meta.
3. Confirm required Page, messaging, publishing, and Instagram permissions are approved for the app and granted by the customer.
4. Confirm `META_WEBHOOK_VERIFY_TOKEN` or `AUTH_META_WEBHOOK_VERIFY_TOKEN` matches the Meta webhook subscription.

## LinkedIn and X

1. Reconnect through the provider OAuth action on `/connections`.
2. Confirm the provider returned the publishing scopes used by the connection.
3. Treat repeated authorization or publishing failures as provider configuration issues until the account and app permissions are confirmed.

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
