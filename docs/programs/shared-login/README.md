# Shared login program

Status: Draft for owner review. No identity implementation or production migration is authorized by these files.
Prepared: 2026-10-02.
First product pilot: Growth, on its existing rewrite branch.

The current checklist is [Shared login implementation plan](IMPLEMENTATION.md). It records the latest owner decisions and takes precedence over the earlier workstream drafts below.

The project is fresh. Build one login flow without existing-account migration, legacy compatibility, or old-login fallbacks.

## Recommended design

Labs owns the authentication authority and account lifecycle. Self-hosting is agreed. Keycloak is selected. Email/password, Google, and passkeys are enabled in the plan; registration is open. Use a separately registered OpenID Connect client for each participating product. Do not build an OIDC provider from scratch or add a custom proxy unless a concrete requirement needs it.

A person signs in at the shared identity provider. Each product receives a verified identity and creates its own application session. Visiting another product redirects through the provider, which can reuse its sign-in session. Product membership, roles, resources, subscriptions, and onboarding remain product-owned.

Example: a person signs into Growth, then opens Agents and signs in through the same account. Agents still checks whether that person has access to the requested Agents workspace. A Growth owner role does not automatically become an Agents or Agency owner role.

Use browser redirects and Authorization Code with PKCE S256. Exchange codes and store provider tokens on the product backend. Use secure, HttpOnly, host-scoped application cookies. Do not share one parent-domain cookie across products or rely on third-party cookies for white-label domains.

Identify each external principal with issuer and subject. Create fresh product principals and memberships. Legacy-user migration is out of scope. Authenticated enrollment of Google and passkeys on a new account is included. OIDC may use pairwise subjects, so cross-product account relationships must use an explicit provider-supported mapping rather than assume every client receives the same subject.

Shared Rust crates may hold a small verifier/client adapter if real consumers need it. They do not synchronize accounts, passwords, sessions, or permissions. Runtime sign-in uses the provider's HTTPS interfaces. Existing machine credentials, API keys, and Core-to-Agents delegation remain separate from human sign-in.

## Current code evidence

- Labs ADR docs/adr/0001-shared-account-identity-boundary.md already proposes this division; it remains Proposed.
- Growth User and Session models are distinct from Organization and OrganizationMember. Core creates opaque database-backed sessions and checks current workspace membership.
- The copied Agents web app still reads /api/auth/me from Core by default. Agents' own API authenticates internal service claims. It does not yet provide independent human sign-in.
- Agency has distinct tenant_users and tenant_client_users, invitations, and sessions.
- Labs Admin still reads its AdminUser session from Growth Core. Moving its UI did not move its authentication authority.

No live account rows or production sessions were inspected.

## Plan files and dependency order

1. [Labs identity foundation](01-labs-identity.md): choose provider, define shared contract, provide an isolated development issuer.
2. [Growth adoption](02-growth.md): first complete product pilot.
3. [Agents adoption](03-agents.md): remove the web app's dependence on Growth human login.
4. [Agency adoption](04-agency.md): preserve workspace/client isolation and settle white-label identity behavior.
5. [Privileged Admin adoption](05-admin.md): explicit staff access and optional two-factor authentication.

Several agents can work on bounded tasks once the contract is agreed. Labs provider setup and Growth's new product-user schema can then proceed independently against the frozen contract. Keep Agents, Agency, and Admin as draft follow-on plans until the Growth pilot verifies it. Assign one integration owner; do not let agents change issuer, subject, membership, or logout semantics independently.

Keep these plans in this workspace planning folder for now. Do not create issue boards, additional branches, merges, or deployments from these drafts. Growth implementation stays on rewrite. Use at most one working branch alongside main in each other repository when implementation begins.

## Accepted login policy

- Self-hosted Keycloak, email/password with verification/reset, Google social login, and passkeys.
- Open registration, with Growth-owned organization memberships and roles.
- HttpOnly host-scoped product cookies, Secure in production and SameSite=Lax; backend-held provider tokens.
- Expiry after 7 inactive days and fresh authentication after 30 days maximum.
- Normal logout across connected products in this browser, plus separate all-device logout. Google itself remains signed in.
- Optional two-factor authentication for administrators and ordinary users, with recovery codes.

Implementation and focused checks are in IMPLEMENTATION.md.

## Decisions still open

Self-hosting and agency-specific customer accounts are agreed. Agency customers do not automatically join the shared KasiTek account system. Branding and the primary agency partner's precise access remain open.

- Login hostname, approved product origins, and local callback URLs.
- Detailed recovery and safe enrollment/removal of multiple sign-in methods.
- Maximum account-disable/logout propagation delay and enforcement mechanism.
- Agency-specific identity isolation, login branding, and shared access for the primary partner or agency staff.
- Staff membership and administrative entitlements. Two-factor authentication is optional for administrators.
- Whether organizations need a shared directory later. Phase one keeps organizations and their permissions product-owned.

These are design choices to settle, not permission inferred from an earlier source move.

## Evidence required

Keep checks focused, but authentication needs meaningful negative checks. Each plan names its minimum checks. Use fresh synthetic users and isolated databases. Record login success/failure, session revocation, and authorization denial without logging credentials, codes, tokens, or complete personal profiles.

Implementation releases must record owner, release ID, schema/configuration revision, measurement, documentation, validation, operational recovery, and review date. Those values are not yet set. The current planning-only change has no runtime, schema, or deployment effect.

## Protocol references

- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html): identity claims, authorization-code flow, token validation, and subject types.
- [OAuth security best current practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): PKCE S256, redirect validation, and refresh-token protections.
- [Keycloak administration guide](https://www.keycloak.org/docs/latest/server_admin/index.html): the selected self-hosted provider.
