---
id: early-access
title: Early Access Operations
sidebar_position: 7
owner: platform-ops
last_reviewed: 2026-08-29
---

# Early Access Operations

Early access is an operator-approved beta workflow. A public application records interest only;
it does not create a workspace or grant access. The `Beta` label in Labs, Admin, and the client is
informational and is not an authorization check.

## Lifecycle

Applications use the following states:

`new` → `reviewing` → `approved` → `invited` → `active`

An application may be rejected during review. Approved, invited, and active access can be
revoked. Access with an end date is marked expired by the Core status/list operations; the linked
workspace and audit history remain intact.

The default beta package is 30 days, 100 credits, and the registered Analytics, Inbox, Agents,
Campaigns, and Content capabilities. Admin approval can reduce the capability set or change the
duration and credit amount within the Core limits.

## Operator workflow

1. Open **Early access** in Admin and review applications in `new` or `reviewing`.
2. Record a rejection reason when declining an application.
3. Select **Review approval**. Core checks whether the applicant email already belongs to an
   account. For a new account, approve with the workspace name, duration, credits, and
   capabilities; Core provisions the account, workspace, grants, and invitation. For an existing
   account, select the intended workspace and choose **Grant access**. This applies the grants to
   that workspace, marks access active, and does not create a duplicate account or invitation.
   **Create new workspace** remains available when the operator intentionally wants a separate
   workspace under the existing account.
4. If delivery fails, the invitation remains durable and **Resend invite** can be used. The raw
   invitation token is never shown in Admin or stored in the application record. Resending
   replaces the pending invitation with a new seven-day invitation and invalidates the previous
   pending record.
5. Use **Revoke** for approved, invited, or active access. It revokes a pending invitation,
   closes early-access entitlement grants, and removes only unused early-access credits.
6. Use **Restore access** for a revoked application when access should be reopened. Core keeps the
   same workspace and history, reissues active entitlement and credit grants, and sends a fresh
   invitation when the applicant never activated. An applicant who had already activated returns
   to `active` without a duplicate invitation.

Approval is idempotent by application ID. Retrying an approval reuses the linked organisation,
pending invitation, active grants, and credit idempotency key rather than creating another access
package. An approval attached to an existing account returns the already-active application on
retry. Restore and revoke cycles use separate event-scoped credit idempotency keys, so a second
restore does not reuse a revoked credit lot.

## Troubleshooting

- **The public form returns 403 or 500:** the Labs `/api/waitlist` route must reach the Core API
  origin, not the client frontend. Production defaults to `https://api.kasitek.co.za`; set
  `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL` or `RUST_API_BASE_URL` when deploying another environment.
  A Core connectivity failure is returned to the form as HTTP 503 with a retryable message.
- **The browser reports a `sw.js` fetch error on Labs:** Labs does not use a service worker. The
  Labs deployment serves a one-shot cleanup worker at `/sw.js` for browsers that still have the
  old client PWA registration; reload once after the deployment and confirm the registration is
  removed in browser storage.
- **Application does not appear:** check the Admin status/search filters and confirm the Core
  database migration `20260827120000_add_early_access_lifecycle`,
  `20260827130000_add_early_access_cohort`,
  `20260827140000_allow_early_access_credit_source`, and
  `20260827150000_prevent_duplicate_early_access_applications` are applied.
- **Existing account has no workspace options:** confirm the account email matches exactly and
  use the new-workspace option if a separate workspace is intended. Core creates the workspace
  for the existing account without creating another user.
- **The selected workspace is rejected:** the workspace must belong to the applicant account. Use
  **Refresh** to reload the application and workspace options, then select one of the listed
  workspaces.
- **Invitation email is missing:** inspect Core logs for the invitation ID and email delivery
  error, then resend from Admin. A successful workspace provisioning does not roll back because a
  provider rejected the email; the resend action creates a fresh pending invitation.
- **Access was revoked by mistake:** open the revoked application and choose **Restore access**.
  Confirm the resulting status and new grant IDs in the application details and lifecycle events.
- **Workspace still shows access after expiry:** confirm the Core status operation has run and
  inspect the entitlement grant `endsAt`. The resolver must enforce the end date server-side; do
  not hide the feature in the client as a workaround.
- **Unexpected access:** revoke the application, inspect its lifecycle events and grant IDs, and
  preserve the application for audit/support review.

## Data and privacy

Applications contain business contact details and use-case notes. Keep access to the Admin role
set, do not copy invitation tokens or provider credentials into tickets, and follow the platform’s
retention/deletion policy when that policy is approved. Lifecycle logs contain IDs, statuses,
bounded reasons, and actor IDs; they do not contain invitation tokens or email bodies.

## Rollback and disablement

To disable intake, remove or protect the public Labs route at the deployment edge and leave the
Core records intact. Do not roll back the migration after applications have been stored. Revert the
application/UI code only after confirming the existing waitlist reader can still read the added
nullable/defaulted fields. Existing organisation invitations, paid subscriptions, and ordinary
signup remain separate from the early-access lifecycle.
