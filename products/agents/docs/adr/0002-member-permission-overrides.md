# 0002: Per-member permission overrides

Status: Accepted. 2026-11-10. Amends [0001](0001-workspace-roles-and-verified-identity.md).

## Context

Roles are fixed bundles. Two admins always had the same capabilities, which does not match
how teams delegate work. A customer may trust one admin to create and configure agents while
another admin should only manage members and conversations.

[0001](0001-workspace-roles-and-verified-identity.md) introduced named permissions and a
role-to-permission matrix. Every route already checks a permission rather than a role string,
so the missing piece was per-member variation, not a new authorization surface.

## Decision

Keep roles as defaults and add per-member permission overrides:

```text
effective = (permissions of role ∪ grants) − denies
```

- A grant adds a permission the role does not include.
- A deny removes a permission the role includes.
- Deny wins over grant.
- Owners ignore overrides. The owner role always holds every permission.
- Overrides persist across role changes. They describe the person, not the role.
- Only owners hold `permissions.manage`, so only owners change overrides.
- Owner-only permissions cannot be granted by override.
- Owners cannot be targeted by overrides and cannot change their own.
- Removing a member deletes their overrides.

Overrides live in `agents_platform.member_permission_overrides`. The resolver reads the
membership and overrides per request, so changes apply on the next request without a cache.

## Consequences

- Two people with the same role can differ without inventing a new role.
- The permission vocabulary stays closed and reviewable. Adding a capability remains a code
  change.
- Role changes do not silently discard intentional exceptions, but the Members screen must
  show effective access so an override is never invisible.
- The owner boundary is unchanged: no admin can widen access, and no owner can be restricted.
- The UI can render read-only surfaces from the effective set instead of hardcoding roles.
- Custom per-workspace roles remain deferred. They add role CRUD, support burden and
  vocabulary drift for a case that overrides already cover.

## Alternatives considered

- **Custom roles per workspace.** Flexible, but every workspace invents its own role names and
  the API must resolve role documents. Deferred until a customer needs many named roles.
- **User-level ACLs per resource.** More granular than the product needs; workspace-level
  capabilities already match how agents, knowledge and channels are owned.
- **Overrides managed by admins.** Rejected. An admin could widen another member's access
  without an owner action, which weakens the escalation boundary from 0001.
- **Clear overrides on role change.** Predictable, but silently discards intentional
  exceptions. The UI shows the result instead.
