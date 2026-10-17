# Agents documentation

The current business harness supports contextual conversations, reviewed personal
memory, pinned skills, bounded tool rounds, and recorded compaction. Optional
delegation, isolated analysis, reviewed report delivery, and durable automation are opt-in. These documents describe the maintained
implementation and boundaries:

- [Platform architecture](architecture/agent-platform-architecture.md): target contracts and execution categories.
- [Implementation boundary](source-boundary.md): current modules, verification, and remaining work.
- [Platform login](architecture/platform-login.md): identity, sessions, and product authorization.
- [Integration boundaries](mcp-integration.md): external MCP and future product connections.
- [Threat model](THREAT_MODEL.md): enforced controls and release limits.

Use the [product setup](../README.md) to run the application and the
[runtime reference](../../../infra/agents-runtime/README.md) for Restate diagnostics.
Settled requirements and implementation checklists remain in the linked Linear
specifications in the architecture document. Deleted operational notes remain in
Git history.
