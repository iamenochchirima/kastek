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
