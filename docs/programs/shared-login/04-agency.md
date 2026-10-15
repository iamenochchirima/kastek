# Agency and white-label sign-in

The current partner registration, login and self-service business-creation checklist is [Agency self-service implementation](../agency-self-service/IMPLEMENTATION.md). It defines shared Keycloak login for primary partners and Agency-owned business permissions. This earlier follow-on plan still covers the separate, deferred provider-isolation design for agency-specific staff and client accounts.

Status: Follow-on plan for staff/client identity federation. Primary-partner login and self-service business setup are tracked separately in [Agency self-service implementation](../agency-self-service/IMPLEMENTATION.md).
Owner repository: kasitek-agency.
Outcome: Agency staff and client users can optionally adopt shared/federated login later while keeping workspace and client permissions isolated. Their accounts remain agency-specific for this release.
Dependencies: Labs identity contract and completion of the primary-partner journey. The owner decided that only the primary partner uses the shared partner identity; other staff and client accounts remain workspace-specific unless separately approved.

## Work

- [ ] Inventory tenant_users and tenant_client_users separately, including invitations, duplicated emails, sessions, and disabled users.
- [ ] Define agency-specific identity isolation and branding for staff and client accounts. The primary partner is covered by the self-service implementation plan.
- [ ] Add explicit issuer/subject mappings to the correct local principal type. A person may map to several local principals across workspaces/client businesses without gaining access automatically.
- [ ] Register approved portal callbacks per domain/client design. Verify domain ownership before registration; avoid wildcard return URLs.
- [ ] Use top-level redirect sign-in with portal-local sessions so custom domains do not depend on a shared KasiTek cookie.
- [ ] Define tenant/client memberships, branding, invitation rules, provisioning, and disable behavior for fresh accounts.
- [ ] Implement agreed logout and suspension handling without affecting unrelated tenants.
- [ ] Document the supported branding/domain/provider setup and new-account onboarding.

## Minimum verification

- [ ] Agency staff and customer identities remain distinct even when their emails match.
- [ ] Shared sign-in succeeds across approved custom domains.
- [ ] A client user cannot access another client or agency administration; removed membership is denied.
- [ ] Unregistered domain/redirect and wrong identity class are rejected.
- [ ] Logout/disable follows the contract without invalidating unrelated tenants incorrectly.

## Release and rollback

Build against a fresh synthetic agency and client. Record schema/configuration revision, login/denial metrics, domain configuration, docs, and operational recovery before deployment. No existing-account conversion or legacy-login fallback is required.
