# ADR 0001: Agents platform runtime ownership

- Status: accepted direction; updated for the current product model
- Original date: 2026-08-11
- Updated: 2026-10-02

## Decision

The platform backend uses TypeScript on Node.js. API, gateways and workers are separate process types in the same repository and share platform contracts.

API-based agents execute through shared bounded workers or Temporal for durable work. Authoritative hosted product state lives in the Agents database.

Personal agents use our separately built filesystem-based runtime. The platform deploys and manages its isolated environment and persistent workspace, tools, channels, limits and activity. The runtime language/image and production host remain implementation decisions; Hermes/OpenClaw are references, not adopted dependencies.

Labs owns shared human authentication through Keycloak. Agents owns its organizations, memberships, sessions and platform authorization. Growth Core and Agency own their business data and enforce access to their product tools. Agents never queries their databases directly.

## Consequences

Scale platform processes and execution pools independently. Persist user workspace data across personal runtime restarts; do not confuse filesystem persistence with safe task recovery. Use scoped authenticated interfaces for product tools and runtime communication.

Kubernetes and a specific production environment provider are not selected. The [platform architecture](../architecture/agent-platform-architecture.md) and [delivery plan](../plans/agents/AGENT_PLATFORM_DELIVERY_PLAN.md) define current scope.
