# Agent Tool Action Readiness

**Status:** Draft

**Owner:** Platform integrations and Agent Platform

**Last updated:** 2026-09-01

## Objective

Give every hosted agent and gateway a truthful, provider-neutral readiness result before a
provider-backed tool runs. An agent must know whether an action is available, missing access,
unsupported for the selected connection/authentication mode, awaiting provider approval, unhealthy,
or not configured. Unsupported and blocked actions must finish with a concise explanation and a
safe remediation path instead of invoking the provider, retrying blindly, or leaving a run waiting.

Success means that the same action-readiness contract is enforced for Core-backed tools and exposed
through web, Telegram, WhatsApp, and other gateways, while agent entitlements, provider access,
human approval, and provider execution remain separate checks.

## Scope

### Included

- A shared action-readiness contract for provider-backed tool calls.
- A Core preflight seam that resolves the target connection and checks capability, connection mode,
  health, provider setup, and required provider approval before external calls.
- Agent Platform handling that turns a blocked preflight into a terminal, durable response with safe
  reason codes and remediation metadata.
- Tool manifests and agent context that expose normalized capability requirements without provider
  scopes or credentials.
- Shared gateway rendering for web, Telegram, WhatsApp, and other configured channels.
- Coverage for content publishing, scheduling, analytics, comments, messaging, media delivery,
  published-content management, and future provider-backed tools through the same seam.
- Structured logs, bounded metrics, runbook updates, and release evidence for skipped and blocked
  actions.

### Excluded

- Changing provider permission policy or manufacturing permissions that Meta, Telegram, WhatsApp,
  or another provider does not offer.
- Automatically granting access, reconnecting accounts, or bypassing human approval.
- Replacing the existing provider adapters or gateway-specific native formatting.
- Treating an unknown provider response as granted access.
- Making every action synchronous; durable actions and provider jobs retain their existing lifecycle.

## Context and constraints

- Existing `connection_permissions` already models `GRANTED`, `REQUESTABLE`, `UNSUPPORTED`,
  `UNKNOWN`, and provider-approval states, but this information is not yet a universal preflight
  contract for every tool.
- `kasitek.core.content_post_delete_published` already returns normalized authorization metadata;
  the design must generalize that result rather than create a second permission vocabulary.
- `agents/src/media/contracts.ts` already carries safe `authorizationRequired` data, and gateway
  formatting already has a shared authorization remediation helper. Extend these seams where they
  remain sufficiently deep instead of adding provider-specific agent prompts.
- Agent installation/tool grants and provider connection access are different authorization layers.
  Both must be checked, and neither may be represented as the other.
- Approval must remain before external effects. A readiness preflight may run before approval for
  safe user feedback, but the authoritative readiness check must run again immediately before the
  provider effect.
- Direct Instagram Login and Meta Login remain separate connection modes. The action result must
  identify that a capability is unsupported for the current mode and, where appropriate, offer a
  Meta Login remediation without claiming that the direct connection can be upgraded in place.
- No provider URLs, raw scopes, access tokens, raw provider payloads, or full message bodies may
  cross into an agent prompt, durable response, analytics event, or gateway message.

### Implemented regression slice — WhatsApp inbound media no-hang path

- [x] Confirm the production failure boundary: Core stored the inbound image, while Agent Platform
      rejected the canonical attachment because optional provider metadata was explicitly `null`.
- [x] Normalize provider-null optional attachment metadata at the shared Agent Platform ingress,
      with a regression test covering the WhatsApp image envelope.
- [x] Send one bounded WhatsApp acknowledgement when Agent Platform rejects an inbound message or
      is unavailable, while keeping provider error details out of the user message.
- [x] Ensure durable workflow failure exits persist a user-facing terminal response and attempt
      delivery, including empty responses, approval mismatches, missing events, and activity errors.
- [x] Add bounded validation-path logging for future `/v1/channels/inbound` contract failures and
      update the media-harness and connection-guide documentation.
- [x] Deploy the bounded fix and verify the affected production service deployments and health
      endpoints.
- [ ] Run a controlled WhatsApp image-to-agent smoke test with a non-sensitive test message.

## Proposed contract

Use one normalized result for the provider-backed action seam:

```text
ActionReadiness@1
  status: READY | NOT_GRANTED | UNSUPPORTED | REQUIRES_PROVIDER_APPROVAL |
          UNKNOWN | UNHEALTHY | NOT_CONFIGURED | REQUIRES_USER_ACTION
  action: normalized tool/action key
  provider: normalized provider key
  connection: safe connection reference and display identity when known
  requiredCapabilities: normalized KasiTek capability keys
  reasonCode: bounded machine-readable reason
  requestable: boolean
  remediation: NONE | CONNECTIONS_ACCESS | PROVIDER_SETUP | RETRY_HEALTH_CHECK |
               CONTACT_ADMIN | RETRY
  remediationIntent: safe Connections/setup deep-link when available
```

`READY` is an internal preflight result and is not normally sent to the user. All non-ready states
must be safe to serialize as a tool result or terminal agent response. A blocked action is not a
provider failure: Core must not call the provider when the current normalized snapshot already
proves that the action is unsupported or unavailable.

The contract must support both:

1. **Static readiness** from the current connection snapshot, such as Direct Instagram Login not
   supporting published-content deletion.
2. **Dynamic readiness** from a bounded provider check, such as an expired token, missing Page
   task, missing WhatsApp phone setup, or a provider capability that cannot be inspected ahead of
   time.

## Implementation plan

### Phase 1 — Contract and inventory

- [ ] Inventory every registered Core-backed and integration-backed tool, its external provider
      boundary, resource selector, required normalized capability, approval mode, and current error
      behavior.
- [ ] Define the `ActionReadiness@1` schema and bounded reason/remediation registry.
- [ ] Decide which tool metadata is declarative (`requiredCapabilities`, resource selector,
      provider context) and which resolution remains inside Core adapters.
- [ ] Define the no-hang invariants: blocked preflight makes zero provider calls, produces one
      terminal tool outcome, does not ask the model to retry the same call, and remains replay-safe.
- [ ] Add this plan to the shared connection-permission execution record and keep the original
      provider-specific access model as the source of truth.

### Phase 2 — Core readiness seam

- [ ] Add a typed Core action-readiness module behind a small interface. It should resolve
      `postId + platform`, `conversation/channel`, selected connection, media asset, and other
      resource selectors without trusting provider identifiers supplied by an agent.
- [ ] Route content publishing, scheduling, unscheduling, analytics, comment operations,
      messaging, media delivery, and published-content management through preflight before their
      provider adapters.
- [ ] Reuse the existing provider adapter capability registry and connection snapshots. Add no
      provider scope names to the Agent Platform contract.
- [ ] Return structured readiness details for unsupported, missing, approval-required, unknown,
      unhealthy, and not-configured cases, including safe provider/auth-mode context.
- [ ] Recheck readiness immediately before an external effect after approval and idempotency
      checks; never convert a provider rejection into a successful local operation.
- [ ] Preserve partial-result semantics for multi-provider actions, clearly separating skipped
      provider actions from completed actions.

### Phase 3 — Agent Platform tool harness

- [ ] Extend the Core client to parse and preserve the typed readiness envelope instead of reducing
      it to `CORE_REQUEST_FAILED`.
- [ ] Add provider/action readiness metadata to tool manifests where it improves model planning,
      while keeping Core authoritative for target resolution and enforcement.
- [ ] Add one shared preflight/error normalization path for normal loops, workflow graphs,
      decomposed activities, MCP, REST, and direct tool execution.
- [ ] Make non-ready readiness terminal for the current request: record the structured outcome,
      emit bounded lifecycle telemetry, and return a deterministic user-facing response with no
      automatic model retry or repeated provider invocation.
- [ ] Keep human approval separate: readiness may explain that approval is still required, but
      approval must not be represented as provider access and reauthorization must not execute the
      original destructive action automatically.
- [ ] Include safe connection display identity and the exact normalized capability explanation in
      agent context/results so agents do not have to infer support from raw metadata.

### Phase 4 — Gateway and agent experience

- [ ] Extend the shared authorization/remediation formatter to distinguish unsupported,
      requestable, provider-review, unhealthy, and setup-required states.
- [ ] Web: render a structured blocked-action card with the connection, capability, reason, and
      Connections/setup action; do not show a generic failed or loading state.
- [ ] Telegram and WhatsApp: render concise plain text plus native deep-link/button behavior where
      supported; do not tell users to retry when the action is unsupported.
- [ ] Other gateways: use the same normalized result and only vary link/button/media formatting at
      the gateway adapter seam.
- [ ] Add feature-triggered remediation for actions such as Instagram deletion: show that Direct
      Instagram Login cannot provide the capability and suggest Meta Login only when that is a
      valid provider setup path.
- [ ] Ensure blocked actions complete their conversation/run lifecycle and cannot leave the agent
      worker waiting on a provider response that was never started.

### Phase 5 — Verification and hardening

- [ ] Add unit tests for every readiness state and for provider/auth-mode distinctions, including
      Direct Instagram Login versus Meta Login.
- [ ] Add Core tests proving unsupported and missing-access preflights do not invoke provider HTTP
      adapters.
- [ ] Add Agent Platform tests proving normal, workflow, decomposed, MCP, and REST executions stop
      after one blocked readiness result and preserve the safe response.
- [ ] Add gateway contract tests for web, Telegram, WhatsApp, and other configured adapters,
      including link/button and no-link fallbacks.
- [ ] Add provider HTTP fixtures for dynamic checks and verify timeout, provider rejection,
      partial-result, idempotency, and replay behavior.
- [ ] Add bounded structured logs and metrics for `preflight.ready`, `preflight.blocked`,
      `preflight.unknown`, `provider.call.skipped`, and terminal remediation outcomes. Exclude
      tokens, scopes, URLs, bodies, and personal data.
- [ ] Update the public connection/access documentation, agent tool contract documentation, and
      failure runbook with the final states and retry/remediation rules.
- [ ] Run lint, type checks, Core and Agent Platform tests, builds, provider fixtures, browser
      checks, and controlled gateway smoke tests.

## Verification

- [ ] Lint or type check: Agent Platform and affected client packages.
- [ ] Targeted tests: readiness contract, Core provider adapters, tool loop, workflow/decomposed
      execution, and gateway formatters.
- [ ] Build or runtime check: Core, agents worker/API, client, and controlled web/Telegram/WhatsApp
      smoke flows.
- [ ] Negative evidence: an unsupported Direct Instagram Login delete, missing Meta permission,
      unconfigured WhatsApp setup, and unhealthy provider each produce one terminal structured
      result without an external provider call.
- [ ] Release evidence: record exact commit/service artifacts, environment/config revision,
      provider app-review status, rollout scope, post-release monitoring, and rollback action.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Source of truth | Core provider adapters and connection snapshots remain authoritative; agent manifests are advisory metadata. | Platform integrations | Proposed |
| Terminal behavior | Non-ready preflight returns one terminal response and does not trigger an automatic model retry. | Agent Platform | Proposed |
| Approval ordering | Preflight is safe to run before proposal/approval for feedback, and must be repeated immediately before effects. | Security/Platform | Proposed |
| Direct Instagram Login | Keep the connection mode for standalone professional accounts; report deletion as unsupported and suggest Meta Login only when Page-linked setup is valid. | Product/Integrations | Confirmed constraint |
| Dynamic provider checks | Which providers need a live health/capability probe versus snapshot-only readiness? | Provider owners | Open |
| Agent-visible identity | Which safe connection display fields are sufficient for remediation without exposing IDs? | Privacy/Product | Open |
| New endpoint | Extend existing Core internal routes or add a dedicated provider-neutral preflight route? | Core | Open; choose after inventory |

## Notes and blockers

- Provider-specific permission/app-review configuration remains an external dependency and must be
  recorded per provider before production rollout.
- A true provider HTTP smoke test requires non-sensitive test assets and valid environment
  credentials; fixtures can prove the no-call and error-normalization paths without exposing them.

## Release record

Change: Universal provider/action readiness preflight and terminal remediation for agent tools.

Owner: Platform integrations and Agent Platform.

Risk: high.

Affected services and user surfaces: kasitek-core provider adapters and internal agent routes,
Agents API/worker/runtime/workflows, Connections and agent transcripts, web, Telegram, WhatsApp,
and other configured gateway adapters.

Platform release version or release ID: `9db0b222` (`fix: prevent WhatsApp media agent hangs`).
Railway production deployments: Core `52a7b9fa-72a8-4210-adfd-8c388be9ce33`, Agents API
`6cb9c46f-1498-425f-8c2e-5f602bfeeebe`, Agents Worker `6540e815-6443-4195-8b78-648f738f6504`,
and MCP Gateway `57ce3537-907d-4bb6-8171-f4b57733c925`; all reached `SUCCESS` with running
instances. No configuration revision changed.

API/schema/migration changes: expected additive internal contract changes; no destructive migration
is planned. Confirm after Phase 1 inventory whether readiness snapshots or action-attempt records
need new columns/tables.

Feature flag or rollout method: stage by environment and provider; keep a disable path for the new
terminal preflight behavior while preserving existing connection and content records.

Analytics events and success metrics: reuse the versioned analytics registry. Measure blocked
actions resolved without provider calls, unsupported-action clarity, repeated-tool-call rate,
provider-call failures after READY, and worker/run completion latency. Add new event contracts only
after registry and privacy review.

Logs, metrics, dashboards, and alerts: add bounded preflight and provider-call-skipped signals,
correlation IDs, provider/auth-mode/action status, and dashboards/alerts for unknown readiness,
provider rejection after READY, and terminal run failures. No credentials, scopes, URLs, or message
bodies.

User, API, internal, and operational documentation: update `docs/public/docs/operations/social-connections.md`,
the Agent Media/Tool harness architecture documentation, the connection failure runbook, and the
agent-facing contract documentation. Mark provider-specific unsupported states explicitly.

Validation evidence: this incremental slice passed 655 Agent tests, the Agent build and type check,
14 Core WhatsApp tests, Rust formatting, and diff checks. Public Core and Agent Gateway health
checks returned ready. The controlled WhatsApp provider smoke test remains pending.

Rollback or disable plan: disable universal preflight enforcement behind the rollout control,
retain Core provider-specific guards and existing access routes, and roll back only the application
artifact after any additive migration is confirmed safe. Do not delete connection, permission, or
content history.

Post-release review date: set seven days after controlled production enablement.
