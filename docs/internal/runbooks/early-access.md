---
id: early-access
title: Early Access Operations
sidebar_position: 7
owner: platform-ops
last_reviewed: 2026-08-29
---

# Early Access Operations

Early access is an approval-gated signup flow. An application records interest only. Admin
approval creates a seven-day, single-use signup invitation; it does not create an account or
workspace.

## Lifecycle

Applications use the following states:

`new` → `approved` → `invited` → `active`

An application may be rejected before approval. Approved, invited, and active access can be
revoked. A revoked application can be restored, which issues a new invitation. Active access is
marked expired when the beta period ends; the workspace and audit history remain intact.

Invitation delivery is tracked independently as `pending`, `sent`, or `failed`. Expired,
accepted, and revoked invitations cannot be used.

The fixed `beta-2026-01` package is 30 days, 1,000 credits, and the registered Analytics, Inbox,
Agents, Campaigns, and Content capabilities. It is applied once when the applicant activates a
workspace and does not stack with the ordinary workspace trial grant.

## Operator workflow

1. Open **Early access** in Admin and select one or more applications in `new`.
2. Select **Approve** or **Approve selected**. Core stores each approval and sends an invitation
   link. Admin never creates the applicant account or workspace.
3. The applicant uses the email link to create an account, continue with Google, or sign in, then
   creates a workspace or selects a workspace where they are an owner or admin. Google sign-in is
   accepted only when the Google email matches the approved invitation email.
4. Core consumes the invitation, applies the beta package, and marks the application active.
5. Use **Resend invite** after a delivery failure or expiry. Resending revokes the previous
   pending token and creates a fresh seven-day token.
6. Use **Revoke** for approved, invited, or active access. It invalidates pending invitations,
   closes early-access entitlement grants, and removes only unused early-access credits.
7. Use **Restore** for a revoked application when access should be reopened. Restore does not
   create a user or workspace; it issues a new invitation for the applicant to activate.

Approval is idempotent by application state. Resend deliberately replaces the current token with a
fresh seven-day token. Batch approval accepts at most 100 unique application IDs and returns a
result for every item; a failed item does not undo successful items.
The raw token is never shown in Admin, stored in the application record, or written to logs.

## Troubleshooting

- **The public form returns 403 or 500:** confirm the Labs `/api/waitlist` route reaches the Core
  API origin. Production defaults to `https://api.kasitek.co.za`; set
  `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL` or `RUST_API_BASE_URL` for another environment.
- **The invitation page says unavailable:** the token is unknown, expired, revoked, or already
  accepted. Ask an Admin to resend the invitation; do not copy tokens into support tickets.
- **The applicant cannot sign up:** the email field must match the approved email. Private-release
  signup accepts only a valid early-access token.
- **The applicant already has an account:** choose **Already have an account? Sign in** on the
  invitation page. After sign-in, the account email must match the invitation.
- **Google sign-in returns an email mismatch:** sign out of Google or choose the Google account that
  matches the approved invitation email. The invitation remains unused.
- **Google sign-in was cancelled:** reopen the invitation link and choose Google again or use the
  password form.
- **No workspace is listed:** the applicant can choose **Create a new workspace**. Existing
  workspaces are listed only when the signed-in account owns or administers them.
- **The selected workspace is rejected:** the workspace must belong to the signed-in applicant
  with OWNER or ADMIN role. No application-scoped organisation header can override this check.
- **The invitation email is missing:** inspect the Core lifecycle event and bounded delivery error
  code, then use **Resend invite**. A provider failure leaves the approval and pending invitation
  record durable for retry.
- **Batch approval has failures:** use the returned per-application results, fix the failed item,
  and approve or resend that application individually. Successful batch items remain approved.
- **Access was revoked by mistake:** use **Restore**, enter a reason, and have the applicant use
  the new invitation. Restore does not provision a workspace.
- **Workspace access remains after expiry:** inspect the Core status result and entitlement
  `endsAt`. Server-side entitlement resolution must enforce expiry; do not hide the feature only
  in the client.
- **Unexpected access:** revoke the application, inspect lifecycle events and grant IDs, and
  preserve the record for support review.

The Core database migration chain must include the early-access lifecycle migrations and
`20260829210000_add_self_service_early_access`. Core does not apply migrations at startup.

## Data and privacy

Applications contain business contact details and use-case notes. Limit access to Admin roles.
Lifecycle logs contain application and invitation IDs, statuses, bounded reasons, actor IDs, and
bounded provider error codes. They do not contain invitation tokens, passwords, full email bodies,
or provider responses.

## Rollback and disablement

To stop new early-access intake, set `EARLY_ACCESS_SELF_SERVICE_ENABLED=false` on Core and protect
the public Labs route. Preserve applications and invitation records. Do not roll back the migration
after records exist. Correct the issue, set the flag back to `true`, and resend pending invitations
after restoration.

Ordinary organisation invitations, paid subscriptions, and normal signup remain separate from
early access.
