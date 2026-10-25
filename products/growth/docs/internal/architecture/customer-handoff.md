---
title: Customer conversation ownership
owner: engineering
last_reviewed: 2026-10-23
---

# Customer conversation ownership

Standalone Agents owns customer agent deployments and automation/human ownership in its shared
Inbox. Its [current architecture](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/architecture/agent-platform-architecture.md)
and [source boundary](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/source-boundary.md) describe the supported
handoff transitions and delivery checks.

Growth's human Inbox remains a Growth business function. Its provider ingress, messages,
attachments, receipts and staff replies do not dispatch agent work through the removed
installation bridge. Connect customer automation through an explicit Agents deployment instead.

The Growth general assistant is a staff feature with Growth-scoped permissions. It does not
automatically join a customer conversation or inherit a customer channel's authority.
