---
title: Agent runtime host boundary
owner: agent-platform
last_reviewed: 2026-09-29
---

# Agent runtime host boundary

The Agent Platform owns agent execution. A host supplies scoped capabilities. Runtime code does
not choose an organization, installation, credential, or host from model arguments.

## Current implementation

The runtime implementation lives in this repository:

- [`ExecutionScope`](../../src/runtime/execution-scope.ts) is the canonical run identity.
- [`AgentHarness`](../../src/runtime/harness.ts) is the narrow model-loop composition surface.
- [`HostCapabilityRouter`](../../src/hosts/capabilities.ts) returns typed succeeded, denied,
  unavailable, and failed outcomes.
- [`CoreHostAdapter`](../../src/hosts/core-host-adapter.ts) owns the first migrated Core
  capability: `kasitek.core.workspace_status`.
- [`NativeHostAdapter`](../../src/hosts/native-host-adapter.ts) owns the Core-free
  `platform.current_time` capability.
- [`TenantHostFixtureAdapter`](../../src/hosts/tenant-host-fixture.ts) is the local conformance
  host for organization and installation checks.
- Migration `110_agent_run_identity_and_extension_snapshots.sql` pins an optional extension
  snapshot reference on versions and admitted runs and prevents immutable run identity changes.
- [`execution-evidence.ts`](../../src/runtime/execution-evidence.ts) adds the canonical scoped
  identity to durable execution events.
- [`AgentSpec`](../../src/domain/agent-spec.ts) is the typed authoring boundary for a profile-first
  agent. Workflow graphs are optional; the normal hosted path is an agent profile, capability
  grants, and a pinned version.
- Temporal child activation creates an idempotent child run for the requested hosted version and
  nests the normal `agentRunWorkflow`. Child capability and resource grants are attenuated before
  admission and applied again when the child loop builds its execution scope.

HTTP and Temporal composition roots construct the same host-capability seam. The selected workspace
status tool no longer calls the broad Core client directly when it runs through the production
composition roots. Other Core tools remain outside this first migrated slice and are intentionally
the next capability-family work rather than an undocumented exception to the boundary.

## Scope projection rules

`ExecutionScope` is created from the persisted run. Memory and knowledge receive only the derived
resource projection from that scope. Tool handlers receive a context containing the same scope; the
effective grant set is attached before a model or tool operation is admitted. Durable run events
derive their identity from the run row and verify organization, run, and installation together
before writing evidence.

Host adapters may return only bounded typed results. The router handles missing grants, host
assignment mismatch, unavailable hosts, invalid arguments, and host errors without exposing raw
provider errors or credentials to the model.

## Admission policy and Playground boundary

Same-session admission uses a durable lease with bounded queue policy, fencing tokens, and explicit
`queued`, `limited`, and stale-owner outcomes. The in-memory adapter remains the fast conformance
implementation; PostgreSQL and Temporal failure matrices are still release-gated.

The creation flow writes `settings.environment = "playground"` on a pinned installation. The
Playground UI only starts runs against that installation and consumes the same durable run/event
APIs as other hosts. The Agent API exposes paired Playground/Live deployment status, non-mutating
Live preflight, idempotent target-scoped promotion, and rollback evidence. Full environment binding
isolation—separate credentials, data namespaces, and allowlisted destinations—remains an open
implementation item; the setting must not be treated as proof of resource isolation by a provider
or channel adapter.

## Verification

The boundary is covered by host adapter contract and tenant-isolation tests; execution-scope,
event-identity, admission, migration, and effective-config tests; composition checks that keep Core
construction out of runtime modules; and Core capability, immediate-read, decomposed-activity, API,
and local parity tests. Run the focused checks for the changed boundary, then the Agents package
build and relevant suite before release.

No remote deployment is implied by this source relocation. Hosted/runtime checks remain separate
release gates.
