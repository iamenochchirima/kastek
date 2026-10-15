# Agent Platform technical documentation

Current architecture and delivery:

- [Platform architecture and both agent tracks](architecture/agent-platform-architecture.md)
- [Platform implementation checklist](plans/agents/AGENT_PLATFORM_DELIVERY_PLAN.md)
- [Initial React/Vite frontend checklist](plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md)
- [Filesystem personal runtime checklist](plans/agents/PERSONAL_AGENT_RUNTIME_PLAN.md)

Existing hosted-runtime contracts, to verify against the standalone checkout:

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

Decisions and reference material:

- [Plan index and retained source studies](plans/agents/README.md)
- [Runtime decision](adr/0001-agent-platform-runtime.md)
- [Durable execution decision](adr/0002-temporal-durable-execution.md)
- [Database ownership](adr/0003-agent-platform-database.md)
- [Threat model](THREAT_MODEL.md)
- [Client integration status](source-boundary.md)
- [MCP integration](mcp-integration.md)
- [Capability catalog](generated-capabilities.md)

Older rewrite roadmaps, overlapping plans and the Growth-hosted architecture audit have been removed.
Historical code and deployment claims in retained contracts/runbooks must be verified during the baseline phase; they do not establish current production readiness.

These documents describe the Agent service. Cross-product contracts that define Core behavior remain
with the owning product and link here where needed.
