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

## Customer handoff

Customer-service agents use a two-step handoff flow:

- A customer’s clear request for a person creates a handoff request immediately.
- When an agent cannot help, it records an offer and asks the customer. Only an explicit yes or a structured confirmation creates the request.
- A no, ambiguous reply, or expired offer does not change conversation ownership.

Until a request is created, the conversation remains agent-owned. Once created, it appears in the handoff queue and automated replies stop until an operator resolves or continues the conversation.

An inbound API response for a confirmed handoff includes `status: "handoff_requested"`, the durable `handoffRequestId`, and no agent `runId`. If another message arrives while that handoff is pending or claimed, the response is successful with `status: "handoff_active"` and the same request ID; no second agent run is created. Ordinary agent-owned messages continue to return a run ID.

The customer receives a conversational acknowledgement that the request was sent. Website Chat displays this immediately and waits for a human reply; external channel acknowledgements are recorded as delivery attempts so failed sends can be investigated and replayed. If an older active handoff is missing its acknowledgement, the next inbound message can safely queue or retry it without creating another handoff.

## Operator handoff console

Customer-service operators work from four views:

- **Inbox** contains unclaimed handoff requests.
- **Mine** contains requests assigned to the current operator.
- **Team** contains requests assigned to another operator.
- **All** contains customer conversations, including conversations without an active handoff.

The operator actions have separate meanings:

- **Take over** assigns a pending request to the current operator.
- **Send reply** sends a message and reports its delivery state separately from handoff resolution.
- **Return to queue** removes the current assignment without restarting the agent.
- **Resume agent** ends human ownership and allows the agent to continue.
- **Resolve conversation** closes the current human interaction without starting an agent reply.

Queue counts, handoff state, transcript changes, and delivery updates are refreshed from server events. The client reconnects and reconciles against the authoritative conversation APIs if the event stream is interrupted. A resolved customer thread can be reopened by a later inbound message, which starts a new agent-owned interaction on the same provider thread.
