# Early-Access Self-Service Plan

**Status:** Active

**Owner:** Platform engineering and Product

**Last updated:** 2026-08-29

## Objective

Replace operator-provisioned early access with an approval-gated self-service flow. Admin approves
one or more applicants, KasiTek sends each applicant a seven-day single-use signup invitation, and
the applicant creates or signs into their own account before creating or selecting a workspace.
The beta package is attached to that workspace when the invitation is redeemed.

Success means Admin does not create customer accounts or workspaces, approved applicants can
complete signup without hitting the private-release block or organisation-dependent 403 responses,
and batch approval produces an auditable result for every selected application.

This plan supersedes the operator-provisioning portions of the completed
`docs/plans/completed/EARLY_ACCESS_IMPLEMENTATION_PLAN.md`.

## Scope

### Included

- Self-service early-access signup for new and existing accounts.
- Seven-day, email-bound, single-use signup invitations.
- Individual and bounded batch approval from Admin.
- Applicant-owned workspace creation or existing-workspace selection.
- One centrally defined, versioned beta package applied at activation.
- Private-release signup bypass only for a valid early-access invitation.
- Invitation resend, revoke, expiry, replay protection, and delivery failure handling.
- Analytics, structured logging, operational documentation, migration, rollout, and rollback.
- Responsive and accessible Admin selection, confirmation, and result states.

### Excluded

- Compatibility with the current early-access provisioning flow. There are zero production users,
  so this is a clean replacement.
- Changes to ordinary organisation invitations used by workspace owners to invite teammates.
- Per-applicant workspace creation, credit amounts, duration, capabilities, or paid-plan selection
  in Admin.
- Mandatory payment collection during beta activation.
- General email delivery infrastructure unrelated to early access.

## Product decisions

1. Admin approves access; Admin does not create the applicant's account or workspace.
2. An early-access invitation lasts seven days from issuance. Resending revokes the previous token
   and issues a fresh seven-day token.
3. Tokens are single-use, stored only as hashes, bound to the normalized applicant email, and
   rejected after acceptance, revocation, or expiry.
4. A valid token allows signup while private-release mode remains enabled. Email approval without
   possession of the token is not sufficient.
5. A new applicant creates an account, creates a workspace, and then receives the beta package.
   An existing applicant signs in and chooses an existing workspace or creates a new one.
6. The beta period starts when the package is activated on a workspace, not when Admin approves or
   when the email is sent.
7. Beta access is free for the initial cohort. Paid-plan selection is available after workspace
   creation but is not required to activate the beta.
8. The initial beta package is one 30-day grant with 1,000 credits and the approved beta
   capabilities. It replaces, rather than stacks with, the normal workspace trial grant.
9. The package is versioned, initially `beta-2026-01`, and its exact duration, credits, and
   capabilities are stored as an approval snapshot for auditability.
10. Batch approval accepts at most 100 applications per request and returns a result for every
    application. One invalid or failed application does not roll back successful approvals.

## Target lifecycle

`new` -> `approved` -> `invited` -> `active`

- `new`: application is awaiting a decision.
- `approved`: the decision and durable signup invitation exist; email delivery has not yet
  succeeded or is being retried.
- `invited`: the invitation email was accepted by the email provider.
- `active`: the token was redeemed and the beta package was attached to a workspace.
- `rejected`: Admin declined the application with a reason.
- `revoked`: Admin disabled an unredeemed invitation or active beta grant.
- `expired`: the active beta package ended. An expired invitation remains an approved application
  with an expired invitation record and can be resent.

Invitation delivery state is recorded separately from application lifecycle state so provider
failures do not erase the approval decision.

## Target user flow

1. The applicant submits the public early-access form.
2. Admin approves the application individually or as part of a selected batch.
3. Core records the approval and invitation before attempting email delivery.
4. The applicant receives an **Early access approved** email containing a seven-day link.
5. The link opens an invitation-aware authentication route:
   - a new user creates an account with the invited email fixed;
   - an existing user signs in, and the authenticated email must match the invitation.
6. The applicant creates a workspace or selects a workspace they own or administer.
7. Core atomically consumes the token, links the application to the workspace, grants the
   `beta-2026-01` package once, and marks the application active.
8. The applicant completes the existing workspace onboarding flow.
9. The applicant can choose a paid plan from the existing upgrade flow at any time. Before beta
   expiry, KasiTek prompts active beta workspaces to select a paid plan if they want continued
   access.

## Target Admin flow

- Keep application search and status filters.
- Add row selection checkboxes and a select-all control limited to the loaded page.
- Show **Approve** and **Reject** for one application.
- Show a contextual **Approve selected** action with the selected count.
- Use a custom confirmation dialog summarizing the number of invitations to be issued and the
  package key. Do not use a native browser dialog.
- Disable repeated submissions and show progress while a batch is processing.
- Return a per-application result list with `invited`, `already approved`, `failed`, or `skipped`.
- Keep **Resend invite** and **Revoke** as contextual actions.
- Remove workspace name, days, credits, and capability controls from the approval surface.
- On mobile, use stacked application cards, persistent selection state, and a compact batch-action
  bar that does not obscure content or navigation.

## Data and migration design

Because there are no users to preserve, use one clean migration and remove the obsolete
early-access provisioning contract rather than carrying compatibility fields.

### Early-access invitation

Add a dedicated early-access signup invitation model. It must not reuse
`OrganizationInvitation`, which remains scoped to joining an existing workspace.

Required fields:

- `id`
- `waitlistEntryId`
- `email`
- `tokenHash` with a unique index
- `status`: `pending`, `accepted`, `revoked`, or `expired`
- `expiresAt`, `acceptedAt`, and `revokedAt`
- `deliveryStatus`: `pending`, `sent`, or `failed`
- `deliveryAttempts`, `lastDeliveryAttemptAt`, and bounded `lastDeliveryErrorCode`
- `createdById`, `createdAt`, and `updatedAt`

Allow only one pending invitation per application. Resend revokes the current pending invitation
and creates a new record and token. The resend action is deliberately a fresh-token operation;
revoke is idempotent. Never store or log the raw token after the email payload is constructed.

### Waitlist application

- Replace the legacy organisation-invitation reference with a relation to the active
  early-access signup invitation.
- Retain `organizationId`, but populate it only when the applicant selects or creates a workspace.
- Add `packageKey` and `packageSnapshot` fields.
- Set `activatedAt` and `earlyAccessEndsAt` only during successful token redemption.
- Keep decision and lifecycle audit fields.
- Remove fields or code paths used only for Admin-created accounts and workspaces.

### Workspace and credit creation

- Separate workspace persistence from automatic trial-credit issuance so callers explicitly choose
  a credit policy.
- Ordinary open signup can request the normal trial policy in the future.
- Early-access activation creates the workspace without a trial grant, then applies exactly one
  idempotent `EARLY_ACCESS` grant from the package snapshot.
- Paid-plan grants remain separate. Define deterministic consumption and expiry behavior so a paid
  plan cannot accidentally duplicate the initial beta allocation.

## API contracts

### Individual approval

`POST /api/admin/early-access/{id}/approve`

- Request: `{ "packageKey": "beta-2026-01" }`
- Idempotently creates or returns the active invitation.
- Does not accept workspace, duration, credit, or capability fields.
- Returns the application and invitation delivery state without returning the raw token.

### Batch approval

`POST /api/admin/early-access/batch-approve`

- Request: `{ "applicationIds": [...], "packageKey": "beta-2026-01" }`
- Validate 1-100 unique IDs and Admin authorization before processing.
- Process each application idempotently with bounded email-provider concurrency.
- Persist every invitation before attempting delivery.
- Return `{ requested, approved, invited, alreadyProcessed, failed, results[] }`.
- Each result includes application ID, outcome, resulting status, and a bounded error code. Do not
  return email addresses, raw provider responses, or tokens in error metadata.

### Invitation lifecycle

- `GET /api/early-access/invitations/{token}` returns a safe preview and expiry state.
- Signup and sign-in accept an invitation token and verify the normalized account email.
- `POST /api/early-access/invitations/{token}/activate` accepts a selected or newly created
  workspace and atomically consumes the invitation.
- Admin resend issues a new token with a new seven-day expiry.
- Admin revoke invalidates the pending token or closes the active beta grants.

## Implementation checklist

### 1. Backend and data foundation

- [x] Add the dedicated early-access signup invitation schema and clean migration.
- [x] Remove the early-access dependency on `OrganizationInvitation`.
- [x] Add the versioned beta-package registry and immutable approval snapshot.
- [x] Separate workspace creation from automatic trial-credit grants.
- [x] Implement token generation, hashing, seven-day expiry, email binding, revocation, replay
      protection, and idempotent resend.
- [x] Make activation the only operation that links a workspace and starts the beta period.
- [x] Ensure activation and grants are guarded, compensating, and safely retryable.

### 2. Approval and batch operations

- [x] Replace approval request fields with `packageKey` only.
- [x] Make individual approval create the invitation without creating a user or workspace.
- [x] Add the bounded batch-approval service and endpoint.
- [x] Return per-application outcomes and preserve successful items when another item fails.
- [x] Add bounded provider concurrency and durable failed-delivery state. Delivery is deliberately
      sequential (concurrency one) until provider throughput requires a worker.
- [x] Make revoke idempotent and make resend safely replace the current token with a fresh
      seven-day invitation.

### 3. Authentication and onboarding

- [x] Permit private-release signup only with a valid unexpired early-access token.
- [x] Lock new-account signup to the invited email and verify token ownership server-side.
- [x] Route existing accounts through sign-in and require an email match.
- [x] Support an authenticated user with no organisation without loading organisation-dependent
      product APIs.
- [x] Add an organisation-less onboarding route for workspace creation or selection.
- [x] Activate the beta package only after the workspace choice succeeds.
- [x] Route successful activation into normal workspace onboarding.
- [x] Keep paid-plan selection optional during beta and available after workspace creation.

### 4. Admin UI

- [x] Remove workspace, days, credits, and capability inputs.
- [x] Add accessible row selection and page-level select all.
- [x] Add individual **Approve** and batch **Approve selected** actions.
- [x] Add a custom confirmation dialog and disabled/loading states.
- [ ] Verify desktop, tablet, and mobile layouts and hit areas.

### 5. Applicant UI and email

- [x] Add a concise approval email with the seven-day expiry date and signup link.
- [x] Add invalid, expired, revoked, already-used, and wrong-account invitation states.
- [ ] Add resend guidance without exposing whether an arbitrary email is approved.
- [x] Add workspace create/select UI before entering the organisation-scoped application shell.
- [x] Preserve form input across validation failures and disable duplicate submissions.

### 6. Credits, plans, and conversion

- [x] Define `beta-2026-01` as 30 days, 1,000 credits, and the approved beta capabilities.
- [x] Confirm that activation produces one beta credit grant and no automatic trial grant.
- [ ] Record credit usage by activated beta workspace and package key.
- [ ] Add queries or a dashboard for 30-day usage percentiles, exhaustion rate, and time to
      exhaustion.
- [ ] Add beta-expiry reminders and a route to the existing plan-selection flow.
- [ ] Verify paid-plan activation and beta expiry do not remove paid entitlements or paid credits.

### 7. Documentation and operations

- [x] Rewrite `docs/internal/runbooks/early-access.md` for the self-service lifecycle.
- [x] Update authentication, workspace, billing, and invitation documentation where contracts
      change.
- [x] Add troubleshooting for failed email, expired token, wrong account, no-workspace onboarding,
      partial batch failure, and duplicate activation.
- [x] Add release notes for the Admin and applicant workflow changes.
- [ ] Move this plan to `docs/plans/completed/` only after production validation is recorded.

## Credit measurement

For each activated workspace, measure the total beta credits consumed during its first 30 days,
then sort those totals from lowest to highest:

- **50th percentile (P50):** the middle workspace. Half of activated workspaces used this many
  credits or fewer.
- **90th percentile (P90):** the level that 90% of activated workspaces did not exceed. Only the
  heaviest 10% used more.

Example: if P50 is 280 credits and P90 is 820, a 1,000-credit package covers normal use and most
heavy use. If P90 is 3,500, a 1,000-credit package is probably constraining genuine beta testing.
Track the percentage of workspaces that exhaust credits as a second check; percentiles alone do
not show whether users stopped because they ran out.

The initial 1,000-credit amount is therefore a consistent starting policy, not a claim that 1,000
is permanently correct. Review it after the first 20 activated workspaces or 30 days, whichever
comes later.

## Analytics and observability

Add versioned Analytics contracts, using the existing registry and outbox, for these outcomes:

- application approved individually or in a batch;
- invitation created, delivery succeeded, delivery failed, resent, expired, or revoked;
- invitation opened and redeemed;
- account created or existing account authenticated from an invitation;
- workspace created or selected;
- beta package activated;
- onboarding completed;
- paid plan selected;
- beta credits exhausted and beta access expired.

Success metrics:

- approval-to-delivery success rate;
- delivery-to-redemption conversion;
- median time from approval to redemption;
- redemption-to-workspace-activation success rate;
- onboarding completion rate;
- P50 and P90 30-day beta credit use;
- credit exhaustion rate;
- beta-to-paid conversion.

Structured Core logs must include application ID, invitation ID, batch request/correlation ID,
package key, lifecycle action, delivery outcome, bounded provider error code, and release identity.
Do not log raw tokens, passwords, full email bodies, provider responses, or applicant contact
details. Add an alert or operational query for sustained invitation delivery failures and activation
failure spikes.

## Verification

### Data and backend

- [ ] Apply the migration to a fresh database and run the complete migration chain.
- [ ] Unit-test token hashing, seven-day expiry boundaries, email matching, revoke, resend, replay,
      package snapshots, and transition rules.
- [ ] Integration-test individual approval and batch success, partial failure, duplicate IDs,
      request limits, idempotent retry, and provider failure.
- [ ] Integration-test new-account activation, existing-account activation, existing-workspace
      selection, new-workspace creation, wrong email, expired token, revoked token, and reused token.
- [ ] Verify one workspace, one beta grant, and no trial-credit duplication after activation.
- [ ] Run Core formatting, lint, targeted tests, full package tests, and build checks.

### Frontend

- [ ] Run Admin and Client lint, type checks, route checks, and production builds.
- [ ] Exercise individual approval, multi-selection, select all, confirmation, partial results,
      resend, and revoke.
- [ ] Exercise invitation signup, sign-in, workspace selection/creation, onboarding, and optional
      plan selection.
- [ ] Verify keyboard navigation, focus handling, screen-reader labels, loading/error states, and
      desktop, tablet, and mobile layouts.

### Staging smoke test

- [ ] Approve a new applicant and confirm delivery, account creation, workspace creation, beta
      activation, and onboarding.
- [ ] Batch approve multiple applicants with one deliberate failure and confirm accurate per-item
      results.
- [ ] Confirm a token expires at seven days, cannot be replayed, and is invalidated by resend.
- [ ] Confirm organisation-scoped APIs are not called before workspace activation.
- [ ] Confirm Analytics events, structured logs, release identity, and redaction.

### Local verification completed

- [x] Run Core formatting, compilation, and the full Core package test suite: 196 passed, 3
      service-backed tests ignored because no seeded PostgreSQL/Redis services are available.
- [x] Validate the Prisma schema and regenerate the database client.
- [x] Run Client and Admin lint/type checks and webpack production builds, including the new
      invitation and batch-approval routes.
- [x] The default Turbopack build was also attempted; this container blocks its CSS worker from
      binding a port, so webpack was used for the successful production build verification.
- [x] Run `git diff --check` and confirm the old approval-context route and Admin provisioning
      fields are absent from the active implementation.

## Release record

**Change:** Replace operator-provisioned early access with seven-day self-service signup
invitations and bounded batch approval.

**Owner:** Platform engineering and Product.

**Risk:** High. This changes authentication admission, account/workspace creation, grants, email,
Admin operations, and the early-access data contract.

**Affected services and user surfaces:** Core, Admin, Client authentication and onboarding,
database schema, Resend delivery, billing/credits, Analytics, and the early-access runbook.

**Platform release version or release ID:** Assign a minor platform release during implementation;
record the release tag, commit SHA, Core/Admin/Client artifacts, migration ID, and configuration
revision before production deployment.

**API/schema/migration changes:** New early-access invitation and package snapshot schema; clean
replacement of the current approval payload and lifecycle; new batch approval and activation
contracts; workspace-credit policy separation. No compatibility path is required because there are
zero users.

**Feature flag or rollout method:** Core uses the `EARLY_ACCESS_SELF_SERVICE_ENABLED` server-side
kill switch, enabled by default. Validate the complete flow in staging, then enable it for all
early-access approvals in one production cutover. Set it to `false` to stop new approval and
redemption without removing invitation or application records.

**Analytics events and success metrics:** Defined in the Analytics and observability section.

**Logs, metrics, dashboards, and alerts:** Structured lifecycle and provider logs, delivery and
activation failure monitoring, conversion metrics, and credit percentile/exhaustion reporting.
Record Collector configuration revision, OTLP endpoint environment, service/release identity,
signal validation, redaction evidence, and exporter-disable action in the release evidence.

**User, API, internal, and operational documentation:** Update the internal early-access runbook,
authentication/workspace/billing contracts, supported user documentation where the invitation flow
is exposed, and release notes.

**Validation evidence:** Migration-chain validation; Core, Admin, and Client tests/builds; staging
individual and batch flows; email delivery; token security; responsive/accessibility checks;
Analytics/log evidence.

**Rollback or disable plan:** Disable new approval and redemption with the kill switch, preserve
applications and invitation records, correct the failure, and reissue invitations after restoration.
Because this is initial setup with zero users, do not retain or restore the obsolete Admin-created
workspace flow.

**Post-release review date:** Seven days after release for delivery and activation failures; repeat
the package-size review after 20 activated workspaces or 30 days, whichever comes later.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Invitation lifetime | Seven days per issued or resent token | Product | Decided |
| Batch size | Maximum 100 unique applications per request | Platform | Decided |
| Batch failure semantics | Per-item results; successful approvals remain committed | Platform | Decided |
| Workspace ownership | Applicant creates or selects the workspace | Product | Decided |
| Beta package | `beta-2026-01`: 30 days, 1,000 credits, approved beta capabilities | Product | Decided |
| Trial interaction | Beta activation receives one beta grant and no normal trial grant | Product/Platform | Decided |
| Paid plan | Optional during beta; available after workspace creation | Product | Decided |
| Compatibility | No compatibility or legacy early-access flow; zero users | Product/Platform | Decided |
| Team invitations | Continue using organisation-bound invitations separately | Platform | Decided |
| Package review | Review after 20 activations or 30 days, whichever comes later | Product/Data | Decided |

## Notes and blockers

No implementation blocker is currently known. The release owner and final beta capability list must
be recorded before staging approval, but independent backend, data, Admin, Client, test, and
documentation work can proceed.
