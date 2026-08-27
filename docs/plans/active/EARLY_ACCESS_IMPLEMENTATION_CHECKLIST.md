# Early Access Implementation Checklist

Use this checklist with [the Early Access Implementation Plan](EARLY_ACCESS_IMPLEMENTATION_PLAN.md).
Items are complete only when the implementation and its required verification evidence exist.

Status markers: `[ ]` not started · `[-]` in progress · `[x]` verified complete · `[?]` requires a
product, provider, or deployment decision.

## 0. Product and boundary decisions

- [x] Name the first cohort (`beta`) and define Admin ownership of approval.
- [x] Define access duration (30-day default, 1–365-day Admin override) and expiry behavior.
- [x] Select the initial capability keys and product surfaces included in early access.
- [x] Define the initial credit budget (100 credits) and additional-credit policy (Admin approval).
- [x] Define the primary workflow and expected outcome; first meaningful action remains a staging metric.
- [x] Decide that applicants receive an in-page acknowledgement; no pre-review email confirmation.
- [ ] Define applicant data-retention and deletion rules.
- [x] Confirm that public signup remains disabled while early access is active.
- [x] Add a simple `Beta` tag near the product logo; keep it informational and separate from access control.
- [x] Record the decisions in the plan and release record.

## 1. Existing-system inventory

- [x] Confirm the existing `ProductWaitlistEntry` model and `POST /api/waitlist` endpoint.
- [x] Confirm the current public `/waitlist` route is not a form and redirects to pricing.
- [x] Confirm invitation preview, activation, acceptance, expiry, resend, and revoke behavior.
- [x] Confirm admin launch-access provisioning and authorization roles.
- [x] Confirm the entitlement resolver and registered capability-key contract.
- [x] Confirm manual organisation entitlement grants and credit grants can be time-bounded.
- [x] Confirm the notification, email, audit, and Analytics boundaries to reuse.
- [x] Write the final boundary map in the implementation plan and runbook.

## 2. Database and migration

- [x] Add the minimum waitlist qualification and lifecycle fields.
- [x] Use the waitlist row as the early-access lifecycle record linked to the organisation.
- [x] Link the lifecycle record to invitations, entitlement grants, and credit grants.
- [x] Add append-only transition/audit history.
- [x] Add indexes for status, cohort, email, expiry, and linked organisation.
- [x] Preserve existing waitlist rows and old product values.
- [x] Use controlled migrations that apply cleanly to the configured local Core database; verify migration history before hosted rollout.
- [x] Verify rollback/disable compatibility before making any field required.
- [x] Run Prisma validation and generation.
- [x] Run the migrations against the configured local PostgreSQL database.
- [x] Record migration versions and evidence in the release record.

## 3. Core domain and API

- [x] Centralize allowed lifecycle transitions in one service boundary.
- [x] Add application list/detail queries with bounded pagination and status/search/cohort filters.
- [x] Add authorized Admin review/update endpoints.
- [x] Add an idempotent approve endpoint that records the decision and beta cohort.
- [x] Add an idempotent provision/invite operation that cannot create duplicate workspaces or
  invitations on retry.
- [x] Create entitlement grants and credit grants in the same controlled workflow as approval.
- [x] Bind grants to start/end dates and an auditable early-access reason/reference.
- [x] Add explicit expiry and revoke operations.
- [x] Add authenticated early-access status for the active organisation.
- [ ] Return safe, stable error codes for invalid transition, duplicate request, expired invite,
  revoked access, and provider-delivery failure.
- [x] Keep public application responses generic and avoid account-enumeration behavior.
- [x] Add request-size, field-length, email, product, business-type, consent, honeypot, and deduplication validation.
- [ ] Add deployment-edge rate limiting for anonymous submissions before public rollout; the code-level request protections are in place.
- [ ] Ensure all write operations are scoped to the intended organisation/application.
- [ ] Ensure invitation tokens and provider credentials never enter logs or responses beyond the
  intended activation URL delivery.

## 4. Public application experience

- [x] Replace the Labs `/waitlist` redirect with a concise early-access application form.
- [ ] Collect business name, contact person, email, phone where needed, business type, products,
  primary use case, expected outcome, and contact consent.
- [ ] Use the existing design system and concise product copy.
- [x] Validate fields inline on submit; preserve values after errors.
- [x] Disable duplicate submissions and show a loading state.
- [x] Show a clear confirmation without promising approval or timing.
- [x] Handle network, validation, and server errors in application UI; rate-limit UI remains a staging gate.
- [ ] Add keyboard, label, focus, contrast, and mobile-layout checks.
- [ ] Add a same-origin server proxy if the public deployment cannot call Core safely.
- [x] Verify the local production route no longer redirects to pricing; hosted route verification remains a release gate.

## 5. Admin review and access operations

- [x] Add an early-access application list to the Admin access area.
- [-] Add status, cohort, product, owner, created date, and expiry filters; status/search are live, with the remaining filters deferred to staging follow-up.
- [x] Add application detail fields with qualification data and internal notes.
- [ ] Add assign/reassign review owner.
- [x] Add approve, reject, revoke, and reopen-to-review actions only for permitted transitions.
- [x] Require a reason for rejection and revocation; manual extension is not in this release.
- [x] Add cohort, end date, capabilities, and credit budget fields to approval.
- [x] Reuse existing Admin authorization and audit policy.
- [x] Use the existing custom confirmation dialog for revoke actions.
- [ ] Show invitation and grant status without exposing raw tokens.
- [x] Support resend without creating duplicate active access records.
- [x] Preserve pending delivery/provider errors and provide the resend action.
- [ ] Add empty, loading, error, and no-results states with concise copy.
- [ ] Verify desktop, tablet, and mobile layouts.

## 6. Invitation, activation, and entitlement enforcement

- [x] Connect approval to controlled workspace provisioning.
- [x] Ensure a failed email send leaves a durable invited state that can be retried.
- [ ] Ensure invitation tokens are single-use, hashed at rest, expiring, and revocable.
- [ ] Verify invite email links to the correct client origin and activation route.
- [x] Verify activation creates the account, session, organisation membership, and early-access
  lifecycle link.
- [ ] Verify a user cannot activate with a different email address.
- [ ] Verify accepted, expired, revoked, and malformed invitations fail safely.
- [x] Verify early-access capability grants are resolved by Core, not just hidden in the client.
- [x] Verify credit grants have the intended amount, start, expiry, and source metadata.
- [x] Verify expiry/revocation closes early-access grants without deleting the workspace or data.
- [x] Verify revocation is visible to operators; protected-operation checks remain part of hosted staging validation.
- [ ] Verify normal paid subscriptions and ordinary team invitations remain unaffected.
- [ ] Add a small workspace status surface for cohort and expiry.

## 7. Notifications, analytics, and operations

- [ ] Send applicant acknowledgement if approved by Product/Legal.
- [x] Create an Admin notification for each new application.
- [x] Send approval/invitation, resend, expiry, and revocation notifications as applicable.
- [x] Make invitation email delivery durable, retryable, and observable.
- [ ] Register Analytics events for submission, review, decision, invitation, activation, first
  meaningful action, expiry/revocation, and conversion.
- [ ] Define event schemas, privacy fields, ownership, and success metrics in the analytics
  registry.
- [x] Add structured logs for each state transition and external delivery attempt.
- [ ] Include environment, release, application/grant ID, actor ID, outcome, and bounded error code.
- [ ] Redact email bodies, invitation tokens, passwords, credentials, and unnecessary PII.
- [ ] Add metrics for pending applications, approval latency, invite activation, delivery errors,
  expiring grants, and conversion.
- [x] Add or update a support runbook for stuck applications, failed invitation delivery, expiry,
  revocation, and rollback.
- [ ] Record the release version, migration version, configuration revision, and tested artifact.

## 8. Automated verification

### Unit tests

- [ ] Validate required fields, email normalization, product/capability selection, and limits.
- [ ] Validate all permitted and forbidden lifecycle transitions.
- [ ] Validate duplicate submission and duplicate approval behavior.
- [ ] Validate expiry, revocation, conversion, and extension rules.
- [ ] Validate generic public responses and safe error codes.

### Database/API integration tests

- [x] Submit a valid application and verify persistence.
- [x] Verify the Admin notification is created.
- [x] Verify invalid submissions and the honeypot are rejected without rows.
- [x] Review and qualify an application with an authorized Admin.
- [ ] Verify unauthorized admins cannot approve or revoke access.
- [x] Approve an application and verify one organisation, invitation, lifecycle record, entitlement
  grant, and credit grant are created.
- [x] Retry approval/provisioning and verify no duplicates are created.
- [x] Simulate missing/failed email delivery and verify pending state plus retry behavior.
- [x] Activate the invitation and verify membership, entitlements, and credits in the Core journey test.
- [ ] Verify wrong-email, expired, revoked, reused, and malformed invitation behavior.
- [ ] Verify expired/revoked access is denied server-side.
- [ ] Verify ordinary signup remains blocked in private mode.
- [ ] Verify paid billing and ordinary organisation invitations remain compatible.

### Browser E2E

- [x] Run the public applicant endpoint against an isolated local database.
- [ ] Run the admin review and approval flow with a seeded admin.
- [ ] Capture the invitation using a test email sink.
- [ ] Open the invitation and complete activation in a fresh browser context.
- [ ] Verify the workspace opens with the expected early-access capabilities and credits.
- [ ] Verify the status/expiry surface renders correctly at desktop, tablet, and mobile widths.
- [x] Verify refreshes and retries do not duplicate records or notifications.
- [ ] Verify expiry/revocation behavior from the user and admin surfaces.
- [ ] Archive or clean up test fixtures without touching shared customer data.

## 9. Documentation and release closure

- [x] Update internal access-control documentation with early-access grant semantics.
- [x] Update internal billing/support documentation with credit and entitlement handling.
- [x] Document the Admin workflow and state-transition policy.
- [x] Document the public/API contracts implemented in this change.
- [x] Add configuration and migration notes.
- [ ] Add release notes/changelog entry for the customer-visible flow.
- [ ] Complete the release record from the canonical release process.
- [ ] Assign a post-release review date.
- [ ] Run the first cohort through the full checklist and attach evidence.
- [ ] Move this plan and checklist to `docs/plans/completed/` only after implementation, release,
  and post-release review are complete.

## Definition of done

- [ ] A real applicant can submit interest publicly.
- [ ] An authorised operator can review and approve the applicant.
- [ ] Approval creates exactly one controlled access package.
- [ ] The applicant can activate through a secure invitation.
- [ ] The workspace has the intended early-access capabilities and credits.
- [ ] Unapproved, expired, revoked, and wrong-email paths are denied.
- [ ] The entire journey is covered by automated integration and browser evidence.
- [ ] Operators can inspect, retry, revoke, and roll back the flow without database editing.
- [ ] Release, documentation, analytics, observability, and rollback requirements are recorded.
