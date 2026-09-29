# Agent platform plans and research

This directory contains the canonical Agent Platform implementation map plus its supporting
architecture assessments and research.

The source of truth for the upcoming Agent Platform restructure is
[`AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](./AGENT_PLATFORM_IMPLEMENTATION_PLAN.md). It supersedes
the earlier architecture plans as implementation direction. Other documents in this directory are
supporting inputs and research. Completed, parked, and deferred records from the former Growth
monorepo remain in the [Growth plan archive](https://github.com/Kasitek-Labs/kasitek-growth/tree/main/docs/plans).
They are historical evidence, not a parallel architecture or current work queue.

The memory work inside P08 has its detailed implementation authority in
[`AGENT_MEMORY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`](./AGENT_MEMORY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md).
It is a scoped package plan, not a second Agent Platform roadmap.

The visual integration of memory, context, capabilities, extensions, durable execution, and
Playground-to-Live promotion has its focused plan in
[`AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md`](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/plans/completed/AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md).
It consumes the runtime contracts and does not replace their ownership.

The canonical capability directory and managed extension work has its focused implementation plan
in [`AGENT_CAPABILITY_REGISTRY_AND_EXTENSION_SURFACES_IMPLEMENTATION_PLAN.md`](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/plans/completed/AGENT_CAPABILITY_REGISTRY_AND_EXTENSION_SURFACES_IMPLEMENTATION_PLAN.md).
It covers built-in tools, external connectors, skills, plugins, MCP servers, and user-created tools
without creating a second runtime or telemetry system.

The Hermes-aligned capability activation and Playground-to-Live lifecycle has its focused execution
plan in [`AGENT_HERMES_ALIGNED_CAPABILITY_LIFECYCLE_PLAN.md`](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/plans/completed/AGENT_HERMES_ALIGNED_CAPABILITY_LIFECYCLE_PLAN.md).
It owns registry-driven activation, progressive skill discovery, connection/plugin/MCP refresh, and
promotion of the tested capability snapshot to Live.

When a work package starts, link its implementation issue to the canonical package. Keep the
short checklist in the issue or current session and verification evidence in the pull request.
Older finished records remain in the [Growth Agent history archive](https://github.com/Kasitek-Labs/kasitek-growth/tree/main/docs/plans/completed/agents/).
