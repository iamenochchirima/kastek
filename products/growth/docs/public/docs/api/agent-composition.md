---
sidebar_position: 4
---

# Agent composition

Growth owns its general assistant, Research, Content and Campaign feature definitions. These use
the shared Agents business execution category with explicit configured capabilities and current
Growth resource permissions. Their names do not create separate runtime engines.

The standalone Agents product owns customer-service agent setup, published website widgets,
messaging deployments and shared customer Inbox. Its current capability support and setup are
documented in products/agents/README.md in the repository.

External clients use the [Growth REST API](./public-v1.md) with scoped Developer API keys.
Product OAuth MCP and retired installation-management endpoints are unavailable.
