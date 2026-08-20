# Custom Agent Creation UI — End-to-End Checklist

**Status:** In progress

**Scope:** Hosted user-agent custom creation only. KasiAi and external-agent connection flows remain
separate.

**Related plan:** `KASITEK_AGENT_CREATION_TYPES_PLAN.md`

## Product boundary

- [x] Keep KasiAi out of hosted-agent creation.
- [x] Keep external-agent connection outside this builder.
- [x] Keep ordinary hosted agents provider-neutral and free of implicit KasiTek tools.
- [ ] Make the custom builder create a useful baseline agent before optional integrations are added.
- [ ] Keep channels and deployments separate from tool and credential configuration.

## Creation flow

### 1. Choose a blueprint

- [x] Show blank custom and available custom templates.
- [x] Show each blueprint’s outcome, setup steps, required connections, and capabilities.
- [x] Add a clear “Use this blueprint” transition into the builder.
- [x] Preserve the selected blueprint while navigating backward and forward.

### 2. Agent basics

- [x] Collect name, purpose, audience, and success outcome in plain language.
- [x] Generate safe starter instructions from the purpose.
- [x] Keep slug, provider, model, token ceilings, and raw instructions out of the primary path.
- [x] Keep advanced controls available without making them required.
- [ ] Validate identity fields locally and on the server.

### 3. Knowledge and memory

- [x] Start with platform-managed conversation history and memory behavior.
- [ ] Allow pasted information and supported file uploads for this agent.
- [ ] Show knowledge ingestion progress, errors, ownership, and source status.
- [ ] Allow this step to be skipped and completed later.
- [ ] Never mix KasiAi knowledge or memory into a hosted user agent.

### 4. Tools, credentials, and connections

- [ ] Show optional integrations in human terms: Email, Calendar, CRM, Database, MCP, REST API,
  and KasiTek services.
- [x] Keep the default selected integration set empty.
- [ ] Distinguish not selected, needs connection, connected, approval required, unavailable, and
  unhealthy states.
- [ ] Let users select an existing connection or start a connection setup flow.
- [ ] Keep credentials as opaque references with safe status metadata only.
- [ ] Show required capabilities and missing prerequisites before activation.
- [ ] Keep KasiTek services under a separate explicit integration category.

### 5. Workflow builder

- [x] Start every custom agent with a valid text-input → model → response baseline.
- [ ] Replace the dense node form with a progressive workflow editor.
- [ ] Show triggers, model steps, tools, conditions, approvals, waits, handoffs, schedules, and
  external events only when supported by the runtime.
- [ ] Provide a visual graph or clear step-based canvas with node-level configuration.
- [ ] Explain each node’s inputs, outputs, credentials, capability, retry, and failure behavior.
- [ ] Validate reachability, contracts, loops, limits, required tools, and required connections.
- [ ] Keep workflow import/export bounded and secret-safe.

### 6. Test

- [ ] Provide a full test conversation before activation.
- [ ] Use the agent’s real isolated installation and conversation history.
- [ ] Show optimistic user messages and visible run progress.
- [ ] Show concise tool activity, approvals, retries, failures, and final output.
- [ ] Allow retry after configuration fixes without duplicating effects.
- [ ] Keep test mode and real provider effects clearly distinguished.

### 7. Review and publish

- [x] Show a concise review of identity, knowledge, tools, credentials, workflow, channels, limits,
  and approval behavior.
- [ ] Block only on real missing requirements and place each blocker beside its owning step.
- [ ] Save a mutable creation draft separately from immutable published versions.
- [x] Publish only after review and explicit user action.
- [ ] Install or update the selected workspace installation explicitly.
- [ ] Show the deployed version and pending setup after publish.

### 8. Deployment and lifecycle

- [ ] Keep text gateway available first.
- [ ] Configure channels from the agent details/deployment area.
- [ ] Show draft, published, and deployed versions separately.
- [ ] Support explicit rollout, pause, resume, rollback, and retirement.
- [ ] Link deployed versions to activity, usage, approvals, and recovery history.

## Builder shell and interaction quality

- [x] Add a responsive wizard shell with progress, back, next, and cancel.
- [ ] Add an explicit save-draft action before the final creation request.
- [ ] Preserve state across refresh/reconnect using server draft persistence or bounded recovery.
- [ ] Add step-local validation and actionable errors.
- [ ] Add loading, empty, stale, degraded, denied, and retry states.
- [ ] Keep keyboard navigation, focus management, labels, and announcements accessible.
- [ ] Avoid raw capability IDs, provider jargon, and unnecessary explanatory copy in the primary UI.
- [x] Keep advanced technical settings behind an Advanced section.

## Contracts and safety

- [ ] Ensure zero-tool custom agents can be created, published, installed, and tested.
- [ ] Ensure explicit external tools are installation-scoped and executable only when healthy and
  granted.
- [ ] Ensure explicit KasiTek integrations retain normal role, scope, approval, entitlement, and
  audit checks.
- [ ] Ensure workflow imports cannot introduce undeclared tools, credentials, or capabilities.
- [ ] Ensure agent-local conversations, knowledge, and memory remain isolated.
- [ ] Ensure retries and rollbacks cannot duplicate external effects.

## Verification and rollout

- [ ] Add component tests for each builder step and validation state.
- [ ] Add integration coverage for blank custom creation with no integrations.
- [ ] Add integration coverage for one external connection and one optional KasiTek integration.
- [ ] Add browser smoke coverage for refresh, back-navigation, publish, and test chat.
- [ ] Run client lint, typecheck, and production build.
- [ ] Run Agent Platform unit, HTTP, database, and Temporal-backed tests where available.
- [ ] Gate rollout behind a controlled feature flag or reversible route switch.
- [ ] Keep the existing details and runtime APIs compatible during migration.

## Delivery batches

- [x] Batch 1: progressive shell, staged basics, baseline workflow, and draft review.
- [ ] Batch 2: knowledge and file sources with progress/status.
- [ ] Batch 3: tools, credentials, capability readiness, and explicit KasiTek integrations.
- [ ] Batch 4: test conversation, activity, approval, retry, and failure UX.
- [ ] Batch 5: publish, installation rollout, deployment readiness, rollback, and lifecycle.
- [ ] Batch 6: accessibility, component/integration/browser verification, and controlled rollout.
