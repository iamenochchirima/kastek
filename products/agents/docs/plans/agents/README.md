# Agent platform plans

Updated: 2026-10-02.

- [Platform delivery plan](AGENT_PLATFORM_DELIVERY_PLAN.md) is the only platform implementation checklist. It covers API-based agents, the shared Agents/Growth live inbox in phases 6A/6B, and deployment/management of our filesystem-based personal runtime.
- [Initial frontend implementation](FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md) is the first bounded task: React/Vite migration, Growth-style app shell, landing page and one real agent journey.
- [End-to-end implementation](END_TO_END_IMPLEMENTATION_PLAN.md) is the next bounded checklist: finish real execution, connect knowledge/tools, deploy website chat and operate the Agents inbox, then verify one existing messaging adapter. It expands selected platform stages without replacing the roadmap.
- [Personal runtime work](PERSONAL_AGENT_RUNTIME_PLAN.md) is the separate linked checklist for building that runtime and its platform interface. Its items do not change the platform delivery order.
- [Platform architecture](../../architecture/agent-platform-architecture.md) defines module ownership, execution options, storage and product integration.

Pinned technical references, not active plans:

- [Hermes context and telemetry study](HERMES_CONTEXT_AND_RUNTIME_TELEMETRY_RESEARCH.md).
- [Hermes and Waku memory study](HERMES_WAKU_MEMORY_RESEARCH.md).

The earlier rewrite roadmap, superseded architecture plans, broad comparison studies and old Growth-hosted architecture audit have been removed. Their tracked versions remain recoverable from Git history. Useful current contracts and runbooks remain under docs/architecture and docs/runbooks.

Reuse functioning code; establish current runtime evidence before replacing it. Work one phase at a time, keep verification focused and record outcomes in the delivery plan. Do not create issue boards or additional umbrella plans.
