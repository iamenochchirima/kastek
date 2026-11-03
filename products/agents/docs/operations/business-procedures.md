# Business workflows

Owner: Agents engineering. Last reviewed: 2026-11-03.

Business workflows are versioned playbooks available to an ordinary business agent through
tools. The existing model/tool loop remains the executor. A workflow records durable progress;
it does not grant permissions, install another agent or create a separate conversation engine.
The implementation calls these definitions and instances `procedures`, distinct from the older
`capabilities.workflows` report-delivery configuration.

## Configuration and visibility

Configure → Tools → Workflows selects definitions for one agent. **After-hours support** is the
first definition, `after-hours-assistance` version `1`. Saved configuration contains
`procedures: [{ id: "after-hours-assistance", version: "1" }]`; the default is an empty list.
The existing save flow creates the immutable agent version. The per-agent
`GET /api/organizations/:organizationId/agents/:agentId/procedures` catalogue returns definition
metadata and readiness reasons. Human support, support-status access and configured hours are
required. Loading a definition cannot enable those dependencies.

The model discovers only selected, authorized definitions. It can discover metadata, load the
exact playbook, start or inspect an instance, suspend/resume it, or cancel it through
`procedures.discover`, `procedures.load`, `procedures.start`, `procedures.inspect`,
`procedures.update` and `procedures.cancel`. Instances are scoped to organization, agent and
execution conversation. Customer execution requires the trusted channel binding and current
handoff authority. Another agent or conversation cannot inspect or reuse the instance.
Current published configuration is checked in addition to accepted configuration.

## After-hours assistance

The backend calculates current hours and next opening using the saved schedule and timezone.
The same agent loads the playbook when the customer requests a person and support is closed.
The playbook requires truthful hours feedback, an offer to help now, and respect for the
customer's choice. Optional contact details do not gate recording the human request.

`support.request_assistance` records the request, staff brief and customer notice through Inbox.
The notice is a short factual receipt with the next opening when known and an offer of continued help. The model follows with one or two short sentences that ask the next useful question, rather than repeating the receipt or reciting uncertainty disclaimers. It leaves conversation ownership with the agent. `support.update_assistance` requires one explicit action: `save_contact`, `human_only`,
`self_service`, `declined` or `withdrawn`. Customer message ID and exact evidence quote are shared
top-level fields. Saving contact cannot simultaneously pause assistance. Contact and
choice evidence must reference the bound customer's real message; provided contact values must
appear in that evidence. Preferences can specify this conversation, email or phone. Saving a
preference does not send email, place a call, establish an outreach integration or prove staff
notification. The model must not promise those outcomes.

Inbox shows the human request independently from conversation ownership, with reason, context
and any captured preference. The **Human support requested** filter includes requests while the
agent remains active. Assignment alone does not stop the agent. Staff takeover or an explicit
human-only choice fences automated work. Resolution completes the request; explicit return
restores agent ownership under the normal Inbox authority rules.

## Progress and effect truth

`contracts/procedures.ts` defines immutable references, instance state and revision-checked
commands. `contracts/procedure-definitions.ts` owns the registry; `execution/procedures/store.ts` owns durable instances.
`capabilities/procedure-tools.ts` connects those tools to the existing business loop; Inbox
owns support effects and evidence validation through the typed channel ports. Execution consumes
scoped snapshots and receipt validation; it never reads product customer tables directly.

Instances have `active`, `suspended`, `completed` or `cancelled` status. Customer routes are
`callback`, `self_service`, `declined` or `withdrawn`; `callback` means a recorded follow-up
request, not a completed phone call. Completion requires domain-validated receipts for the
after-hours notice, offer of help and customer choice, plus the human request for follow-up.
Model-authored checklist claims are insufficient. Missing receipts remain missing and unknown
effects block completion. For connected channels, a queued notice is not confirmed delivery.

An instance links its originating task, which retains the accepted work, actor, product and grant.
Stable command identities and revisions protect retries and concurrent updates. Suspending or
cancelling a procedure does not withdraw a support request or undo an external effect. The
support domain tool owns withdrawal. Already accepted and uncertain effects remain recorded.

## Release and operation

| Concern | Decision |
| --- | --- |
| Risk and surfaces | High: matching Agents API, worker and web UI; customer website and connected-channel execution; staff Inbox. |
| Identity | Definition `after-hours-assistance@1` is pinned per agent. Existing runtime `product-capabilities-v15` / `AgentsBusinessRunV25` remains unchanged. Record exact commit/artifact identities at rollout; package `0.1.0` is not a production release identifier. |
| Schema | Apply `116_business_procedures.sql` and `117_human_assistance_requests.sql` through explicit schema setup before matching API/worker startup. Existing unknown schema digests remain rejected. |
| Enablement | Explicit per-agent opt-in. Preserve custom instructions, selected models, permissions and accepted work. No automatic enablement of existing agents. |
| Documentation | This reference, README, product-capabilities and source-boundary record the implemented contracts. |
| Analytics | Not applicable: no new analytics pipeline or dashboard. Existing support analytics do not establish workflow completion. |
| Logging | Reuse the operation journal and existing structured execution errors for tool outcome and correlation. Do not log contact details, consent text, private briefs, message bodies or credentials. No new telemetry exporter or alert service. |
| Validation | Focused checks and the single real-model after-hours journey are recorded by the integrating change. This document does not establish live acceptance. |
| Deployment | Joint owner deployment pending. Inventory serving API/worker/UI releases and active runtime bindings before declaring rollout complete. Production availability is not claimed here. |
| Disable and rollback | Deselect the workflow to stop new use through current-configuration checks. Preserve accepted work and recorded effects. Joint owner rollback is pending; retain the additive tables and compatible handlers for accepted work rather than deleting request/effect evidence. |
| Post-release review | Not scheduled before joint deployment; record it with the rollout identity. |

For an incomplete procedure, inspect its status, route, missing receipts and unknown-effect flag,
then the referenced Inbox request/message and channel delivery records. Reconcile provider
uncertainty before retrying a physical effect. A successful tool receipt proves only its stated
domain outcome, not that a human replied or an external callback occurred.

### Local notice wording correction

The support receipt uses a short date and contains no contact collection question. The
agent asks the next question without repeating the receipt. This wording change retains
request storage, ownership, delivery checks and consent rules. API/schema migrations,
analytics events, logging changes and new alerts are not applicable. Validation covers the
notice regression, procedure contract, API types and module boundaries. Rollout uses the
existing runtime preview/apply mechanism to update local serving bindings; production is
excluded from this local verification. Rollback restores the previous wording and applies
the previous runtime artifact through the same rollout mechanism. The serving source and
local rollout evidence are recorded in the change, rather than using the package default
as a release version.
