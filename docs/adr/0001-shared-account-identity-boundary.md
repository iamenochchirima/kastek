# Shared account identity and product authorization boundary

**Status:** Proposed; requires owner approval

**Date:** 2026-09-29

This proposal is for [Labs issue #4](https://github.com/Kasitek-Labs/kasitek-labs/issues/4). It records source-level findings and a recommended boundary; it is not an accepted decision and does not authorize identity-code or account-data changes.

## Observed source boundaries

- **Growth:** `client/packages/database/prisma/schema.prisma` defines `User`, provider `Account`, and `Session` separately from product `Organization` and `OrganizationMember`. Growth sessions are opaque database-backed tokens; active organization selection is checked against current membership. `AdminUser` is a separate model.
- **Agency:** `server/kasitek-tenants/migrations/20260410090000_tenant_auth_and_domains.sql` defines workspace-scoped `tenant_users`, roles, and sessions. `20260410113000_tenant_clients_and_client_auth.sql` defines a separate `tenant_client_users` identity scoped to an agency client, with its own roles, invitations, and sessions. These are not interchangeable account types.
- **Agents:** `src/http/auth.ts` accepts organization/actor/audience/expiry/scope claims in HMAC-signed internal tokens; production configuration requires this mode. This is service/API authentication, not a human account login or a shared browser session.
- **Labs:** the repository currently owns shared infrastructure, but has no account or identity implementation.

This is a source/schema inventory only. No live account rows, credentials, or production sessions were queried.

## Proposed boundary

1. **Labs owns the shared human account identity contract and its authentication authority.** A global account represents a person's ability to sign in across KasiTek products; it is not itself an organization, Agency workspace, Agency client, role, or product permission.
2. **Each product keeps its own authorization and business records.** Growth continues to own Growth organizations and memberships; Agency owns workspaces, client relationships, and their role assignments; Agents owns organization-scoped agent permissions and resources. Products must authorize access using their own current membership and policy data.
3. **Products identify the shared account by issuer plus stable subject, not email.** Each product keeps an explicit mapping from the identity subject to its local principal ID. Email is a mutable, potentially duplicated attribute and must not silently merge existing principals.
4. **Use OpenID Connect for interactive sign-in, while keeping service credentials separate.** The proposed web flow is Authorization Code with PKCE (`S256`); clients validate issuer, audience, expiry, and nonce. The existing Agents service-token contract remains separate from user sign-in. Whether Labs operates an OIDC provider itself or uses a managed provider behind the Labs-owned contract is still open.
5. **Keep sessions and revocation explicit.** The Labs sign-in session and each product's application session are distinct. A product session must not outlive account suspension or revocation without an explicitly approved bounded policy. Logout, global disable, refresh-token rotation, and revocation propagation need a defined contract before implementation.

## Account linking and migration constraints

- Do not copy, replace, or delete identity rows as part of this decision ticket.
- Do not merge Growth, Agency workspace-admin, or Agency client-user records solely because their email strings match. Linking must require proof of control of the existing identity or an owner-approved recovery process.
- Preserve every existing local principal ID and business-membership relationship through a reversible mapping. Product organizations, Agency workspaces/clients, roles, and access rules remain product-owned.
- Plan migration as a separately approved, product-by-product change: inventory and reconcile first, pilot one product, retain a rollback path, and remove legacy authentication only after adoption is verified. No production cutover is included here.

## Owner decisions still required

- Confirm Labs as the owner of the shared account service contract, and choose managed identity infrastructure versus operating an OIDC provider in Labs.
- Decide whether Agency workspace administrators and Agency clients' `tenant_client_users` both sign in with KasiTek accounts, or whether either remains an independent identity class.
- Decide how account linking handles duplicate emails, account recovery, and a person who has different local principals in multiple workspaces/products.
- Define account disable, product logout, global logout, session lifetime, and revocation propagation behavior.
- Decide whether Growth's separate `AdminUser` identities are included in the shared account system or remain on a separate privileged control-plane path.
- Choose the first product for a later adoption/migration ticket. Do not create implementation tickets with assumed answers to the items above.

## Protocol references

- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html) recommends PKCE for authorization-code clients, specifies use of `S256`, and sets refresh-token replay protections for public clients.
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-22.html) defines the issuer, stable subject, audience, expiry, and nonce claims and requires clients to validate issuer and audience.

## Source references

- Growth: `client/packages/database/prisma/schema.prisma:12-92, 935-1019`; `server/kasitek-core/src/services/auth.rs:8-35`; `server/kasitek-core/src/middleware/mod.rs:31-105`.
- Agency: `server/kasitek-tenants/migrations/20260410090000_tenant_auth_and_domains.sql:30-70`; `server/kasitek-tenants/migrations/20260410113000_tenant_clients_and_client_auth.sql:17-86`; `server/kasitek-tenants/src/controllers/session.rs:177-248`.
- Agents: `src/http/auth.ts:5-73`; `src/config/index.ts:33-38, 170-180`.
