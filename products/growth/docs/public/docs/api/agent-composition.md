---
sidebar_position: 4
---

# Agent composition

The initial standalone Agents journey supports knowledge-backed website FAQ agents. Its versions
pin instructions, approved knowledge, and model limits. Skills, plugins, delegation, sandboxes,
business-action tools, workflows, and schedules are not available in this initial journey.

The former skill, plugin, provider-pinning, and version-diff endpoints belonged to the deleted
Agent Platform backend. They are no longer an operating guide for the new product.
See `products/agents/README.md` in the repository for its current interface and local setup.

Growth's shared-execution integration is not implemented yet. Existing Growth business operations
remain accessible through the [Growth REST API](./public-v1.md) with a workspace Developer API key.
Product OAuth MCP is unavailable.

The wider capability and runtime design is recorded in
`products/agents/docs/architecture/agent-platform-architecture.md` in the repository. That design
does not establish additional shipped composition features.
