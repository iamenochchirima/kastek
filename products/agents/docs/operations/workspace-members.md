# Workspace members, roles and invitations

Agents workspaces have three roles: owner, admin and member. Owners hold destructive
workspace actions, billing and provider credentials. Admins run the workspace and manage
members and agents. Members use agents, inbox conversations and assigned work.

## Roles

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| Use agents, inbox and conversations | Yes | Yes | Yes |
| Create and configure agents | Yes | Yes | No |
| Manage training data and approve knowledge | Yes | Yes | No |
| Connect channels, publish widgets and deploy | Yes | Yes | No |
| Select workspace models | Yes | Yes | No |
| Manage model-provider credentials | Yes | No | No |
| View members | Yes | Yes | Yes |
| Invite members and admins | Yes | Yes | No |
| Invite owners | Yes | No | No |
| Change or remove members | Yes | Yes | No |
| Change or remove admins | Yes | No | No |
| Change or remove owners | Yes | No | No |
| Billing and plan | Yes | No | No |
| Delete or transfer the workspace | Yes | No | No |

Membership is the single ownership record. There is no separate `ownerId` column, so role
changes cannot drift from the ownership source.

The permission vocabulary lives in
`products/agents/api/src/product/members/permissions.ts`. Routes resolve the caller's role
through that module instead of comparing a literal role string.

## Member API

All organization routes require a product session and an active membership. The access
column names the permission checked by the route.

| Method | Route | Access |
| --- | --- | --- |
| `GET` | `/api/organizations/:organizationId/members` | `members.read` |
| `POST` | `/api/organizations/:organizationId/members` | `members.manage` |
| `PATCH` | `/api/organizations/:organizationId/members/:accountId` | `members.manage` |
| `DELETE` | `/api/organizations/:organizationId/members/:accountId` | `members.manage`, or self-removal |
| `GET` | `/api/organizations/:organizationId/invitations` | `members.invite` |
| `POST` | `/api/organizations/:organizationId/invitations` | `members.invite` |
| `DELETE` | `/api/organizations/:organizationId/invitations/:invitationId` | `members.invite` |
| `GET` | `/api/invitations/:token` | Public preview |
| `POST` | `/api/invitations/:token/accept` | Authenticated matching email |

`GET /members` returns the roster plus the caller's `role`, effective `permissions` and
`grantableRoles`. Clients use those values to render controls; the server still checks every
mutation.

`POST /members` adds an existing account by email in the inviter's identity issuer. Use the
invitation route when the account does not exist yet.

## Invitation lifecycle

1. A caller with `members.invite` creates an invitation with an email and a role they may
   grant.
2. Agents stores a SHA-256 hash of a 32-byte random token and a seven-day expiry. The raw
   token exists only in the email link and the acceptance request.
3. The recipient opens `/invite/:token`, signs in with the invited email and accepts.
4. Acceptance creates the membership in the same transaction that marks the invitation
   accepted.
5. A pending invitation can be revoked by a caller who could have granted its role.
6. A caller can re-invite after revoking or after the invitation expires.

The public preview exposes the organization name, a masked email, the role, the expiry and
the state. It never returns the raw token or the full invited email.

## Permissions and invariants

- Owners hold every permission. Admins hold every permission except workspace deletion,
  ownership transfer, billing, provider credentials and owner/admin escalation.
- Members hold read access and conversation use. They cannot configure agents.
- An admin may invite members and other admins, but not owners.
- An admin may change or remove members only. Admins cannot change or remove peers, owners
  or themselves.
- An owner cannot change their own role.
- A member may leave the workspace unless they are the last owner.
- The last owner cannot be removed or demoted.
- Cross-organization member and invitation access is denied.
- A signed-in account must match the invited email.
- Existing active membership wins over an invitation role; acceptance does not silently
  change an existing role.
- Role changes record `role_changed_at` and `role_changed_by`.
- Audit events: `members.added`, `members.invited`, `members.invitation_revoked`,
  `members.invitation_accepted`, `members.role_changed`, `members.removed`. Tokens and email
  bodies are never logged.

Escalation attempts return `ROLE_ESCALATION_DENIED`. A missing permission returns
`INSUFFICIENT_ROLE`. Missing membership returns `ACCESS_DENIED`.

## Verified identity

Keycloak remains the source of truth. The API rejects any login where
`email_verified !== true` with `VERIFIED_IDENTITY_REQUIRED`, including standalone Agents
signup, which uses the provider's registration intent.

Agents also records `email_verified_at` and `email_verified_source = 'keycloak'` on the
account when a verified claim is observed. The stored values are an audit trail only; they
never authorize a request and there is no product-level verification boolean.

## Email configuration

Invitation email uses the existing Resend notification sender. Configure:

- `AGENTS_INVITATION_RESEND_API_KEY`
- `AGENTS_INVITATION_EMAIL_SENDER`
- `AGENTS_PUBLIC_URL`

The sender accepts either a bare address or a display name such as
`KasiTek <noreply@example.com>`. The `AGENTS_FOLLOWUP_RESEND_API_KEY` and
`AGENTS_FOLLOWUP_EMAIL_SENDER` values are used as a fallback when the invitation-specific
values are absent. If no sender is configured the API
returns `INVITATION_EMAIL_UNAVAILABLE`. If delivery fails, the invitation remains pending and
revocable and the API returns `INVITATION_EMAIL_FAILED`; it does not delete the invitation.

Tests inject a fake sender and never call Resend.

## UI

- **Settings → Members** lists members and pending invitations.
- Owners and admins can invite, revoke and manage the members their role allows.
- The role selector and invite dialog list only roles the caller may grant.
- Members see the list without management controls.
- `/invite/:token` handles preview, sign-in return, acceptance, wrong-email, accepted,
  revoked and expired states.
- The layout is verified at desktop, tablet and mobile widths.

## Verification

- `products/agents/api/test/permissions.test.ts` covers the role and permission matrix,
  grantable roles and escalation guards.
- `products/agents/api/test/invitation-delivery.test.ts` sends through the real Resend adapter
  to a local provider stub, extracts the link from the message, accepts it as an admin and
  checks that a provider rejection leaves the invitation pending.
- `products/agents/api/test/members-http.test.ts` covers member listing, admin authority,
  invitations, duplicate pending invitations, wrong email, expiry, revocation, email
  failure, last-owner protection and cross-organization denial.
- `products/agents/web/test/members.spec.ts` covers the members UI and invitation page at
  1440, 768 and 390 pixels.
- Typecheck, Agents API tests and `pnpm verify:boundaries` are required before release.

## Limits

- There is no SCIM or SSO group synchronization.
- Invitation email delivery is provider acceptance, not proof of inbox delivery.
- Production invitation email must be configured before the feature works in a deployed
  environment.
