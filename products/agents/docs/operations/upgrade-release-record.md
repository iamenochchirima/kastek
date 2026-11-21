# Platform upgrade release record

```text
Change: Product-independent Agents platform upgrade (checklist sections 1-9)
Owner: iamenochchirima
Risk: high
Affected services and user surfaces: Agents API, worker, standalone web UI, application HTTP API, MCP server
Platform release version or release ID: branch codex/agents-platform-upgrade; no production release
API/schema/migration changes: application capability scopes (162), application signing keys and delegations (163), declarative workflow revisions (164); all additive
Feature flag or rollout method: worker roles and pool labels; no production rollout without owner approval
Analytics events and success metrics: not applicable (no new product analytics events)
Logs, metrics, dashboards, and alerts: agents.worker.invocations, agents.usage.tokens by tenant, connected provider attempts and throttling, capacity/dispatch queue age, database lock waiters
User, API, internal, and operational documentation: application-api.md, mcp-integration.md, shared-runtime.md, consumer-retirement.md
Validation evidence: API typecheck; 517-file boundary check; API build and web production build pass; focused API/MCP/context/capacity suites; live Restate restart and context runs; independent client and browser task-activity proof; 100-root/2-replica mixed load accepted under worker-loss and provider-throttle
Rollback or disable plan: deploy the previous commit; migrations are additive and no destructive reset was applied; disable MCP with AGENTS_MCP_ENABLED=false
Post-release review date: after the owner approves and completes a production rollout
```

## Release decisions

- Production release, production migration and push are **not authorized** by this record.
- The 100-root/2-replica mixed load met its declared targets under both a worker restart and a
  provider limit; physical-call attribution matched every native operation. The measured
  limiting resource was API CPU, not the provider.
- Growth's core conversation and run path now uses the signed product agent gateway
  `/internal/v1/products/growth/agent-gateway`; Growth-owned extensions use the namespaced
  envelope at `/internal/v1/products/growth/extensions`. The gateway no longer translates
  shared commands into the Growth command DTO. Growth provisioning sends
  `agents.applyPublication` through `/internal/v1/products/:product/lifecycle`; a fresh
  isolated PostgreSQL run exercised the authenticated lifecycle endpoint. Internal adapter
  and feature-to-agent cleanup remain in KAS-316. Agency is deferred by owner decision and is not part of this plan.
- Archive and restore remains an owner functionality decision; it is not a cutover prerequisite
  in this inventory.
- Consumer cutover and deletion of retired routes are follow-on work; see
  `architecture/consumer-retirement.md`.
