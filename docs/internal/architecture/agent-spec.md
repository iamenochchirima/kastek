---
id: agent-spec
title: AgentSpec contract
sidebar_position: 8
---

# AgentSpec contract

Hosted agent versions may be created with a strict, versioned `AgentSpec` request. The API accepts
the typed shape as `{ "spec": { ... } }` and compiles it into the existing immutable
`instructions`, `configuration`, and `policy` version fields.

## Version 1

The contract has these sections:

- `specVersion`: must be `1`.
- `identity`: optional display name, purpose, and audience metadata.
- `behavior.instructions`: the agent instructions.
- `model`: the versioned primary model policy and bounded fallbacks.
- `runtime`: context, iteration, model-call, tool-call, token, wall-time, cost, and temperature limits.
- `capabilities`: requested hosted tools and required capability names.
- `knowledge`: knowledge source and connection references.
- `memory`: mode, namespaces, types, retrieval/write limits, retention, and sensitivity policy.
- `skills`: organization- or platform-owned skill IDs. Published skill revisions are pinned to the
  agent version and matched deterministically at runtime before their bounded instructions are
  added to context.
- `workflow`: an optional validated workflow graph.
- `channels`: allowed channel identifiers.
- `release`: the installation release mode.

Every owned section is strict. Unknown keys fail the request, including keys nested inside the
sections. Workflow node `config` remains an intentional extension point because workflow nodes
already have their own versioned graph contract and executor validation.

## Compatibility and compilation

Existing requests using `{ "instructions": ..., "configuration": ..., "policy": ... }` remain
accepted for compatibility with existing clients and templates. Existing database rows are not
rewritten. New typed versions store a canonical `agentSpec` snapshot and `specVersion` in
`configuration`; the runtime-facing fields are compiled alongside it.

The repository still applies hosted-tool grants and platform safety checks after compilation. The
requested tool list in the spec is therefore not an authorization bypass: the effective list in
the persisted policy and grants is the result after those checks.

## Example

```json
{
  "spec": {
    "specVersion": 1,
    "behavior": {
      "instructions": "Answer from the supplied knowledge and say when it is insufficient."
    },
    "model": {
      "version": "2026-01",
      "primary": {
        "provider": "openrouter",
        "model": "openai/gpt-4.1-mini"
      }
    },
    "capabilities": {
      "allowedTools": ["platform.current_time"]
    },
    "memory": {
      "mode": "explicit",
      "maxRetrieved": 4
    }
  }
}
```

Remote MCP providers are separately reviewed and versioned. Discovery stores a bounded immutable
tool manifest; only approved provider revisions pinned to the agent version can register tools,
and calls use scoped credentials, HTTPS/private-egress checks, timeouts, output redaction, approval,
and a durable per-provider rate guard. Discovery and explicit health checks also record bounded
reachability, latency, a stable failure code, and consecutive failures. A provider must be healthy
before publication or pinning, and known-unhealthy providers fail closed at invocation.

Draft evaluation is available at
`POST /v1/evaluations/scenarios/{scenarioId}/draft-runs`. It executes one candidate model call
against the scenario, with no tools, remote providers, live run, channel delivery, knowledge load,
or memory read/write. The persisted evaluation row is marked `execution_mode: "draft"` and the
database rejects a draft row with a live `run_id`. Existing `/runs` remains the observed-output
recording path for live evidence.
