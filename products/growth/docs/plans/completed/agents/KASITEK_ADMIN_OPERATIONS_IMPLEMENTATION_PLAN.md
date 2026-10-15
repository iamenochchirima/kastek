# KasiTek Admin Operations Console

**Status:** Archived

## Scope

This plan covers the internal KasiTek administration surface for operating the
agent platform and the product data it produces. It is for authorized KasiTek
staff, not workspace users and not customer-facing agent configuration.

The console must let KasiTek staff answer four questions quickly:

1. Is the platform healthy?
2. What happened to a particular organization, agent, conversation, run, or
   provider event?
3. What data and effects were produced, and who/what produced them?
4. What safe intervention is available, and what approval is required?

The console is an operator control plane. It is not a second database, a
backdoor to customer tables, or a way to bypass capability authorization.

## Product boundary

### In scope

- Cross-platform health and capacity monitoring.
- Organizations, workspaces, users, agents, installations, credentials
  metadata, channels, provider connections, and capability grants.
- Agent runs, Temporal workflow state, model calls, tool calls, approvals,
  effects, webhooks, deliveries, retries, and failures.
- Conversations, messages, summaries, and memory investigation through an
  explicit, time-limited support-access session.
- Usage, latency, error, model/provider, quota, and cost reporting.
- Incident response, suspension, revocation, retry, cancellation,
  reconciliation, feature flags, and scoped kill switches.
- Immutable audit, security events, data export/deletion requests, and
  operator runbooks.

### Explicitly out of scope

- A customer-facing replacement for the Agents UI.
- Direct browser access to PostgreSQL, Redis, Temporal, object storage, or
  provider dashboards.
- Viewing or recovering plaintext installation secrets, OAuth tokens, API keys,
  refresh tokens, or model provider keys.
- Editing or deleting audit evidence.
- An unrestricted “run any tool as admin” button.
- A second copy of business data owned by the agent service.

## Operating model

The existing `client/apps/admin` application remains the UI. A dedicated
operator API/control plane is added to `kasitek-core`, with private signed
service calls to the agents service where agent-owned operational state lives.
The browser never calls agent databases or Temporal directly.

```text
KasiTek admin browser
        |
        v
Admin BFF / operator API (kasitek-core)
  - admin authentication and role checks
  - support-access grants
  - command validation and idempotency
  - redaction and response shaping
  - immutable operator audit
        |
        +--> core product read models and admin commands
        +--> signed internal operator API (agents service)
        +--> metrics/alerts and event projections
        +--> object-storage metadata (never raw secret material)
```

The core operator API is the policy authority. The agents service exposes only
versioned internal operator endpoints and verifies a short-lived signed
delegation from core. Both services emit the same correlation ID and command
ID into audit records.

## Admin roles and access

The current admin session roles are the starting point, but agent operations
need explicit permissions instead of a single broad `admin` check.

| Role | Default access | Write access |
| --- | --- | --- |
| `platform_viewer` | Aggregate health, metadata, redacted investigations, audit search | None |
| `support_operator` | Viewer access plus approved support sessions and customer-impacting recovery | Scoped support commands; no global controls |
| `platform_operator` | Viewer access plus runs, queues, providers, channels, and installation operations | Retry/cancel/reconcile, suspend/revoke, scoped flags |
| `security_operator` | Security events, credentials metadata, abuse controls, support-session review | Credential revocation, security holds, kill switches |
| `platform_admin` | All operational areas | All non-destructive controls; dual control for global/high-risk actions |
| `platform_owner` | Full governance | Role management and emergency controls |

Every request checks both role and resource scope. A support operator does not
gain global access merely by opening a workspace record.

### Support access sessions

Normal operator views show metadata, aggregates, hashes, previews, and
redacted content. Reading customer messages, files, memory, or conversation
content requires a support-access session containing:

- operator identity;
- target organization/workspace and optional conversation/run/resource IDs;
- reason and incident/ticket reference;
- exact data categories allowed;
- approver (when required);
- start time and short expiration;
- whether export is allowed.

The grant is checked on every request, content access is separately audited,
and the session expires automatically. Secrets remain prohibited even during a
support session. Emergency access is time-boxed, alerts the owner, and is
reviewed after the incident.

## Data model and read models

### Authoritative data

Core remains authoritative for organizations, workspaces, users, product
connections, provider credentials, permissions, and business effects. The
agents service remains authoritative for agent definitions, installations,
agent versions, runs, tool/model events, approvals, and agent channel state.
The console reads through APIs, never by joining databases in the browser.

### Operator projections

Build denormalized, queryable read models for fast cross-platform investigation:

- `operator_agent_health` — installation state, last run, error rate,
  provider/channel health, queue lag, and current controls.
- `operator_run_index` — run ID, conversation ID, org/workspace, installation,
  status, timestamps, model/tool counts, approval/effect state, and failure
  class.
- `operator_event_index` — audit-safe event metadata and correlation links.
- `operator_usage_daily` — model tokens, tool calls, provider cost estimates,
  effects, failures, quotas, and latency percentiles.
- `operator_delivery_index` — channel/webhook delivery attempts, provider
  message IDs, dedupe keys, status, retry state, and redacted error details.
- `operator_alerts` — deduplicated health/security/cost/abuse alerts.

Projections are rebuildable from durable events. They are not a new source of
truth. Each response identifies its source timestamp and projection lag.

### Data classification

Every returned field is classified as `public-ops`, `internal-metadata`,
`customer-content`, or `secret`. `secret` is never returned. Customer content
requires a support grant. Logs and model/tool payloads are redacted at the
API boundary, not only in the UI.

## Admin information architecture

The admin app should have a dedicated Operations area with these pages:

1. **Overview** — service status, active runs, queue lag, provider failures,
   pending approvals, delivery failures, usage/cost anomalies, active alerts,
   and recent operator actions.
2. **Organizations and workspaces** — search, health, users, installations,
   connections, usage, limits, incident holds, and support-access history.
3. **Agents and installations** — definitions, versions, grants, credentials
   metadata, channels, current status, recent runs, and controls.
4. **Runs and workflows** — correlation search, timeline, model/tool events,
   approval/effect state, Temporal identifiers, retry/cancel/reconcile actions,
   and “needs attention” queue.
5. **Conversations and channels** — metadata by default; approved content
   investigation, participants, delivery state, handoff, archive/deletion
   status, and channel pairing.
6. **Approvals and effects** — pending/expired/denied/completed approvals,
   immutable previews, effect receipts, ambiguous provider outcomes, and
   reconciliation.
7. **Providers and connectors** — model gateway health, social/messaging
   provider health, OAuth/connectors metadata, webhook delivery, and outages.
8. **Queues and workers** — Temporal task queues, worker heartbeat, backlog,
   retry/dead-letter rates, stuck workflows, and deployment version.
9. **Usage and cost** — organization/agent/provider/model breakdowns, limits,
   anomalies, and exportable reports.
10. **Alerts and incidents** — triage, acknowledge, assign, suppress with
    expiry, incident timeline, and runbook links.
11. **Audit and security** — immutable audit search, credential/session events,
    access reviews, abuse events, and support-session review.
12. **Controls** — scoped kill switches, feature flags, capability catalog
    availability, maintenance mode, and emergency controls.

Global search must accept organization, workspace, user, agent, installation,
credential label, conversation, run, provider message, webhook delivery, and
correlation IDs. Search results must clearly show the current scope and never
silently combine records from unrelated organizations.

## Safe admin commands

All mutations use a common command envelope:

```json
{
  "command_id": "uuid",
  "reason": "incident or support reason",
  "ticket_reference": "optional",
  "expected_version": 12,
  "support_access_id": "required for customer-scoped content actions",
  "requested_at": "timestamp"
}
```

Commands are idempotent, authorization-checked, audited before and after
execution, and return an action receipt. The UI must display the target,
impact, current state, and reversibility before confirmation.

### Allowed command families

- Retry a failed delivery or idempotent run step.
- Cancel a pending run or approval.
- Reconcile an ambiguous provider effect.
- Suspend/resume an agent installation or channel.
- Revoke a named installation credential (metadata only).
- Pause a capability, provider, connector, or channel at a scoped level.
- Mark a run as needing attention and assign an operator.
- Redeliver a signed webhook when the provider supports safe replay.
- Create/expire support-access grants.
- Request a customer export or deletion workflow.
- Toggle a feature flag with expiry and rollout scope.
- Place or remove an organization/workspace operational hold.

### High-risk controls

Global shutdowns, broad capability pauses, organization suspension, irreversible
data deletion, and changes to admin roles require `platform_admin` or owner
authority, explicit reason, confirmation, and a second approver where policy
requires it. Emergency kill switches may act immediately but automatically
expire or require post-incident review.

### Prohibited controls

- Reveal or replace customer/provider secrets through the console.
- Impersonate a customer in the customer UI.
- Bypass core authorization or approval policy.
- Execute arbitrary MCP/REST tools with operator privileges.
- Mutate customer content without a scoped, visible support command.
- Delete or rewrite audit records.
- Change an effect receipt to hide an external provider outcome.

## API surface

Add a versioned internal operator namespace behind the existing admin session:

```text
GET  /api/admin/operations/overview
GET  /api/admin/operations/alerts
GET  /api/admin/operations/organizations
GET  /api/admin/operations/agents
GET  /api/admin/operations/installations/:id
GET  /api/admin/operations/runs
GET  /api/admin/operations/runs/:id
GET  /api/admin/operations/conversations
GET  /api/admin/operations/conversations/:id
GET  /api/admin/operations/approvals
GET  /api/admin/operations/providers
GET  /api/admin/operations/queues
GET  /api/admin/operations/usage
GET  /api/admin/operations/audit
GET  /api/admin/operations/support-access
POST /api/admin/operations/support-access
POST /api/admin/operations/commands/:command
```

The exact route names may be refined during implementation, but all pages must
use typed response schemas and cursor pagination. Mutating commands must not be
implemented as generic SQL or arbitrary HTTP proxying.

The agents service receives a private operator request containing operator
identity, permission, target scope, command ID, expiry, and signed delegation.
It returns safe operational data and receipts. It must reject browser-origin
requests and expired/replayed delegations.

## Observability requirements

Every run and provider interaction carries:

- organization/workspace ID;
- user or external agent principal ID;
- agent definition/installation/version;
- conversation and run ID when applicable;
- capability/version and normalized input hash;
- provider/model/channel identifiers;
- trace/correlation ID;
- approval/effect/delivery IDs;
- timestamps, duration, status, and retry count.

Metrics and alerts must cover API health, Temporal workers/queues, model
gateway, capability failures, approvals, external effects, webhooks, channel
delivery, database/Redis health, latency, cost, rate limits, and suspicious
access. Alerts are deduplicated, severity-ranked, and linked to an operator
runbook.

## End-to-end implementation checklist

### Phase 0 — policy and contracts

- [ ] Confirm KasiTek operator console is the sole scope of this plan.
- [ ] Define operator roles and permission matrix in code and documentation.
- [ ] Define data classifications and redaction rules for every operator DTO.
- [ ] Define support-access grant, approval, expiration, and emergency policy.
- [ ] Define command envelope, idempotency, receipts, and audit event schema.
- [ ] Define which actions require dual control and which are prohibited.
- [ ] Add this document to the architecture index and implementation checklist.

### Phase 1 — operator identity and backend boundary

- [ ] Extend admin identity/session responses with explicit permissions and
  operator scopes.
- [ ] Add authorization middleware for operator resources and commands.
- [ ] Add support-access session tables, APIs, expiry enforcement, and alerts.
- [ ] Add typed operator DTOs with classification/redaction metadata.
- [ ] Add operator audit events for reads of sensitive metadata and all writes.
- [ ] Add command idempotency and expected-version checks.
- [ ] Add private signed operator delegation between core and agents service.
- [ ] Reject direct browser/anonymous access to agent operator endpoints.

### Phase 2 — event projections and metrics

- [ ] Emit agent lifecycle, run, model, tool, approval, effect, delivery,
  provider, worker, and security events with correlation IDs.
- [ ] Build rebuildable operator projections and migrations.
- [ ] Add projection lag and ingestion-failure metrics.
- [ ] Add usage, cost, latency, quota, and provider aggregation jobs.
- [ ] Add alert rules, deduplication, acknowledgement, assignment, and expiry.
- [ ] Add retention, redaction, export, and deletion handling for operator data.

### Phase 3 — overview and investigation APIs

- [ ] Implement overview, alerts, organizations, agents, installations,
  runs, approvals, providers, queues, usage, and audit endpoints.
- [ ] Implement global search with cursor pagination and strict scope labels.
- [ ] Implement run/event timeline DTOs with safe payload previews and hashes.
- [ ] Implement conversation metadata endpoints and support-gated content reads.
- [ ] Implement delivery/webhook and provider health investigation endpoints.
- [ ] Add contract tests for each endpoint and permission combination.

### Phase 4 — admin UI

- [ ] Add an Operations navigation section to `client/apps/admin`.
- [ ] Build overview dashboard with live/polling health states and timestamps.
- [ ] Build organization/workspace and agent/installation investigation views.
- [ ] Build run, workflow, approval, effect, delivery, provider, and queue views.
- [ ] Build support-access request, approval, active-session, and expiry UI.
- [ ] Build audit/security, usage/cost, alert, and incident views.
- [ ] Add URL-persisted filters, saved searches, exports, loading/empty/error
  states, and clear cross-organization scope indicators.
- [ ] Never render secrets, raw tokens, unredacted model prompts, or raw
  provider payloads by default.

### Phase 5 — safe operations

- [ ] Implement retry, cancel, reconcile, assign, and needs-attention commands.
- [ ] Implement installation/channel suspend/resume and credential revocation.
- [ ] Implement provider/capability/channel scoped pause controls.
- [ ] Implement webhook/delivery safe replay with dedupe protection.
- [ ] Implement feature flags and maintenance controls with expiry.
- [ ] Implement export/deletion workflow requests, never direct destructive SQL.
- [ ] Implement dual-control and emergency kill-switch workflows.
- [ ] Add command receipts, before/after state, and operator notifications.

### Phase 6 — incident and security readiness

- [ ] Add runbooks for provider outage, queue backlog, stuck run, duplicate
  effect, webhook storm, model outage, credential compromise, and data access.
- [ ] Add alerts for support-access misuse, repeated authorization failures,
  replay attempts, unusual cost, and cross-scope access attempts.
- [ ] Add audit review and periodic operator-access review screens.
- [ ] Exercise key rotation and delegation revocation.
- [ ] Verify backups/restores for projections and immutable audit records.

### Phase 7 — verification and rollout

- [ ] Unit-test role checks, redaction, support grants, command idempotency,
  version checks, and delegation verification.
- [ ] Integration-test core-to-agents operator calls and event projections.
- [ ] End-to-end test every page in viewer, support, operator, security, and
  admin roles.
- [ ] Test organization isolation and absence of secret leakage.
- [ ] Test retry/replay, cancellation, reconciliation, suspension, and kill
  switch behavior against idempotent fixtures.
- [ ] Test degraded dependencies and stale projection messaging.
- [ ] Run a controlled internal beta with audit review before production use.
- [ ] Publish the operator handbook and incident escalation ownership.

## Definition of done

The KasiTek admin console is complete when an authorized operator can trace a
customer-safe path from organization → installation → conversation/run → model
and tool events → approval → external effect → delivery, see the relevant
health and usage signals, and perform only the commands allowed by their role.
Every sensitive read and every command is time-bound where necessary,
redacted, idempotent, attributable, and visible in immutable audit history.
