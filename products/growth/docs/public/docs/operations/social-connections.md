---
title: Social Connections
---

# Social Connections

## Facebook Pages

Choose **Connect Facebook**, select the access needed, then continue to Meta to choose
the Pages for this workspace. Publishing requests Page publishing and engagement-read
permissions. Page tasks such as `CREATE_CONTENT` are account evidence and are not sent
as OAuth permission names. Completing sign-in alone does not establish Page publishing
access; check the returned Page and its permissions after connection.

Facebook connection also requests `business_management` for business asset discovery.
Existing connections need reauthorisation to add this permission.

Each authorised Page appears as a separate connection. Growth reads every result batch
returned by Meta. To add Pages, choose **Connect Facebook** again and use **Edit settings**
in Meta to review the Page selection. Continuing with previous settings keeps the existing
authorisation. Pages without a usable Page access token cannot be imported.

### Editing content

Choose **Edit post** for a draft or scheduled post to change its text and media, then
**Save changes**. Published Facebook-only posts have a separate text/caption editor with
**Update on Facebook**. This updates the existing Facebook post. A single photo can be removed with **Remove photo**;
**Undo** restores it before saving. Replacing or adding published media is not supported, and
the destination remains unchanged. Other published platforms and processing posts cannot be edited here.

## LinkedIn Company Pages

Open **Connections** and select **Connect** under LinkedIn. After one LinkedIn authorization, KasiTek
imports the member profile. When organization access is enabled for the app, **Sync Pages** imports
the Company Pages for which that member has approved publishing access. Each Page appears as its own
LinkedIn channel.

In **Content**, select the Page as the LinkedIn destination. The current LinkedIn adapter supports
public text posts and one image per post. Personal profiles remain available as a separate LinkedIn
channel.

### Requirements

- Profile connection: OpenID and member publishing access.
- Page connection: Community Management API access, organization scopes, and an approved Page publishing role.

If no Pages are found, reconnect after confirming the member's Page role and the app's organization
permissions in the LinkedIn developer portal.

## Connection access

Open a connected account to view its access by feature. KasiTek separates provider access from
connection health, so an account can be healthy for publishing while missing access for analytics,
messaging, comments, or content management.

Use **Grant access** to request additional access for an existing account. This updates the current
connection and does not remove its drafts, published-post history, or agent assignments. The access
selection is limited to permissions supported by that provider and connection type. Some providers
use a fixed consent or setup flow instead of individual permission checkboxes.

Additional access is additive. When a provider replaces OAuth tokens during reauthorization,
KasiTek includes the connection's existing verified access in the new request. If the provider
returns a narrower scope set, KasiTek rejects the update instead of silently removing access.

For LinkedIn, publishing and media access are currently available. Member analytics and comment
management remain visible in the access sheet but are locked until the app receives Community
Management approval.

WhatsApp uses Embedded Signup for setup and reauthorization. Its access action opens Meta's setup
flow rather than presenting arbitrary permission checkboxes. A successful token grant is not enough
to report messaging as ready: the selected WABA, phone number, and webhook subscription must also
be valid.

Direct Instagram Login does not provide published-media deletion. The Access section reports that
capability as unsupported; reconnecting the same direct-login connection cannot add it.

Threads supports publishing and deleting posts owned by the connected account. Select **Delete
published content** when connecting or request it later from the connection details. Editing Threads
posts is not supported through this capability.

Bluesky supports publishing and deleting posts owned by the connected account. Both actions use the
account's `repo:app.bsky.feed.post` grant; the access panel reports deletion as requestable or
granted instead of unsupported. **Use media** requests the additional `blob:*/*` grant for image
uploads. The public OAuth metadata declares this scope, but the initial connection does not request
it.

Bluesky messaging is not supported. It is shown as unavailable and is not included in Bluesky
authorization requests.

TikTok's initial connection requests only `user.info.basic`; the optional access boxes start
unchecked. Request **Publish content**, **Use media**, or **View analytics** during connection or
later from the connection details when the TikTok app has the matching approved scope. Direct
publishing uses `video.publish`; draft upload uses `video.upload`; profile statistics use
`user.info.stats`.

## Multi-destination publishing

You can save and edit a platform draft before connecting an account. Choose **Draft for Facebook**
(or another platform) in the composer. Select a connected account for every destination before
scheduling or publishing.

In **Content**, a draft can target multiple connected accounts. The Agent or composer checks every
selected account first, shows any missing access, unsupported capability, connection issue, content
limit, or media issue, and asks for one approval covering the complete target set. Platform-specific
variants must be prepared before approval; Core does not silently rewrite an approved variant.

The publish result is tracked per account. After approval, the client or Agent reads the durable
batch status and reports confirmed publications plus every target that failed or needs attention. A
provider timeout is shown as unconfirmed rather than as a safe retry; check the batch status or
provider record before trying again. Accounts already confirmed as published are excluded from a
later retry. For a confirmed failure, use the batch retry action to retry the failed destinations
together; unconfirmed outcomes require provider reconciliation first.
The first release supports immediate batch publishing; scheduled cross-provider batches remain
separate.

## Current publishing formats

These are the formats implemented by Growth's current adapters, subject to account permissions
and preflight. They do not describe every format a provider may support.

| Destination | Growth formats |
| --- | --- |
| Facebook | Text; one image |
| Instagram | One image with caption |
| Threads | Text; one image |
| TikTok | Video or photo through the supported upload/HTTPS media flow |
| LinkedIn | Text; one image |
| X | Text; up to four images |
| Bluesky | Text; up to four images |

Use preflight for actual text/media limits and account readiness. A successful connection does
not verify publication, analytics, comments or messages. Live provider acceptance is recorded
separately for each platform and format.

## Production Meta configuration

The production Meta app must be Live and have Advanced Access approved through App Review for every
permission used by the deployed flows. Add the real production URLs to the Meta app and keep the
configuration aligned with the Core environment:

```text
Client build:
NEXT_PUBLIC_META_APP_ID=<the same Live Meta app ID as Core>
NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID=<the Live Embedded Signup configuration ID>

Facebook Login callback:
https://api.kasitek.co.za/api/social/oauth/meta/callback

WhatsApp Embedded Signup webhook:
https://api.kasitek.co.za/api/webhooks/whatsapp

Facebook and Instagram messaging webhook:
https://api.kasitek.co.za/api/webhooks/meta
```

For Meta Login, the production permission set is:

```text
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
```

Meta Login Instagram published-content deletion requires `instagram_manage_contents` and the
appropriate Instagram account access. Direct Instagram Login does not currently expose an
equivalent deletion permission.

Configure the corresponding product permissions in the Embedded Signup configuration:

```text
whatsapp_business_management
whatsapp_business_messaging
```

Request `business_management` only when the Solution Partner flow actually performs business
portfolio operations that require it. Do not add it to the consent configuration merely to make
the permission list look complete. The Meta app review submission must show the real user flow for
each requested permission. A code release cannot complete this external approval gate.
