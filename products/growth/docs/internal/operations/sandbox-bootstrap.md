---
title: Evaluation sandbox bootstrap
owner: engineering
last_reviewed: 2026-11-10
---

# Evaluation sandbox bootstrap

The evaluation provisioner creates a Growth sandbox as a pair:

- a Growth database, API and owner/business workspace
- a dedicated Agents runtime sandbox
- signed Growth ↔ Agents service keys and a recorded pair

`products/growth/api/src/bootstrap-sandbox.ts` is the product-owned bootstrap for
the Growth side. It is only for isolated evaluation sandboxes:

```sh
DATABASE_URL=<fresh-growth-database> \
GROWTH_BOOTSTRAP_EMAIL=owner@example.local \
GROWTH_BOOTSTRAP_WORKSPACE_NAME="Acme support" \
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_ID=growth-default \
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_REVISION=1 \
node --import tsx products/growth/api/src/bootstrap-sandbox.ts
```

It creates a verified local Growth user, organization with OWNER membership,
BusinessProfile, a local owner session, and a pending `GrowthAgentSetup` job. The
provisioner runs the `growth-agent-setup-worker` to create the four Growth agents
in the paired Agents runtime.

The bootstrap session has a future identity-check timestamp so it can be used
without a running identity provider. It must never be used as a production
authentication path. Production login remains Keycloak OIDC.

## Billing

Every provisioned sandbox receives a real central-billing entitlement:

- Agents sandboxes receive `agents-sandbox-unlimited`.
- Growth sandboxes receive `growth-sandbox-unlimited`.
- The Agents runtime paired with a Growth sandbox receives its own
  `agents-sandbox-unlimited` entitlement.
- Agency sandboxes will receive `agency-sandbox-unlimited` when Agency provisioning
  is implemented.

The control plane needs `EVALS_BILLING_SANDBOX_URL` and
`EVALS_BILLING_SANDBOX_SECRET` (at least 32 bytes). The provisioner calls
`POST /internal/sandbox/entitlement` on the billing service and records the
returned account, subscription, plan key, and plan version in the sandbox runtime.
The billing service must run outside production with `BILLING_SANDBOX_SECRET`
configured.

The sandbox plans grant null internal feature limits and a large test AI credit
balance. Hard concurrency, context, storage, provider rate, and compute limits
remain in force. The provisioner starts Agents child runtimes with
`AGENTS_BILLING_ENFORCEMENT=1`; it does not disable billing or bypass entitlement
checks.

The product processes are detached from the provisioner service. Restarting the
control plane does not stop running sandbox APIs and workers.

## Agent setup

Agents sandboxes expose versioned agent configurations, stored internally as setup
profiles. A setup targets either the existing platform Assistant or a new
customer-service business agent. Applying a setup calls the normal Agents model,
knowledge, agent, capability and publication APIs, then registers the resulting
agent reference in the evaluation control plane.

Profiles can also create custom agents from the full non-channel agent configuration,
merged over the platform Assistant draft. The first business-agent profile uses the
product's built-in knowledge and handoff tools. External calendar credentials are not
copied into the sandbox; a calendar connection fixture remains a separate
provider-integration step.

Common configurations are file-backed templates under
`services/evals/templates/agents/`. The Evals client exposes them through the
**Template** picker in **New profile**; selecting one fills the form, which can still
be edited. Creating the profile starts setup immediately. Templates are validated on
load and never include channels.

## Sandbox sync

The sandbox detail page's **Update sandbox** action applies current agents schema
migrations, restarts the runtime, runs health/session/agent smoke checks and records
a new immutable sandbox version. Growth updates both the Growth runtime and its
paired Agents runtime. Active conversations block the update. Existing workspace
data and historical evidence are preserved.

Sandbox workers share one local Restate server, so each Agents runtime registers
its services under a stable `sbx-<sandbox-id>` prefix. The prefix is applied only
at the Restate registration and dispatch boundary; published compositions keep
the logical workflow names. Worker registration forces rediscovery so restarts
replace stale service revisions instead of reusing them.

## Product agents and chat

The Evals client lists agents from the product workspace through normal product APIs.
A Growth sandbox shows its four default agents after `agent-setup` reaches `ready`.
An Agents sandbox shows its workspace agents, including the platform Assistant.

Each product agent is registered as a control-plane agent reference keyed by its
feature revision or published product version. Chat creates or continues a normal
product conversation, waits for the product task to settle, and records the session,
turn and digests in the control plane. Transcript text remains in the product runtime
and is read back through the product API.

Growth model selection is feature-level, matching the product: it applies to new
messages. The sandbox provisioning expands the Growth model grant to the full model
catalogue in the paired Agents runtime, so the Evals chat model picker can select any
tool-capable model allowed by the provider. Existing messages keep their original
model evidence.

This is also the first evaluation target path: an evaluation run can select one of
these registered agent references instead of creating an agent ad hoc.

### Product-agent chat release record

| Field | Decision |
| --- | --- |
| Change | List product agents in the Evals client and chat with them through normal product APIs. |
| Owner | Engineering. |
| Risk | Standard: interactive access uses normal workspace permissions and sandbox owner sessions. |
| Affected surfaces | Evals service and client, Growth agent conversations/tasks, Agents conversations/tasks, control-plane session references. |
| Migration | None. Existing `agent_refs`, `interactive_sessions` and `interactive_turns` tables are reused. |
| Rollout | Rebuild and restart the Evals service and client. Existing sandboxes must already have the current product schema for chat. |
| Analytics and logs | Service logs record chat task outcomes and session references. Transcript text is not copied into Evals logs. |
| Documentation | This page, `services/evals/README.md` and `apps/evals/README.md`. |
| Validation | Eval tests 28/28; live Growth product-agent listing and chat returned four ready agents, recorded a control-plane session, continued the conversation, listed 363 tool-capable models and switched the assistant model through the client route. |
| Rollback | Remove the product-agent/chat routes from the client and service. Existing control-plane session references remain readable. |
| Post-release review | Review before Phase 4 evaluation runs start. |

## Deleting sandboxes

`DELETE /v1/sandboxes/:id` removes runtime resources for one sandbox. Deleting
either half of a Growth/Agents pair removes both sandboxes. The operation:

- stops the recorded Agents or Growth API and worker processes;
- drops the product database;
- removes `.audit/sandboxes/<sandbox-id>`;
- attempts to delete the Agents object-storage bucket;
- retires the control-plane record and hides it from the client list.

Central-billing sandbox accounts and zero-priced subscriptions are retained for
audit. Restate deployment records may also remain until a separate cleanup pass.

Bulk deletion uses `DELETE /v1/sandboxes` with `{"confirm":"DELETE"}`. The
registry and its session/outcome references are retained as retired records for
audit. A sandbox that is still provisioning is rejected until the current
provisioning run finishes or fails.

## Deletion release record

| Field | Decision |
| --- | --- |
| Change | Add confirmed single and bulk sandbox deletion with pair-aware cleanup. |
| Owner | Engineering. |
| Risk | High: destructive local resource deletion. |
| Affected surfaces | Evaluation control plane, Evals client UI and API, Agents and Growth sandbox processes, product databases, local sandbox files, Agents object-storage buckets. |
| Migration | None. Uses the existing `retired` status and `retired_at` timestamps. |
| Rollout | Rebuild and restart the eval service and client. |
| Analytics and logs | The service logs `sandbox.deleted` and `sandboxes.deleted` with sandbox IDs and cleanup counts. No customer analytics event is added. |
| Documentation | This page, `services/evals/README.md`, `apps/evals/README.md`, and `ARCHITECTURE.md`. |
| Validation | Eval suite 27/27; deletion verified on live Agents and Growth pairs after restarting the control plane. Processes stopped, databases dropped, directories removed, buckets deleted and records retired. |
| Rollback | Restore the control-plane database backup and reprovision deleted sandboxes. Deleted product databases and local files cannot be recovered. |
| Post-release review | Review before Phase 4 evaluation starts. |

## Release record

| Field | Decision |
| --- | --- |
| Change | Attach real central-billing sandbox plans during local sandbox provisioning. |
| Owner | Engineering. |
| Risk | Standard: access entitlements, test credits, provisioning, and local process lifecycle. |
| Affected surfaces | Billing service, evaluation control plane, Agents sandbox APIs and workers, Growth sandboxes, paired Agents runtimes, Evals UI and client. |
| Migration | `services/billing/migrations/006_sandbox_scope.sql` adds account environment and plan audience. |
| Rollout | Apply billing migration `006`, seed the `*-sandbox-unlimited` plans, set `BILLING_SANDBOX_SECRET`, set `EVALS_BILLING_SANDBOX_URL` and `EVALS_BILLING_SANDBOX_SECRET`, rebuild the eval service, and provision new sandboxes. Existing sandboxes receive the plan through the same endpoint and their runtimes restart with billing enforcement enabled. |
| Analytics and logs | Billing records `sandbox.entitlement.assign`. Provisioner steps expose `billing` status. No customer analytics event is added. |
| Documentation | This page, central billing architecture, billing README, and eval service README. |
| Validation | Billing and eval test suites pass; fresh Agents, Growth, and Growth-paired Agents sandboxes reached `ready` with active sandbox plans; Agents analytics and billing snapshots returned active access with null internal limits; Growth bootstrap and billing summary returned the unlimited Growth plan. |
| Rollback | Stop the eval service and remove the sandbox env credentials. Running sandboxes keep their assigned subscription until the sandbox is retired. Do not convert a sandbox account to production or attach a production plan as a rollback. |
| Post-release review | Review before Phase 4 evaluation starts. |


## Agent setup and sync release record

| Field | Decision |
| --- | --- |
| Change | Add versioned agent setup profiles for the platform Assistant and business agents, and an explicit sandbox code/schema update action. |
| Owner | Engineering. |
| Risk | Standard: normal Agents APIs, isolated sandbox data, explicit sync confirmation. |
| Affected surfaces | Evals control plane and client, Agents sandboxes, Growth sandbox paired runtime, Agents model/knowledge/agent setup APIs. |
| Migration | `services/evals/migrations/007_agent_profiles.sql`. |
| Rollout | Rebuild and restart the eval service and client. The service applies migration 007 and restores ready sandbox runtimes. |
| Analytics and logs | Setup apply and sandbox sync record structured service logs and control-plane step/error records. No customer analytics event is added. |
| Documentation | This page, Evals service and client READMEs, and ARCHITECTURE.md. |
| Validation | Eval suite 29/29; live platform Assistant and customer-service business-agent profiles published and registered; sandbox sync applied migrations, restarted the runtime, smoke-checked and recorded a new sandbox version. Calendar credential fixture remains pending. |
| Rollback | Remove the profile/sync routes and UI. Existing published agent versions remain valid. A failed sync is recorded; the current runtime is restarted from the current source. |
| Post-release review | Review before evaluation datasets and runs. |

## Agent template catalogue release record

| Field | Decision |
| --- | --- |
| Change | Add a file-backed agent template catalogue and a template picker in the Evals **New profile** dialog. |
| Owner | Engineering. |
| Risk | Standard: control-plane configuration presets only; applying a template uses the existing profile and Agents APIs. |
| Affected surfaces | Evaluation service template loader and `GET /v1/agent-templates`, Evals client profile dialog, service and client documentation. No product database, runtime or sandbox schema change. |
| Migration | None. Templates are JSON files under `services/evals/templates/agents/`. |
| Rollout | Rebuild and restart the eval service and client. Existing profiles and sandboxes are unchanged; no sandbox sync is required for the catalogue itself. |
| Analytics and logs | The template endpoint uses normal request logging. Template validation failures return `template_invalid`. No customer analytics event is added. |
| Documentation | This page, `services/evals/README.md` and `apps/evals/README.md`. |
| Validation | Eval suite 35/35, including template catalogue and invalid/duplicate template tests. Live `support-full` template applied to the Agents sandbox produced a published agent with all four responsibilities, enquiry tools and support hours; enquiries readiness is `ready`, bookings correctly require an authorized calendar policy, and private knowledge remains flagged only for customer-facing website use. |
| Rollback | Remove the template endpoint, picker and template files. Profiles created from templates remain valid immutable profile versions. |
| Post-release review | Review before evaluation datasets and runs. |

## Standalone Agents chat isolation release record

| Field | Decision |
| --- | --- |
| Change | Namespace each sandbox's Restate services and map Agents task input/output into chat messages. |
| Owner | Engineering. |
| Risk | Standard: runtime routing and transcript presentation; no schema or permission change. |
| Affected surfaces | Evals provisioner and chat adapter, Agents worker registration, dispatcher, workflow definitions, customer-followup readiness, Evals documentation. |
| Migration | None. |
| Root cause | Sandbox workers shared one Restate instance and registered the same global service names. A worker from another sandbox, or a stale deployment, received invocations for tasks it could not load. Agents conversation reads also return tasks rather than messages, so the chat response was empty even after a successful run. |
| Fix | Prefix registered and dispatched Restate service names with a stable `sbx-<sandbox-id>` namespace while keeping logical workflow names in product records. Force worker registration to rediscover services. Map settled task input/output to user/assistant chat messages when no message list is returned. |
| Rollout | Rebuild the eval service and Agents API, then sync or force-restart each sandbox runtime. Each runtime adopts its namespace on restart. |
| Analytics and logs | Worker registration still records the deployment ID. Chat execution continues to use the existing task and session records. No customer analytics event is added. |
| Documentation | This page, `services/evals/README.md` and the Agents shared-runtime runbook. |
| Validation | Eval suite 36/36; focused Agents restate-name and dispatcher tests 6/6. Live standalone Agents chat completed with mapped user/assistant messages. A custom knowledge agent answered `ORBIT-42` through its knowledge tool. Growth chat completed after its paired worker registered a separate namespace. Both sandboxes registered distinct `sbx-aba713a07365-*` and `sbx-dd61895ba563-*` service sets, and standalone chat still completed after the paired worker registration. |
| Rollback | Unset the namespace, restart and force-register the worker. Tasks already pinned to namespaced services remain readable; settle or cancel them before removing the namespace. |
| Post-release review | Review before evaluation datasets and runs. |
