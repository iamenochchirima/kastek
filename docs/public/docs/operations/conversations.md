---
title: Conversations
---

# Conversations

Conversation support currently exists most clearly in the client-facing portal.

## Client-scoped access

Client users can currently:

- list conversations associated with their client account
- open a conversation detail page
- list messages for that conversation

The backend explicitly verifies that the requested conversation belongs to the authenticated client account before returning data.

## Current conversation fields

The conversation APIs currently expose:

- channel
- customer identifier
- customer name
- status
- metadata
- last message timestamp

Messages currently expose:

- sender role
- content
- metadata
- created timestamp

## Tenant-side status

The tenant backend also includes tenant-level conversation routes, but the current tenant staff navigation does not yet expose a dedicated conversation hub in the main sidebar.

So today, conversation visibility is strongest in:

- dashboard activity
- client portal views
