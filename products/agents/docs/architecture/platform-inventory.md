# Agents platform inventory

Current surface inventory for the platform upgrade. Derived on 18 November 2026 from
`codex/agents-platform-upgrade` at `be78bc600`. This records what exists now. It is not a plan and
does not approve a deletion.

Regenerate the counts with:

```sh
cd products/agents/api
node -e 'const fs=require("fs"),p=require("path");const f=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const x=p.join(d,e.name);e.isDirectory()?w(x):e.name.endsWith(".ts")&&f.push(x)}})("src");let n=0,rows=[];for(const x of f){let c=0;for(const l of fs.readFileSync(x,"utf8").split("\n"))c+=(l.match(/\bapp\.(get|post|put|patch|delete|head|options)\(/g)||[]).length;if(c)rows.push([x,n+=c])}console.log(n,rows.length)'
grep -rhoE "CREATE TABLE (IF NOT EXISTS )?agents_platform\.[a-z_0-9]+" schema/*.sql | sort -u | wc -l
```

The HTTP count is route registrations, so a path registered in two places counts twice. The
persisted count is distinct tables created across `schema/`.

## HTTP surface

339 route registrations across 45 modules. Two modules do not mount on the API app:
`adapters/executors/executor-host.ts` runs as the separate executor process
(`composition/executor.ts`), and `acceptance/report-receiver.ts` exports a receiver that no API
entry point registers.

| Module | Routes | Mount point |
| --- | ---: | --- |
| `composition/app.ts` | 46 | Session, task detail and admission, evaluation trials, website widget, health |
| `platform/agents/http.ts` | 17 | `/api/organizations/:organizationId/agents/*`, `/offerings` |
| `platform/runs/http.ts` | 6 | Conversation and task lists, task events, task cancel, conversation read and delete |
| `product/channels/channel-routes.ts` | 27 | `/api/organizations/:organizationId/channels` |
| `product/inbox/inbox-routes.ts` | 19 | `/api/organizations/:organizationId/inbox`, `/api/website/:deploymentId/customer-conversations` |
| `integrations/http/application-routes.ts` | 13 | `/api/organizations/:organizationId/applications`, `/v1/agents`, `/v1/runs` |
| `product/connections/provider-routes.ts` | 13 | `/api/organizations/:organizationId/providers/:providerId` |
| `product/model-providers/routes.ts` | 13 | `/api/organizations/:organizationId/model-providers` |
| `product/agents/knowledge-routes.ts` | 11 | `/api/organizations/:organizationId/agents/:agentId/knowledge` |
| `product/agents/memory-routes.ts` | 11 | `/api/organizations/:organizationId/agents/:agentId/memory` |
| `product/agents/skill-package-routes.ts` | 11 | `/api/organizations/:organizationId/agents/:agentId/skills` |
| `product/customer-records/routes.ts` | 11 | `/api/organizations/:organizationId/customer-records` |
| `product/members/routes.ts` | 11 | `/api/organizations/:organizationId` |
| `product/connections/actions-routes.ts` | 10 | `/api/organizations/:organizationId` |
| `product/connections/api-connection-routes.ts` | 9 | `/api/organizations/:organizationId/api-connections` |
| `product/mcp/oauth.ts` | 9 | `/oauth/*`, `/.well-known/*`, `/api/mcp/oauth/*` |
| `product/connections/remote-connection-routes.ts` | 8 | `/api/organizations/:organizationId/remote-connections` |
| `product/automations/automation-routes.ts` | 7 | `/api/organizations/:organizationId/automations` |
| `product/channels/channel-support-routes.ts` | 7 | `/api/organizations/:organizationId/inbox/:conversationId` |
| `product/agents/transfer-routes.ts` | 6 | `/api/organizations/:organizationId/agents/:agentId/transfers`, `/api/agent-transfers/:token` |
| `product/billing/routes.ts` | 6 | `/api/public/plans`, `/api/organizations/:organizationId/billing` |
| `product/customer-followup/routes.ts` | 6 | `/api/website/:deploymentId/customer-conversations/:conversationId/followup` |
| `product/customers/routes.ts` | 6 | `/api/admin/customers/:customerId` |
| `workflows/booking/routes.ts` | 6 | `/api/organizations/:organizationId/agents/:agentId/booking-policies` |
| `product/agents/website-crawl-routes.ts` | 5 | `/api/organizations/:organizationId/agents/:agentId/website-crawls` |
| `product/mcp/server.ts` | 5 | `/mcp`, `/.well-known/oauth-protected-resource*` |
| `product/deployments/appearance-routes.ts` | 4 | `/api/organizations/:organizationId/agents/:agentId/deployments/:deploymentId/appearance` |
| `product/enquiries/routes.ts` | 4 | `/api/organizations/:organizationId/enquiries` |
| `product/inbox/support-presence-routes.ts` | 3 | `/api/organizations/:organizationId/inbox-presence` |
| `product/reporting/routes.ts` | 3 | `/api/admin/reporting*`, `/internal/operations/signals` |
| `product/catalogue/catalogue-routes.ts` | 2 | `/api/organizations/:organizationId/connectors`, `/catalogue/:kind` |
| `product/connections/application-sharing.ts` | 2 | `/api/organizations/:organizationId/connections/:connectionId/application-sharing` |
| `product/connections/tool-review-routes.ts` | 2 | `/api/organizations/:organizationId/tasks/:taskId/tool-reviews` |
| `product/identity/auth-routes.ts` | 2 | `/api/auth/*` |
| `product/inbox/support-alert-routes.ts` | 2 | `/api/organizations/:organizationId/inbox-alerts` |
| `product/integrations/agency-routes.ts` | 2 | `/internal/v1/products/agencies/*` |
| `product/integrations/growth-routes.ts` | 2 | `/internal/v1/products/growth/commands`, `/usage` |
| `product/model-providers/dependencies.ts` | 2 | `/api/organizations/:organizationId/model-providers/:connectionId` |
| `product/overview/routes.ts` | 2 | `/api/organizations/:organizationId/overview` |
| `product/analytics/routes.ts` | 1 | `/api/organizations/:organizationId/analytics/inbox` |
| `product/channels/channel-webhooks.ts` | 1 | `/internal/agents/channel-events` |
| `product/integrations/growth-channels.ts` | 1 | `/internal/v1/products/growth/channels` |
| `product/integrations/growth-provisioning.ts` | 1 | `/internal/v1/products/growth/provision` |
| `product/model-providers/model-policy.ts` | 1 | `/api/organizations/:organizationId/agents/:agentId/model-policy` |
| `product/operations/source.ts` | 1 | `/internal/operations/signals` |
| `acceptance/report-receiver.ts` | 1 | `/deliveries` (separate process) |
| `adapters/executors/executor-host.ts` | 1 | `/v1/resources/commands` (separate executor process) |

Current code owners follow the source tree: 46 routes are registered directly in
`composition/app.ts`, 291 sit in `product/`, `integrations/`, `platform/` and `workflows/`, and 2
belong to separate processes. The plan's target moves request handling to `integrations/` and the
decisions behind it to `platform/`.

## Entries targeted for change or retirement

| Surface | Today | Change | Replacement | Last known caller |
| --- | --- | --- | --- | --- |
| `product-capabilities-v13` / `AgentsBusinessRunV23` | Registered in the worker and dispatcher route map | Retire once no active task pins it. No current code publishes v13. | `product-capabilities-v15` / `AgentsBusinessRunV25` | Tasks admitted while v13 was current; count requires a production query |
| `POST /internal/v1/products/growth/commands` | Product-to-product command endpoint | Replace with shared platform run and tool operations; keep a Growth adapter | `POST /v1/runs` semantics under a product caller | `products/growth/api/src/agents/client.ts` |
| `POST /internal/v1/products/growth/provision` | Product provisioning endpoint | Same; provisioning becomes a platform operation | Platform agent create and publish | `products/growth/api/src/agents/provisioning-client.ts` |
| `/internal/v1/products/growth/channels`, `/usage` | Reporting and channel administration | Same | Platform channel and usage operations | `products/growth/api/src/agents/channel-admin-client.ts`, `usage-feed.ts` |
| `POST /internal/v1/products/agencies/commands`, `/model` | Product-to-product command endpoint | Same | Platform run and model operations | `products/agency/api/src/capabilities/execution-client.ts` |
| Inbound MCP management tools (`POST /mcp`) | Calls product stores directly | Call the same platform operations as HTTP | Platform management operations | MCP clients through OAuth; see `mcp-integration.md` |
| `product/connections/*` management routes | Mounted under `/api/organizations/...` | Move handlers to `platform/tools` and `integrations/http`; paths and payloads stay | Same paths | `products/agents/web/src/platform/connections.tsx` |
| Agent management routes | Handlers moved to `platform/agents/http.ts`; composition passes the store, creation operations and product defaults as ports | Move the store and creation operations behind the same module, then delete the port wiring | `products/agents/web/src/platform`, inbound MCP |
| Application DTOs | Inline shapes in `integrations/http/application-routes.ts` | Move consumer schemas to `packages/contracts` | One shared DTO set | `applications-settings.tsx`, external applications |
| Task and conversation read and control | Lists, task events, task cancel, conversation read and conversation delete moved to `platform/runs/http.ts`; archive and restore remain inline | Resolve the archive/restore conflict, then move task detail, admission, evidence, artifacts, instructions and continuation | Same paths | `products/agents/web/src/platform/assistant-launcher.tsx` |
| Billing entitlement read in `execution/admission/admission-store.ts` | Direct import from `product/billing` | Replace with an admission port provided by composition | Port in `contracts/` with the billing implementation injected | Internal only; recorded as accepted boundary debt |
| `POST /deliveries` | Acceptance harness receiver | Keep out of the API process | None | Evaluation harness |

Not targeted: `/health`, `/ready`, `/internal/operations/signals`, website widget and visitor
routes, channel webhooks, MCP OAuth metadata, and admin reporting remain part of the platform
surface.

## Runtime and scheduled registrations

Restate service names are prefixed by `AGENTS_RESTATE_NAMESPACE` when set. Each workflow below is
registered in `composition/worker.ts`.

| Registration | Kind | Release or name | Owner | Change |
| --- | --- | --- | --- | --- |
| Current business run | Restate workflow | `product-capabilities-v11` / `AgentsBusinessRunV21` | execution/business | Keep |
| Handoff business run | Restate workflow | `product-capabilities-v12` / `AgentsBusinessRunV22` | execution/business | Keep |
| Legacy adaptive run | Restate workflow | `product-capabilities-v13` / `AgentsBusinessRunV23` | execution/business | Retire with its tasks |
| Adaptive run | Restate workflow | `product-capabilities-v14` / `AgentsBusinessRunV24` | execution/business | Keep while published versions select it |
| Shared run | Restate workflow | `product-capabilities-v15` / `AgentsBusinessRunV25` | execution/business | Keep |
| Context compaction | Restate workflow | `AgentsContextCompactionV1` | platform/context | Keep |
| Automation | Restate workflow | `AgentsAutomationV1` | product/automations | Listed capability, unavailable for new setup |
| Support waiting | Restate workflow | `AgentsSupportWaitingV1` | product/inbox | Keep |
| Handoff receipt | Restate workflow | `AgentsHandoffReceiptV1` | product/inbox | Keep |
| Support status | Restate workflow | `AgentsSupportStatusV23` | execution/business | Keep |
| Customer follow-up | Restate workflow | `AgentsCustomerFollowupV1` | product/customer-followup | Keep |
| Knowledge import | Restate workflow | `AgentsKnowledgeImportV1` | capabilities/knowledge | Keep |
| Task dispatcher | Dispatcher loop | Release-to-workflow route map | platform/runs | Keep |
| Automation, support waiting, handoff receipt, follow-up and ingestion dispatchers | Dispatcher loops | Respective workflow names | Product and capability owners | Keep |
| Preparation timer, memory retention, document reaper, source object reaper, billing usage forwarding | Timers and loops | 60s, 15s and per-run schedules | platform, product | Keep |

## Persisted record groups

231 tables. No table is proposed for deletion and no destructive reset is proposed. Retention and
tombstone rules continue to apply.

### Identity, membership and admission

Owner: platform/access. Carries forward. Accounts and memberships are the ownership record.

`accounts`, `login_transactions`, `logout_tokens`, `member_channel_links`, `member_channel_tasks`, `member_permission_overrides`, `memberships`, `organization_invitations`, `organizations`, `platform_admission_gate`, `platform_admission_gate_events`, `sessions`, `tenant_admission` (13)

### Agents and published versions

Owner: platform/agents. Carries forward. Drafts and immutable versions are the agent record.

`agent_transfer_sources`, `agent_transfers`, `agent_versions`, `agents`, `version_connected_tools`, `version_sources` (6)

### Runs, operations and grants

Owner: platform/runs. Carries forward. Pending runs must be resolved before cutover.

`application_credentials`, `applications`, `artifact_citations`, `artifacts`, `delegations`, `execution_grants`, `execution_objects`, `execution_roots`, `model_cost_reservations`, `model_request_manifests`, `operation_usage`, `operations`, `root_model_accounts`, `task_artifact_transfers`, `task_controls`, `task_events`, `task_model_routes`, `task_outbox`, `tasks` (19)

### Orchestration and capacity

Owner: platform/scheduling. Carries forward. Queue and capacity records are operational state.

`billing_usage_forwarded`, `capacity_buckets`, `capacity_holds`, `capacity_notifications`, `capacity_requests`, `capacity_slot_ranges`, `capacity_slots`, `capacity_tenants`, `orchestration_input_closures`, `orchestration_instructions`, `orchestration_progress`, `orchestration_progress_updates`, `orchestration_stall_decisions`, `scheduling_tenants`, `usage_accounts`, `usage_ledger`, `usage_reservations` (17)

### Conversations and retained context

Owner: platform/conversations, platform/context. Carries forward. Compaction inputs and summaries must keep their current owner.

`context_compaction_jobs`, `context_continuity_checkpoints`, `context_continuity_heads`, `context_snapshots`, `conversation_retention_policies`, `conversation_retention_policy_events`, `conversation_retention_tombstones`, `conversations`, `customer_conversation_counters`, `customer_conversations`, `customer_messages`, `customer_task_links`, `evidence_contents`, `evidence_history_links`, `evidence_nodes`, `evidence_references`, `private_model_continuations`, `product_conversations` (18)

### Knowledge

Owner: platform/knowledge. Carries forward. Source revisions and embeddings back the optional Knowledge capability.

`chunk_embeddings`, `document_allocations`, `ingestion_jobs`, `ingestion_outbox`, `knowledge_object_contents`, `query_embedding_allocations`, `source_chunks`, `source_deletions`, `source_mutations`, `source_objects`, `source_revision_policy`, `source_revisions`, `source_sections`, `sources` (14)

### Memory

Owner: platform/memory. Carries forward. Retention and tombstone rules apply to recall and deletion.

`memories`, `memory_deletion_tombstones`, `memory_mutations`, `memory_revision_fingerprints`, `memory_revisions`, `memory_scopes`, `memory_suppressions` (7)

### Tools, connectors and connections

Owner: platform/tools, platform/connectors. Carries forward. Credentials stay in custody; policy revisions gate reuse.

`api_connection_settings`, `api_import_catalogs`, `api_operation_selections`, `api_operation_templates`, `capability_bindings`, `capability_catalogs`, `capability_mutations`, `connected_attempts`, `connected_discoveries`, `connected_handles`, `connected_reads`, `connected_reconciliation_attempts`, `connected_response_bodies`, `connected_uncertain_escalations`, `connected_uncertainty_notices`, `connection_credentials`, `connection_mutations`, `connection_oauth_attempts`, `connection_onboarding`, `connections`, `tool_invocation_reviews` (21)

### Skills

Owner: capabilities/skills. Carries forward while the capability is enabled.

`skill_installation_mutations`, `skill_installation_states`, `skill_package_reviews`, `skill_packages`, `skill_repository_sources`, `skill_revisions`, `skill_script_executions` (7)

### Models

Owner: platform/models. Carries forward. Provider credentials remain server-side.

`automation_model_routes`, `model_provider_catalogue_controls`, `model_provider_catalogues`, `model_provider_connections`, `model_provider_credentials`, `model_provider_data_policies`, `model_provider_data_policy_restore_fences`, `model_provider_defaults`, `model_provider_manual_models`, `model_provider_use_grants`, `model_provider_verifications`, `product_model_defaults` (12)

### Channels, inbox and support

Owner: product/ (standalone Agents), integrations/channels. Carries forward. Channel credentials and consent records are customer data.

`channel_assets`, `channel_connections`, `channel_contact_consents`, `channel_credentials`, `channel_delivery_recovery`, `channel_deployments`, `channel_ingress`, `channel_message_facts`, `channel_outbound`, `channel_receipts`, `channel_send_limits`, `channel_setup_claims`, `channel_setup_resource_claims`, `channel_setup_sessions`, `customer_followup_access`, `customer_followup_challenges`, `customer_followup_notifications`, `customer_followup_preferences`, `customer_followup_reads`, `customer_followup_runtime`, `human_assistance_commands`, `human_assistance_requests`, `pending_handoff_receipts`, `support_presence`, `support_staff_alerts`, `support_status_executions`, `support_status_notices`, `support_waiting`, `support_waiting_notices`, `website_appearance_drafts`, `website_crawls`, `website_deployments`, `website_rate_limits`, `website_sessions` (34)

### Customer records, enquiries and follow-up

Owner: product/. Carries forward. Customer records belong to the workspace.

`customer_cancellations`, `customer_commands`, `customer_contacts`, `customer_deliveries`, `customer_record_activity`, `customer_record_commands`, `customer_record_enquiries`, `customer_record_submissions`, `customer_timeout_notices`, `enquiries` (10)

### Bookings

Owner: capabilities/workflows (installed workflow). Carries forward. Booking attempts and policies are business records.

`booking_attempts`, `booking_intents`, `booking_policies`, `booking_slots` (4)

### Workflows, sandbox and executors

Owner: capabilities/ (workflows, sandbox). Carries forward. Procedure instances and sandbox allocations are durable work.

`business_procedure_commands`, `business_procedure_instances`, `google_calendar_connections`, `google_calendar_oauth_attempts`, `resource_executor_hosts`, `resource_executor_owners`, `sandbox_allocations`, `sandbox_commands` (8)

### Automations

Owner: product/automations (listed capability). Carries forward. Listed as unavailable for new work.

`action_decisions`, `actions`, `automation_mutations`, `automation_occurrences`, `automation_revisions`, `automation_timer_outbox`, `automations` (7)

### MCP OAuth and reviews

Owner: integrations/mcp. Carries forward. Client and refresh records are live credentials.

`mcp_configuration_reviews`, `mcp_oauth_authorize_limits`, `mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_connections`, `mcp_oauth_refresh`, `mcp_oauth_requests`, `mcp_preview_provenance`, `mcp_references`, `mcp_source_reviews`, `mcp_website_reviews` (11)

### Evaluation

Owner: product/evaluation. Carries forward. Trials are isolated and product-owned.

`evaluation_channel_effects`, `evaluation_trial_channels`, `evaluation_trial_messaging_channels`, `evaluation_trials` (4)

### Growth and Agency integration

Owner: integrations/ (cross-product). Decision required. These records follow the consumer cutover.

`growth_capability_publications`, `growth_channel_grants`, `product_capability_publications`, `product_command_receipts`, `product_default_provisions`, `product_execution_authorities`, `product_execution_features`, `product_execution_tenants`, `product_operation_access`, `product_references`, `product_request_results`, `product_review_projections`, `product_service_assertions`, `product_task_contexts` (14)

### Observability and billing handoff

Owner: observability/. Carries forward. No conversation text is exported.

`analytics_event_receipts`, `observation_exports` (2)

### Assistants and administration

Owner: product/assistant, product/reporting. Carries forward. Private assistant and admin views are product-owned.

`admin_customer_nonces`, `admin_customer_operations`, `organization_assistants` (3)

## Callers

| Caller | Surface | Evidence |
| --- | --- | --- |
| Standalone Agents UI | `/api/organizations/...`, `/api/session`, `/api/auth/*`, `/api/website/...` | `products/agents/web/src/platform/api.ts`, `platform/connections.tsx` |
| Growth API | `/internal/v1/products/growth/*`, `/internal/agents/channel-events` | `products/growth/api/src/agents/{client,provisioning-client,channel-admin-client,usage-feed}.ts`, `agents/channel-events.ts` |
| Agency API | `/internal/v1/products/agencies/*` | `products/agency/api/src/capabilities/execution-client.ts` |
| External applications | `/v1/agents`, `/v1/runs` | `products/agents/docs/application-api.md`; tests in `application-access.test.ts` |
| MCP clients | `/mcp`, `/oauth/*`, `/.well-known/*` | `products/agents/docs/mcp-integration.md` |
| Website visitors and widget | `/api/website/:deploymentId/*` | `products/agents/web/test/website-followup.spec.ts`, widget routes in `composition/app.ts` |
| Channel providers | `/internal/agents/channel-events` | `products/growth/api/src/agents/channel-events.ts`, channel adapters |
| Operations and analytics services | `/internal/operations/signals` | `services/operations/src/worker.ts`, `services/analytics/src/operations-source.ts` |
| Evaluation service and UI | `/api/organizations/...` (agent setup, conversations, models) | `services/evals/src/product-agents.ts`, `product-chat.ts`, `product-models.ts`; `apps/evals` |
| Admin site | `/api/admin/*` | `apps/admin-site/src/app/(dashboard)/operations/page.tsx` |
| Evaluation harness | `POST /deliveries` | acceptance receiver, separate process |

## Operator entry points

These commands run outside HTTP and have no external caller. They are part of the operator surface
the plan must keep working while modules move.

| Command | Entry | Owner |
| --- | --- | --- |
| `setup:db` | `composition/setup.ts` | platform |
| `control:admissions`, `control:runtime` | `composition/control-admissions.ts`, `rollout-runtime.ts` | platform/runs |
| `setup:growth-model`, `control:growth` | `composition/provision-growth-model.ts`, `control-growth.ts` | integrations (Growth) |
| `backfill:knowledge`, `backfill:support-contacts` | `composition/backfill-knowledge.ts`, `backfill-support-contacts.ts` | platform/knowledge, product |
| `memory-retention`, `retention:ledger` | `composition/memory-retention.ts`, `retention-ledger.ts` | platform/memory |
| `document-reaper`, `source-object-reaper`, `sandbox-reaper` | `composition/document-reaper.ts`, `source-object-reaper.ts`, `sandbox-reaper.ts` | platform/knowledge, capabilities/sandbox |
| `verify:firecrawl` | `composition/firecrawl-smoke.ts` | capabilities (web retrieval) |

## Decisions this inventory does not make

- When the Growth and Agency service endpoints cut over. The platform owns those interfaces; the
  records carry forward either way.
- Which tasks still pin `product-capabilities-v13`. That needs a query against the serving database.
- How much of the inbound MCP management surface maps to which platform operation.
- Whether application API access is plan-entitled. No entitlement check exists today.

## Not established here

Callers outside this repository, the live deployment inventory, and production task counts. This
document covers the source tree only.
