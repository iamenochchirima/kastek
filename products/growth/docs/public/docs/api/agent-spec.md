---
sidebar_position: 3
---

# Agent specification

The standalone Agents product now uses its own configuration and immutable versions for website
FAQ agents. The initial configuration contains instructions, approved knowledge, and bounded
model settings. Delegation, sandboxes, business-action tools, workflows, and schedules are disabled.

Use the Agents configuration, test, and publication interface. The current setup and implementation
limits are documented in `products/agents/README.md` and `products/agents/docs/source-boundary.md`
in the repository. The former `specVersion` request format and version-management endpoints on
this page belonged to the deleted backend and are no longer supported.

Growth product execution and standalone Agents configuration are separate contracts. External
clients can use the supported [Growth REST API](./public-v1.md) or [OAuth MCP](./mcp-integration.md)
when enabled by the deployment. Both use Growth's canonical operation schemas and exact-review rules.
