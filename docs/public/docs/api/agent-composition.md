---
sidebar_position: 4
---

# Agent composition

## Skills

Skills are reusable, versioned instruction packs. Create a skill with
`POST /v1/skills`, add a version with `POST /v1/skills/{skillId}/versions`, and publish the
version before pinning it to an agent version:

```http
POST /v1/agent-versions/{agentVersionId}/skills/{skillVersionId}
```

Only published, organization-scoped or platform-owned skill versions can be pinned. At runtime,
the platform matches pinned skills against the request's channel, audience, capabilities, and
declared keywords or phrases. The matching is deterministic and the rendered instructions are
bounded by the agent context budget.

## Remote MCP providers

Remote MCP providers are reviewed before hosted agents can use them. The lifecycle is:

1. Create the provider with its HTTPS endpoint and an opaque credential reference.
2. Discover and inspect its bounded tool manifest.
3. Publish the discovered revision.
4. Pin that revision to an agent version.

Only pinned published schemas are registered. Calls re-check organization scope, provider and
revision status, HTTPS/private-network rules, timeouts, response limits, approval requirements,
redaction, credentials, and the provider rate guard. Provider secrets remain in the encrypted
credential store and are never placed in an agent prompt.

Discovery and explicit health checks record a bounded provider health projection. Publishing and
pinning require a successful health check, and known-unhealthy providers are excluded from runtime
tool registration. Probe an existing provider without creating a new revision with
`POST /v1/mcp/providers/{providerId}/health`.

Inbound MCP OAuth is not part of this release; existing API-key and installation-credential flows
remain the supported provider authentication paths.

## Draft evaluation

Create a scenario with `POST /v1/evaluations/scenarios`, then call
`POST /v1/evaluations/scenarios/{scenarioId}/draft-runs` with an `agentVersionId`. The evaluator
uses one bounded model call and deterministic assertions. It does not deliver to channels, create
a live run, load tools or remote MCP providers, or read or write live memory. The result records
`execution_mode: "draft"` and explicit isolation evidence.
