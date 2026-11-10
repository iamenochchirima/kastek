# 0001: Workspace roles, permissions and verified identity

Status: Accepted. 2026-11-10. Amended by [0002](0002-member-permission-overrides.md) for
per-member permission overrides.

## Context

Agents started with owner and member roles. One owner held every management action, and
authorization compared a literal `owner` role at each endpoint. That was an approved scope
limit for the first release, not a durable team model. A customer with an operations lead
could not delegate agent configuration without also giving away billing, ownership transfer,
workspace deletion and provider credentials.

Growth already runs owner, admin and member roles. Agents needed the same team behaviour, but
not Growth's schema. Growth keeps `Organization.ownerId` next to an owner membership and
mirrors Keycloak verification into `User.emailVerified`. Copying either creates two sources of
truth for the same fact.

Verified identity was already enforced: Agents rejects a login unless Keycloak returns
`email_verified: true`. Standalone Agents registration goes through Keycloak's registration
intent, so it cannot bypass verification. What was missing was a durable record of when
verification was observed.

## Decision

Agents uses three workspace roles: owner, admin and member.

- Owners hold every permission.
- Admins hold every permission except workspace deletion, ownership transfer, billing,
  provider credentials and owner/admin escalation.
- Members use agents, inbox conversations and assigned work. They do not configure agents.

Permissions are declared once in `product/members/permissions.ts`. Routes resolve the
caller's membership role and check a named permission instead of comparing role strings.

Escalation rules:

- Owners may invite, change and remove any role.
- Admins may invite members and other admins.
- Admins may change and remove members only. Peer admins and owners stay owner-managed.
- A workspace always keeps at least one owner.
- Leaving a workspace remains available to the member themselves.

Membership remains the only ownership record. Agents does not add an `ownerId` column, a
product-level verification boolean, Growth's business profile or Growth feature tables.

Keycloak remains the source of truth for verification. The API records
`email_verified_at` and `email_verified_source = 'keycloak'` from the verified claim as audit
data. Neither field authorizes a request.

## Consequences

- A workspace can delegate day-to-day operation without handing over ownership.
- Authorization has one vocabulary and one mapping. Adding a permission is a local change.
- Owner-only actions are explicit and testable rather than implied by scattered SQL.
- Role changes are auditable through `role_changed_at` and `role_changed_by`.
- Admin invitations widen the trust boundary without an owner action, by explicit decision.
  Peer demotion and removal stay with owners.
- Agents and Growth share role semantics but keep separate databases and permission code.
  A shared package is deferred until a second product needs the same vocabulary.
- Growth's `ownerId` and `emailVerified` mirror are not replicated, so Agents avoids
  dual-write drift.
- If Agents ever adds its own credential registration, it must add its own verification flow.
  That is a separate decision.

## Alternatives considered

- **Keep owner and member only.** Simplest, but blocks delegation and pushes customers toward
  sharing owner accounts.
- **Copy Growth's schema.** Faster to reason about across products, but imports a redundant
  owner reference and a duplicated verification flag.
- **Add an admin role without a permission module.** Would have replaced one hard-coded role
  string with another and left the authorization surface inconsistent.
- **Read verification only from the claim with no audit columns.** Keeps one source of truth,
  but leaves no record of when an account was verified.
