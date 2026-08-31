---
title: Social Connections
---

# Social Connections

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

For Instagram published-post deletion, use the Instagram connection's Meta Login access flow. A
direct Instagram Login connection does not provide that capability; the connection details will
offer **Switch to Meta Login** when that upgrade is available.
