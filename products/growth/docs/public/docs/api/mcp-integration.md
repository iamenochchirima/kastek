---
title: MCP integration
owner: engineering
last_reviewed: 2026-10-23
---

# MCP integration

Growth product OAuth MCP is unavailable. External agents can use supported
[Growth REST operations](./public-v1.md) with a scoped workspace Developer API key.

Embedded Growth agents use Growth's authenticated backend and the shared execution service.
They do not use an external MCP connection or require a standalone Agents account.

Outbound MCP connections configured in standalone Agents belong to that product. Its current
setup and supported adapters are documented in products/agents/README.md and
products/agents/docs/mcp-integration.md in the repository. The retired Growth installation,
Studio callback and local bridge instructions are not supported.
