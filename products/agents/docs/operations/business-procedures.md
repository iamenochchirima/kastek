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

`support.request_assistance` records the request, staff brief and current support facts through
Inbox. It does not publish a customer message or transfer conversation ownership. The agent gives
the conversational reply: it explains closure, offers help and asks for contact preferences when
needed. `support.update_assistance` requires one explicit action: `save_contact`, `human_only`,
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
request, not a completed phone call. Completion requires domain-validated `customer_choice` and
`assistant_reply` receipts, plus `human_request` for the callback route. The reply receipt proves
that the agent's response was delivered. It does not prove that its wording followed every
playbook instruction. Closure explanations and offers of help remain model-owned conversation
behavior, checked through conversation testing rather than claimed by a backend receipt.
Model-authored checklist claims are insufficient. Missing receipts remain missing and unknown
effects block completion. For connected channels, queued or uncertain outbound delivery does
not establish a confirmed reply.

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

### Local agent-only reply correction

After-hours support uses the agent's normal response publication path. Request IDs and other
internal identifiers stay in tool calls; customer replies acknowledge the outcome without a
reference number. Schedule answers use the saved timezone without unsolicited UTC conversions.
The agent answers the current question with enough detail, without a fixed sentence limit or
repeating contact collection on every turn.
Opening hours do not authorize a promise of a live connection or outreach. Request tools return
facts and durable request outcomes without appending or enqueueing an automatic customer
notice. Existing notice columns and historical notice records remain retained; this correction
needs no schema migration. The ordinary response timer and loading state cover the agent reply.

| Concern | Decision |
| --- | --- |
| Scope | Local Agents API and worker, serving the Labs widget and the existing local runtime bindings. Production deployment is excluded. |
| Schema and contracts | No schema migration. The assistance result permits a missing notice message because the tool no longer publishes one. Existing historical receipt records are retained. |
| Analytics and logging | No new events, metrics, dashboards, exporters or alerts. Existing execution and delivery records retain outcome evidence. Contact details and message bodies are not added to logs. |
| Validation | Focused request/reply regression, procedure contract, API types and module boundaries, plus one real-model after-hours conversation. Record results with the change. |
| Rollout and identity | Use the existing runtime preview/apply control to update local published bindings with the matching API and worker. Record the source commit and rollout result. Do not require manual agent republishing or claim production availability. |
| Rollback | Restore the previous API/worker artifact and apply its runtime bindings through the same control. Preserve request records, custom configuration, permissions and accepted work. |
| Post-release review | Not applicable to production before joint deployment. Review the local conversation with the owner. |

### Customers contact collection

Validated `save_contact` effects populate Customers Contacts in the same transaction. The
Follow-ups view reads support request state directly and links to Contacts and Inbox. It does
not introduce another follow-up state machine. The playbook asks for the customer's name and
preferred contact method, saves provided details promptly and asks for a missing name next.
It neither invents a name nor makes one a prerequisite for a support request. Saved contact
evidence is included in the bound procedure context so a later name can reuse the existing method.

Release scope is local Agents API, worker and UI, including the Labs widget's published binding.
The API adds a member-authorized paginated `customer-records/followups` read. Schema migration
is not applicable; existing contact and request tables are reused. Analytics, new alerts and new
logging pipelines are not applicable. Existing command/evidence records retain operation identity;
the explicit support-contact backfill logs counts only. Run the backfill once after deploying the
API, then refresh Customers. Rollback uses the preceding API/worker/UI artifacts and retains the
contact records; no destructive rollback is required. Production deployment is excluded here.

Contact collection uses a direct question, such as “What's your name and email so the team can
follow up?” The agent asks only for missing details. It handles refusals or a preference for phone
when they arise, rather than explaining all options and optional-field rules upfront. Simple
after-hours acknowledgments use conversational prose without status headings or lists. These
are playbook instructions, not fixed customer text or a global sentence limit.
