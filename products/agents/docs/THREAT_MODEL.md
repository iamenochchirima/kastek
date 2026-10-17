# Agent Platform threat model

Status: implementation baseline; production security review still required.

This threat model describes the current service. Temporal references below are current-code
controls; the target business-agent runtime is self-hosted Restate. See the [platform
architecture](architecture/agent-platform-architecture.md).

## Trust boundaries

1. Browser and external channels are untrusted input. They can submit messages, webhooks,
   attachments, and replayed delivery events.
2. `kasitek-agents-api` authenticates callers and writes scoped records. It owns Agents organization authorization and validates shared-provider identities. Growth/Agency enforce authorization for their own product tools.
3. Temporal workflows carry current durable orchestration state; their database and external calls happen in activities. The target Restate runtime is not implemented. The Lina workspace integration is also not implemented, so its controls have not been verified in this service.
4. Labs Keycloak owns shared identity. Agents owns platform access; Growth Core and Agency enforce their respective business entitlements and consequential product actions.
5. Model providers, retrieved documents, tool results, and future MCP servers are untrusted
   content even when their transport is authenticated.

## Threats and controls

| Threat | Owner | Primary control | Residual work |
| --- | --- | --- | --- |
| Direct or indirect prompt injection | Agent Platform/Security | Retrieved content is marked untrusted; tool access is an explicit grant intersection; trusted tool instructions are separate from content | Adversarial regression suite |
| Excessive agency or broad tools | Agent Platform/Core | Versioned tool grants, risk classes, approval gates, argument hashes, and core-side authorization | Production kill switch and write-tool review |
| Cross-organization or cross-agent access | Agent Platform/Core | Organization predicates are required in repositories and internal core headers; installation/version scope is checked | PostgreSQL RLS review |
| Memory or knowledge poisoning | Agent Platform/Security | Provenance, source type, confidence, expiry, explicit inferred-memory policy, bounded URL ingestion | Poisoning detection and operator review |
| External identity takeover or channel pairing abuse | Channels/Core | Channel bindings are explicit records; provider identity is stored separately from installation scope | Pairing protocol and re-authentication UX |
| Replayed webhooks or duplicate messages | Channels/Agent Platform | Provider message identity uniqueness and run idempotency keys | Provider-specific signature verification |
| Approval replay or payload mutation | Agent Platform/Core | Approval decisions require the exact 64-character arguments hash and Temporal signal | Expiry and operator audit UX |
| Tool-result injection | Agent Platform/Security | Tool output is model-visible data, never policy; output schemas, bounded tool manifests, and compact domain projections are enforced | Per-tool output redaction review |
| Data exfiltration through models, tools, traces, or sandboxes | Agent Platform/Security | No provider master credentials in prompts; opaque credential references; content capture disabled by default; sandbox not enabled | Redaction pipeline and sandbox isolation |
| Denial of service or denial of wallet | Agent Platform/Billing | Bounded loops, wall-clock/token/tool limits, retry caps, cost attribution, and operational summaries | Per-org rate limits, circuit breakers, anomaly alerts |
| Compromised provider or third-party MCP server | Agent Platform/Security | Provider-neutral adapter boundary; no direct database access; narrow tool grants; external tools treated as untrusted | MCP authorization and provider outage drills |
| Support/operator abuse | Platform Operations | Organization-scoped APIs and audit records for control-plane changes | Sensitive-content access audit and retention policy |

## Required release gates

- Run adversarial prompt-injection, tool-abuse, memory-poisoning, and cross-scope suites against
  every publish candidate.
- Verify webhook signatures and provider-specific replay windows before enabling external channel
  effects.
- Complete PostgreSQL RLS, credential-manager, retention/redaction, and sandbox reviews before
  production agents can execute consequential or untrusted custom code.
- Treat an unreviewed model output as a proposal; the owning product must enforce authorization, with explicit approvals for actions whose policy requires them.

## Isolated Lina workspace scope

Personal assistance may use an isolated Lina workspace. Before enabling that path, verify workspace
and credential isolation, scoped tool grants, resource and network limits, task deduplication,
workspace deletion, and secret revocation. Model output and workspace files cannot grant new
authority.

Local Docker development does not prove production isolation for hostile code. Verify production
hosting before exposing code execution. The [platform architecture](architecture/agent-platform-architecture.md)
defines the current target.
