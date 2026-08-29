# Early Access Implementation Plan

**Status:** Local implementation complete; staging and release validation pending

**Owner:** Product and Platform Engineering

**Last updated:** 2026-08-29

## Objective

Implement a controlled early-access programme for KasiTek that connects public interest to
qualified, auditable workspace access:

`waitlist application → review → approval → invitation → activation → entitled workspace →
feedback and conversion`

Success means an approved business can move from the public early-access application form to a usable,
time-bounded workspace without an operator editing the database, while an unapproved applicant
cannot sign in or receive product access. Every transition must be observable, retry-safe, and
reversible.

## Scope

### Included

- Public early-access application form backed by the existing waitlist endpoint.
- Application validation, deduplication, consent, status transitions, and audit history.
- Authenticated admin review, qualification, approval, rejection, and invitation actions.
- Time-bounded early-access cohort access using the existing invitation, entitlement, and credit foundations.
- Single-use invitation activation, workspace provisioning, resend, expiry, and revocation.
- Early-access status and entitlement visibility in the workspace.
- A simple `Beta` tag near the product logo; the tag is informational only and never controls access.
- Structured lifecycle logs, operational support information, and release evidence.
- Unit, database integration, and HTTP smoke coverage for the implemented journey. Full browser
  E2E remains a staging gate because the Labs, Admin, Core, and email-sink environments are not
  all available in this workspace.

### Excluded

- Public self-serve signup while `KASITEK_ACCESS_MODE` is private.
- Shared early-access codes or client-side-only access flags.
- A public pricing, checkout, or discount redesign.
- Automated qualification decisions based on an opaque score.
- Replacing the existing organisation invitation flow for ordinary team members.
- General CRM replacement or a separate marketing automation system.

## Context and constraints

- `ProductWaitlistEntry` and `POST /api/waitlist` already exist in Core, but the public Labs
  `/waitlist` page currently redirects to `/pricing`.
- Core already supports invitation-only signup, invitation activation, workspace provisioning,
  manual organisation entitlement grants, trial credits, and credit grants.
- The current admin access page manages launch invitations but does not review waitlist entries.
- The current database stores waitlist status as a string. New statuses must remain compatible
  with existing rows and old clients during migration.
- The server is the authority for access. Frontend state is a presentation of server decisions.
- Early access is organisation-scoped. Individual users receive access through membership in the
  approved organisation.
- Provider email failures must not silently delete an application or leave an unknown access
  state. Retry and operator visibility are required.

### Product decision

Use an approved waitlist with explicit early-access cohort grants and expiring, single-use invitations. A
waitlist submission records interest only; it never creates a workspace or grants product access.

### Access decision

Reuse `OrganizationInvitation`, `OrganizationEntitlementGrant`, and `CreditGrant` for the
activation and access mechanisms. Use `ProductWaitlistEntry` as the lifecycle record and
`ProductWaitlistEvent` as its append-only transition history. The entry links the application,
organisation, invitation, entitlement grants, credit grant, beta cohort, and audit actors. This
keeps early-access policy separate from paid plan names while using the existing access resolver.

## Target lifecycle

| Stage | State | Owner | Result |
| --- | --- | --- | --- |
| Capture | `new` | Applicant | Valid application is persisted and acknowledged. |
| Review | `reviewing` | Admin | Applicant is assigned and qualification notes are recorded. |
| Decision | `rejected` or approval from `reviewing` | Admin | Qualification decision and reason are auditable. |
| Approval | `approved` | Admin | Cohort, duration, product access, and credit budget are fixed. |
| Invitation | `invited` | Core | Workspace and single-use invitation are created. |
| Activation | `active` | Applicant/Core | Invitation is redeemed and the owner can sign in. |
| Outcome | `expired`, `revoked` | Admin/System | Access is closed without deleting history. Conversion uses normal billing outside this lifecycle. |

Allowed transitions must be enforced in one service boundary. Repeating an already completed
transition should return the existing result or a safe conflict; it must not create duplicate
workspaces, invitations, grants, notifications, or analytics events.

## Proposed data model

### Existing waitlist record

Keep `ProductWaitlistEntry` as the applicant-facing record. Add only fields needed for the
workflow, such as:

- primary use case and expected success metric;
- consent timestamp and contact preference;
- review owner, review notes, and decision reason;
- cohort, approved start/end dates, and lifecycle timestamps;
- linked early-access application/grant identifiers;
- a stable idempotency key where the public form can supply one.

Do not rename the table or remove the existing product values in the same release.

### Early-access lifecycle record

The existing waitlist row is the first-class record for this initial beta. It contains:

- application and organisation identifiers;
- invitation identifier;
- cohort/program key;
- lifecycle status;
- start and expiry timestamps;
- approved product/capability keys and credit budget;
- linked entitlement and credit grant identifiers;
- approved/activated timestamps and actor identifiers;
- bounded review and decision notes.

Add an append-only transition/audit record if the existing audit tables cannot provide a complete
history for this domain. Do not store invitation tokens, passwords, or provider secrets.

### Compatibility and migration

- Use a controlled Prisma/SQL migration with nullable additions first.
- Backfill existing waitlist rows to `new` only where the value is empty; preserve other values.
- Deploy code that understands old and new rows before making new fields required.
- Keep the migration reversible by disabling the new flow and retaining the original waitlist
  records.

## API and UI shape

### Public boundary

- `POST /api/waitlist` remains the public submission endpoint.
- Add the public form in the Labs app and a same-origin proxy if the deployed site cannot call
  Core directly.
- Return a generic successful acknowledgement; do not reveal whether an email already exists or
  whether an applicant has been approved.
- Apply validation, rate limiting, honeypot/abuse controls, and request-size limits.

### Admin boundary

Add an admin application surface under the existing access area:

- list and filter applications by status, cohort, product, and owner;
- view the full application and internal notes;
- move an application through permitted states;
- approve with a cohort, expiry, entitlements, and credit budget;
- provision and send an invitation idempotently;
- resend or revoke an invitation, with a fresh invitation record for every resend;
- restore mistakenly revoked access without duplicating the workspace or account, including
  recovery of older rows with a missing workspace link;
- expose a recovery send action when an active record has no redeemed invitation;
- require the Core Analytics outbox migration before provisioning a missing workspace;
- expire or revoke access and preserve the audit history.

Approval and revocation must require the existing admin authorization policy. Destructive actions
must use the existing application confirmation dialog pattern.

### Authenticated workspace boundary

Add a small early-access status response and workspace presentation containing only useful state:
active cohort, expiry, remaining credits where already supported, and a feedback/contact action.
The workspace must not imply that early access is paid or permanent. The separate `Beta` tag should
remain a simple product-status label.

## Implementation plan

1. [x] Confirm the beta cohort, 30-day default duration, five default capability keys, 100-credit
   default, admin ownership, acknowledgement, private signup mode, and normal billing conversion.
2. [x] Map the existing waitlist, invitation, billing, credit, notification, audit, and analytics
   boundaries in the checklist and runbook.
3. [x] Add the migration and lifecycle model without breaking existing waitlist or invitation rows.
4. [x] Implement the Core service for review, approval, provisioning, invitation, entitlement/
   credit grants, expiry, revocation, and state transitions.
5. [x] Add the public application UI, validation, acknowledgement, retry, consent, honeypot, and
   accessible loading/error states.
6. [x] Add the Admin application/review UI and authorized Core endpoints.
7. [x] Add authenticated early-access status and server-side time-bounded grants.
8. [x] Add durable invitation retry behavior, safe restore-after-revoke behavior, legacy workspace
   link recovery, admin notifications, structured lifecycle logs, and idempotency.
9. [x] Add unit and database integration coverage for approval, resend, restoration, and repeated
   revoke/restore cycles, plus HTTP smoke tests for the public paths.
10. [x] Align the private-mode app gateway, authentication screens, and Labs primary CTA with
    invitation-only access, including a visible request-early-access path.
11. [x] Add invitation link/token redemption and a branded invitation-required OAuth error path.
12. [x] Reject uninvited Google accounts before user creation and allow recovery of orphaned OAuth
    rows through invitation activation.
13. [x] Update internal/public documentation, migration notes, runbook, and rollback evidence.
14. [ ] Run an isolated staging journey using a disposable applicant, admin, email sink, and
    organisation; promote the exact verified artifact only after all release gates pass.

## Verification

- [x] `cargo fmt --check` and targeted Core `cargo check` pass.
- [x] Core unit tests cover capability validation and transition rules.
- [x] Database integration test covers application persistence, approval, provisioning, retry,
  activation, grants, revocation, filtering, and cleanup.
- [x] HTTP smoke checks cover anonymous validation and valid/deduplicated public submission.
- [x] Client and Admin lint/type checks pass.
- [x] Labs and Admin production builds pass with Webpack. Turbopack is unavailable in the current
  sandbox because it cannot bind its worker process.
- [ ] Playwright completes the applicant → Admin → invitation → activation → entitled workspace
  journey against an isolated Core database and email sink. This is a staging gate.
- [x] Runtime smoke checks confirm Core health, public validation, valid submission, deduplication,
  migration state, and lifecycle logs. Hosted entitlement-resolution and rollback checks remain
  staging gates.
- [x] Test output contains no credentials, invitation tokens, full email bodies, or unnecessary
  personal data.

## Release record

**Change:** Add the controlled early-access application and approval lifecycle, plus an informational
Beta product tag and private-mode invitation redemption/OAuth handling.

**Owner:** Product and Platform Engineering; release owner to be assigned before staging.

**Risk:** standard. This affects public intake, identity, organisation provisioning, entitlements,
credits, email delivery, admin permissions, and database state.

**Affected services and user surfaces:** Labs public site, client invitation/auth/workspace,
admin access, Core website/auth/org/billing services, PostgreSQL, email provider, notifications,
analytics, and operational runbooks.

**Platform release version or release ID:** `VERSION`/release tag assignment remains a staging
gate; the implementation was verified from the current working tree.

**API/schema/migration changes:** waitlist lifecycle fields, append-only event history, cohort,
credit-source, and duplicate-submission migrations, admin application endpoints, the admin-only
approval-context lookup and existing-workspace approval fields, authenticated early-access status
endpoint, resend/restore lifecycle endpoints, and controlled migrations `20260827120000_add_early_access_lifecycle`,
`20260827130000_add_early_access_cohort`, `20260827140000_allow_early_access_credit_source`, and
`20260827150000_prevent_duplicate_early_access_applications`. The Core Analytics outbox required
when restore provisions a missing workspace is included in
`20260829180000_add_core_analytics_outbox`. The early-access application response now includes
invitation redemption state so Admin can resend an unredeemed invitation even when the record is
already active; this uses no additional migration.
The Beta tag has no authorization or API contract. The Labs server-side waitlist and quote
proxies use `https://api.kasitek.co.za` as the production Core default, with deployment-specific
API-origin overrides; this follow-up adds no database migration, but changes the Admin/Core approval
contract to support selecting an existing workspace or explicitly creating one for an existing account.

**Feature flag or rollout method:** retain private signup; enable public application capture and
admin approval separately; start with one manually selected cohort; disable approval/invitation
issuance without deleting applications if rollback is required.

**Analytics events and success metrics:** the initial implementation does not emit new Analytics
registry events because anonymous applications have no organisation scope and no early-access
contracts exist in the registry. Lifecycle logs are the current operational evidence. Before a
hosted rollout, register submission, decision, activation, first meaningful action, expiry/revocation,
and conversion events, with qualified-to-activated rate, activation completion rate, time to first
meaningful action, retention, and conversion as the success metrics. The Beta tag itself does not
need an event.

**Logs, metrics, dashboards, and alerts:** structured logs for state transitions, provisioning,
email attempts, grant creation/revocation, and failures; metrics for application volume,
activation failures, pending invitations, expiring grants, and provider errors. Redact tokens and
personal data. Add a runbook for stuck or partially completed approvals.
Uninvited Google OAuth attempts also emit a bounded structured warning without email addresses,
tokens, or provider payloads.

**User, API, internal, and operational documentation:** update public access documentation only
after the flow is live; update internal access-control, billing, support, configuration, and
release documentation with the final contract.

**Validation evidence:** local evidence is complete for migration, Core compilation, unit tests,
the ignored PostgreSQL lifecycle test, and HTTP public-route smoke checks. The Labs production
proxy must be redeployed and checked with a valid and invalid application payload after this fix.
Staging must add the browser journey, seeded Admin authorization, email sink,
entitlement-resolution, analytics, rollback, and hosted release-identity checks.

**Rollback or disable plan:** disable new applications or approval issuance, revoke only affected
access through an audited action when necessary, preserve applications and event history, and
leave existing invitation and paid-plan behavior intact.

**Post-release review date:** seven days after the first cohort activation, then at the end of the
cohort.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Access model | Approved waitlist plus expiring invitation and explicit organisation grant | Product/Engineering | Decided |
| Scope | Organisation-level access; team members use ordinary invitations after activation | Product/Engineering | Decided |
| Signup mode | Keep public signup disabled while early access is active | Product/Engineering | Decided |
| Billing | Use time-bounded grants/credits for early access; convert through normal billing later | Product/Finance | Decided for beta |
| Early-access duration | 30 days by default; Admin can approve 1–365 days; no extension endpoint in this release | Product | Decided for beta |
| Included capabilities | Analytics, Inbox, Agents, Campaigns, and Content keys by default; Admin can reduce the set | Product/Engineering | Decided for beta |
| Qualification | Business/contact details, business type, selected products, use case, and contact consent | Product | Decided for beta |
| Applicant email | In-page acknowledgement before review; invitation email after approval; no double opt-in in this release | Product/Legal | Decided for beta |
| Data retention | How long should rejected and withdrawn applications be retained? | Product/Legal | Open |

## Notes and blockers

- The public `/waitlist` endpoint and route remain as compatibility names; customer-facing copy and
  canonical navigation use early access.
- The lifecycle implementation is local and verified, but staging is still required for the
  complete Admin/email/invitation/browser journey.
- No new Analytics registry event contract exists yet; this is a pre-release measurement gate.
- Hosted staging access, email-sink credentials, and the release owner are deployment inputs, not
  reasons to bypass the local implementation and test work.
