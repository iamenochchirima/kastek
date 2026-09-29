# Agent Platform technical documentation

Current service architecture and contracts:

- [Runtime/Core host boundary](architecture/agent-runtime-host-boundary.md)
- [AgentSpec](architecture/agent-spec.md)
- [Conversation ordering](architecture/conversation-ordering.md)
- [Workflow execution and durable sessions](architecture/workflow-execution.md)
- [Memory lifecycle](architecture/memory-lifecycle.md)
- [Tenant isolation inventory](architecture/tenant-isolation-inventory.md)

Operations and recovery:

- [Approval observability](operations/approval-observability.md)
- [Memory observability](operations/memory-observability.md)
- [Approval-group migration and rollback](runbooks/approval-group-migration-rollback.md)
- [Capability-awareness local verification](runbooks/capability-awareness-local-verification.md)
- [Database isolation](runbooks/database-isolation.md)
- [Memory recovery](runbooks/memory-recovery.md)
- [Memory safety response](runbooks/memory-safety.md)
- [Remote MCP provider operations](runbooks/remote-mcp-provider-operations.md)
- [Temporal recovery](runbooks/temporal-recovery.md)

These documents describe the Agent service. Cross-product contracts that define Core behavior remain
with the owning product and link here where needed.
