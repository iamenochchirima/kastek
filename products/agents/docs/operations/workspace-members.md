# Workspace members and invitations

Agents workspaces use owner/member memberships. The owner manages access; members use the workspace but cannot invite, change roles or remove members.

## Member API

All organization routes require a product session and an active membership. Owner-only routes additionally require the `owner` role.

| Method | Route | Access |
| --- | --- | --- |
| `GET` | `/api/organizations/:organizationId/members` | Member |
| `POST` | `/api/organizations/:organizationId/members` | Owner |
| `PATCH` | `/api/organizations/:organizationId/members/:accountId` | Owner |
| `DELETE` | `/api/organizations/:organizationId/members/:accountId` | Owner, or self-removal |
| `GET` | `/api/organizations/:organizationId/invitations` | Owner |
| `POST` | `/api/organizations/:organizationId/invitations` | Owner |
| `DELETE` | `/api/organizations/:organizationId/invitations/:invitationId` | Owner |
| `GET` | `/api/invitations/:token` | Public preview |
| `POST` | `/api/invitations/:token/accept` | Authenticated matching email |

`POST /members` adds an existing account by email in the inviter's identity issuer. Use the invitation route when the account does not exist yet.

## Invitation lifecycle

1. An owner creates an invitation with an email and `owner` or `member` role.
2. Agents stores a SHA-256 hash of a 32-byte random token and a seven-day expiry. The raw token exists only in the email link and the acceptance request.
3. The recipient opens `/invite/:token`, signs in with the invited email and accepts.
4. Acceptance creates the membership in the same transaction that marks the invitation accepted.
5. A pending invitation can be revoked. Accepted, revoked and expired invitations cannot be reused.
6. An owner can re-invite after revoking or after the invitation expires.

The public preview exposes the organization name, a masked email, the role, the expiry and the state. It never returns the raw token or the full invited email.

## Permissions and invariants

- A member can list members but cannot manage them.
- An owner cannot change their own role.
- A member may remove themselves unless they are the last owner.
- The last owner cannot be removed or demoted.
- Cross-organization member and invitation access is denied.
- A signed-in account must match the invited email.
- Existing active membership wins over an invitation role; acceptance does not silently change an existing role.
- Audit events: `members.added`, `members.invited`, `members.invitation_revoked`, `members.invitation_accepted`, `members.role_changed`, `members.removed`. Tokens and email bodies are never logged.

## Email configuration

Invitation email uses the existing Resend notification sender. Configure:

- `AGENTS_INVITATION_RESEND_API_KEY`
- `AGENTS_INVITATION_EMAIL_SENDER`
- `AGENTS_PUBLIC_URL`

The `AGENTS_FOLLOWUP_RESEND_API_KEY` and `AGENTS_FOLLOWUP_EMAIL_SENDER` values are used as a fallback when the invitation-specific values are absent. If email delivery fails, the invitation remains pending and revocable. The API returns `INVITATION_EMAIL_FAILED`; it does not delete the invitation.

Tests inject a fake sender and never call Resend.

## UI

- **Settings → Members** lists members and pending invitations.
- Owners can invite, revoke, change roles and remove members.
- Members see the list without management controls.
- `/invite/:token` handles preview, sign-in return, acceptance, wrong-email, accepted, revoked and expired states.
- The layout is verified at desktop, tablet and mobile widths.

## Verification

- `products/agents/api/test/members-http.test.ts` covers permissions, invitations, duplicate pending invitations, wrong email, expiry, revocation, email failure, last-owner protection and cross-organization denial.
- `products/agents/web/test/members.spec.ts` covers the members UI and invitation page at 1440, 768 and 390 pixels.
- Typecheck, Agents API tests and `pnpm verify:boundaries` are required before release.

## Limits

- Roles are owner/member only. There is no admin role, SCIM or SSO group synchronization.
- Invitation email delivery is provider acceptance, not proof of inbox delivery.
- The service is local/staging-ready; production email configuration and rollout remain operator steps.
