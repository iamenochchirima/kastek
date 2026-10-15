---
sidebar_position: 3
---

# Agent specification

Create a hosted agent version with a typed specification by sending `{ "spec": { ... } }` to
`POST /v1/agents/{agentId}/versions`.

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

The specification is strict and versioned. Unknown fields are rejected. Optional sections receive
bounded defaults; runtime limits, memory access, tools, channels, skills, and model fallback
behavior are stored with the immutable agent version.

The legacy `{ "instructions": ..., "configuration": ..., "policy": ... }` request remains
available for existing clients. New integrations should use `spec` so the contract can be
validated and evolved explicitly.

The requested tool list is still checked against the platform registry and installation grants.
User configuration cannot grant a tool that the platform or installation does not permit.

For customer-facing agents, factual questions are answered from the agent's configured knowledge
or trusted tool results. If no approved evidence is available, the runtime returns a limitation
response instead of asking the model to fill the gap from general knowledge. Greetings and
action-oriented requests continue through their normal response or tool flow.

## Draft evaluation

Create a scenario, then test a draft or published candidate without delivering a message or
changing live memory:

```http
POST /v1/evaluations/scenarios/{scenarioId}/draft-runs
```

```json
{
  "agentVersionId": "00000000-0000-4000-8000-000000000000",
  "evaluatorVersion": "deterministic-v1"
}
```

The candidate receives the scenario input as a model prompt. Draft evaluation does not load tools,
remote MCP providers, knowledge, or memory, and does not create a live agent run or channel
delivery. Assertions are evaluated against `{ "text": "..." }`; the result records usage and
explicit isolation evidence.
