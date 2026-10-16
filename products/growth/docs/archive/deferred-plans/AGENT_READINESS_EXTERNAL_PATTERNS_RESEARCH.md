# Agent Action Readiness: External Patterns

**Status:** Research note

**Date:** 2026-09-01

**Purpose:** Compare the action-readiness problem in KasiTek with established agent-runtime
patterns. This note is research only and does not change runtime behavior.

## Findings

### 1. Tool discovery is advisory; execution checks are authoritative

MCP separates `tools/list` discovery from `tools/call` execution. Tool names, descriptions, and
schemas help the model choose a tool, but the server still owns invocation and returns a structured
result. Tool-originated errors are represented in the tool result with `isError: true`, while missing
tools or unsupported protocol operations are protocol errors.

Source: [MCP schema: tools/list and tools/call](https://modelcontextprotocol.io/specification/2025-06-18/schema#tools-list)

**KasiTek implication:** capability catalogs and agent context should prevent predictable bad calls,
but Core must re-resolve the target and enforce action readiness immediately before an external effect.

### 2. Checks belong at the tool boundary, not only at the agent boundary

The OpenAI Agents SDK distinguishes agent-level guardrails from tool guardrails. Tool input
guardrails run for each function-tool invocation and can reject, replace the result, or raise a
tripwire that halts execution. The SDK also supports dynamic tool enablement and per-tool approval
and timeout settings.

Sources: [tool guardrails](https://openai.github.io/openai-agents-python/guardrails/),
[tool reference](https://openai.github.io/openai-agents-python/ref/tool/)

**KasiTek implication:** installation grants and model instructions are not enough. The final Core
provider boundary needs a deterministic readiness gate, with a distinct terminal outcome for a
known-blocked action.

### 3. Retry only errors that are actually recoverable

LangGraph models retries, timeouts, error handlers, and interrupts as different mechanisms. Retry
policies can be limited by exception type and attempt count; exhausted failures can be routed to a
controlled recovery or compensation path. Human interrupts bypass retry/error handling and resume
from a persisted checkpoint.

Sources: [LangGraph fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance),
[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

**KasiTek implication:** unsupported, missing permission, invalid target, and policy-denied results
must never enter an automatic retry loop. Transient provider/network failures may retry only when
the operation is safe and idempotent. A provider call whose outcome is uncertain must be represented
as unknown and must not be blindly repeated.

### 4. Durable systems make “waiting” explicit

LangGraph persists interrupted state and resumes it using the same thread/checkpoint identity.
Temporal separates activity timeouts, retry policies, and heartbeats; a missed heartbeat can cause a
retry according to policy, while cancellation is delivered through the activity runtime.

Sources: [LangGraph durable interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts),
[Temporal activity timeouts and heartbeats](https://github.com/temporalio/documentation/blob/main/docs/develop/typescript/activities/timeouts.mdx)

**KasiTek implication:** approval-waiting, user-remediation-waiting, provider retrying, and terminal
failure need separate durable states. A blocked readiness result must complete or explicitly pause
with a persisted reason; it must not look like a worker that is still waiting for a provider.

### 5. Error handling needs two audiences

Agent runtimes commonly keep machine-readable error metadata for the orchestrator while formatting
a bounded, human-readable message for the model or user. OpenAI's SDK supports custom tool error
formatting and explicit behavior for unknown tools; MCP provides structured content plus an error
flag.

Sources: [OpenAI run error handling](https://openai.github.io/openai-agents-python/running_agents/),
[MCP tool results](https://modelcontextprotocol.io/specification/2025-06-18/schema#calltoolresult)

**KasiTek implication:** retain a typed internal readiness/outcome envelope, then project a safe
message for the model, durable transcript, gateway, and operator telemetry. Provider scopes,
credentials, raw URLs, and internal IDs should not be required for the user-facing projection.

## Recommended KasiTek shape

Use a consistent lifecycle:

```text
discover tool
  -> resolve target and connection
  -> evaluate installation/policy/provider action readiness
  -> approval, when required
  -> repeat authoritative readiness check
  -> execute provider effect
  -> classify success, recoverable failure, or uncertain outcome
```

The readiness check should distinguish at least:

- known supported and ready
- unsupported for this provider/auth mode
- missing provider access
- not configured or unhealthy
- unknown and unable to verify
- invalid or unavailable target
- policy or installation denial

Only recoverable failures should retry. Known-blocked actions should produce one durable terminal
result with an actionable remediation, while successful provider effects and uncertain effects must
remain distinct.

## Release impact

Not applicable: this is a research note only; it does not change application behavior, APIs, data,
observability, or deployment configuration.
