# Shared account identity and product authorization boundary

Status: Accepted for the original Labs and Growth local implementation. Later admin adoption is recorded in ADR 0002.
Date: 2026-10-02.

Admin adoption is now defined by [ADR 0002](0002-labs-operations-and-admin-identity.md).
The original source inventory below records the earlier decision context.

## Decision

Labs self-hosts Keycloak and owns shared account authentication, credentials, verification, recovery, and provider operation. Growth is the first integration and retains its product users, organizations, memberships, roles, and business data.

Offer email/password, Google social login, and passkeys. Registration is open, email/password accounts require email verification, and password reset uses email. Two-factor authentication is optional for administrators and ordinary users, with recovery codes for enrolled users.

Use Authorization Code with PKCE S256. Products exchange codes on the backend and validate signature, issuer, audience, expiry, nonce, and transaction state. Identify a product user through issuer and subject. Email alone never grants membership or connects identities. Adding Google or passkeys to one newly created account requires proof of account control.

Each product has its own client, exact callbacks, database, and opaque application session. Use HttpOnly, host-scoped cookies, Secure in production and SameSite=Lax, with CSRF protection. Provider tokens and secrets stay on the backend. Product cookies are not shared across domains.

Sessions expire after 7 days of inactivity and require fresh authentication after 30 days total. Activity or remember-me cannot extend the absolute deadline. Normal logout ends provider and connected product sessions in this browser. A separate action signs out all devices. Google itself remains signed in. Products must handle verified logout notifications and bounded account-disable revocation; exact enforcement details belong to the product integration.

The project is fresh. There is no legacy-user migration, credential import, compatibility window, or old-login fallback. Schema installation and operational backup/recovery still apply.

Agency customer accounts remain agency-specific and isolated. Their provider isolation model, branding, and primary-partner shared access are deferred. Agents and central Admin have separate future adoption plans; authentication does not automatically grant administrative entitlement.

## Implementation scope

Native local identity configuration lives in `infra/identity/`. No Docker. Production deployment is later work. The master administration realm is separate from shared KasiTek accounts. Use dedicated PostgreSQL storage and development email delivery. Production hosting, DNS, email delivery, secret storage, and rollout require separate preparation.

Each product authorizes current local memberships. Existing service credentials and Core-to-Agents authentication remain separate from human login. Shared TypeScript packages may hold repeated client helpers; runtime authentication uses provider HTTPS interfaces.

## Observed source boundaries

- **Growth:** `client/packages/database/prisma/schema.prisma` defines `User`, provider `Account`, and `Session` separately from product `Organization` and `OrganizationMember`. Growth sessions are opaque database-backed tokens; active organization selection is checked against current membership. `AdminUser` is a separate model.
- **Agency:** `server/kasitek-tenants/migrations/20260410090000_tenant_auth_and_domains.sql` defines workspace-scoped `tenant_users`, roles, and sessions. `20260410113000_tenant_clients_and_client_auth.sql` defines a separate `tenant_client_users` identity scoped to an agency client, with its own roles, invitations, and sessions. These are not interchangeable account types.
- **Agents:** `src/http/auth.ts` accepts organization/actor/audience/expiry/scope claims in HMAC-signed internal tokens; production configuration requires this mode. This is service/API authentication, not a human account login or a shared browser session.
- **Labs:** the repository currently owns shared infrastructure, but has no account or identity implementation.

This is a source/schema inventory only. No live account rows, credentials, or production sessions were queried.

## References

- [Local identity setup and contract](../../infra/identity/README.md).
- [Shared login implementation checklist](../../../plans/shared-login/IMPLEMENTATION.md).
- [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html).
- [OAuth security, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).
- [Keycloak administration](https://www.keycloak.org/docs/latest/server_admin/index.html).
