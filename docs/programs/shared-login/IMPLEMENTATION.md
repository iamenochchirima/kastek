# Shared login implementation plan

Status: Local Labs and Growth implementation delivered. Focused local checks passed; Google browser verification is deferred until the owner updates its OAuth redirect. No production deployment.
Date: 2026-10-02.
First delivery: local self-hosted identity provider plus Growth sign-in built for a fresh project.
Owner: Enoch. Implementation: this login task, with coordinated backend and frontend agents.

This is the current implementation checklist. The other files in this folder are earlier draft workstreams and background material. Use this file for scope and progress.

## Agreed direction

- Labs owns and operates shared sign-in.
- Labs will self-host Keycloak. Run natively locally, without Docker; production deployment follows later.
- Offer email/password, Google social login, and passkeys through the same provider.
- Anyone can register. Verify email/password registrations and provide email password reset.
- Growth keeps organization memberships and roles separate from account registration.
- Product sessions use HttpOnly, host-scoped cookies, Secure in production and SameSite=Lax. Provider tokens stay on the backend.
- Sessions expire after 7 days without activity, with a 30-day absolute limit requiring fresh authentication.
- Normal logout ends shared KasiTek sign-in and connected product sessions in this browser. A separate action signs out all devices. Neither action signs the user out of Google itself.
- Two-factor authentication is optional for administrators and ordinary users. Offer recovery codes to users who enable it.
- Growth is the first product to integrate.
- This is a fresh project. Build one authentication flow with no existing-user migration, legacy compatibility, or old-login fallback. Authenticated enrollment of Google and passkeys on a new account is included.
- Each product owns its workspaces, memberships, roles, subscriptions, and application sessions.
- Agency customer accounts are agency-specific and isolated from other agencies. They do not automatically become shared KasiTek accounts.
- Keep Growth work on rewrite. Do not promote it to main as part of this work.

The primary partner rule is decided: the primary agency partner signs in through the shared Labs provider and gets access only through Agency-owned business memberships. Other agency staff and client users remain workspace-specific. Partner login and self-service business creation are tracked in [the Agency self-service plan](../agency-self-service/IMPLEMENTATION.md); broader staff/client federation remains deferred.

## Selected implementation

Use self-hosted Keycloak as the identity provider. The owner has confirmed Keycloak and the account and session policies above.

Labs will own its native service configuration, login customization, account database, email configuration, backups, and operating instructions. We will configure established authentication software rather than build password recovery, token issuance, and the OIDC protocol ourselves.

Use a dedicated identity PostgreSQL database and database credentials. Products continue using their own databases. Shared crates may provide repeated client-side verification helpers later; account synchronization and sign-in happen through the provider's HTTPS interfaces.

Each participating product has its own registered OIDC client and exact callback URLs. A shared provider sign-in session can avoid another password prompt when someone switches products. Each product still creates its own session and checks its own permissions.

### Growth sign-in flow

1. Growth sends the user to the shared login page.
2. The identity provider authenticates the user.
3. It redirects back to Growth with a short-lived authorization code.
4. Growth Core exchanges that code on the backend using Authorization Code with PKCE S256.
5. Core validates the identity and maps issuer plus subject to a Growth product user provisioned under the signup policy.
6. Growth issues its local session. Growth organization memberships decide access.

Provider tokens and client secrets stay on the backend. The browser receives a secure, HttpOnly, host-scoped application cookie. We will not use a cookie shared across all product domains.

## What we implement first

Implement phases 1 through 3 for local development and synthetic users. Phase 4 is the focused verification needed to finish that pilot.

The first delivery runs locally with fresh test accounts. Production hosting and other product integrations follow separately.

### Phase 1: Labs local identity foundation

- [x] Record Keycloak and the accepted login policies in the existing Labs identity ADR.
- [x] Add a version-pinned native Keycloak and Java setup under Labs infra/identity/ with a dedicated PostgreSQL database and persistent storage. No Docker.
- [x] Add an example configuration with secret placeholders, readiness checks, and documented start/stop commands.
- [x] Configure a development identity space for shared KasiTek accounts and a Growth OIDC client. Keep the provider's administration space separate.
- [x] Register exact local Growth callback URLs and define issuer, client ID, and signing-key discovery settings.
- [x] Enable open registration, email/password, email verification, and email password reset. Configure a local email sink.
- [x] Configure Google as the only social provider, with server-side credentials and exact broker callbacks. Document Google OAuth setup for development and production.
- [x] Enable passkey enrollment, sign-in, and removal. Document supported development origins and production HTTPS hostname requirements.
- [x] Connect multiple methods to one account only after proof of account control. Never merge accounts solely because their email addresses match.
- [x] Enable optional two-factor enrollment and removal for administrators and ordinary users. Provide recovery-code generation, one-time use, and regeneration.
- [x] Configure shared login to expire after 7 inactive days and a maximum of 30 days. Remember-me and token renewal must not extend the absolute limit.
- [x] Configure provider logout and product logout notifications for current-browser and all-device sign-out.
- [x] Write local setup, account creation, configuration export, and database backup/restore instructions.

Acceptance: Labs starts the identity provider locally with one synthetic account. Growth's registered client can initiate a standards-based sign-in flow.

### Phase 2: Growth identity mapping and backend

- [x] Implement open Growth registration and define organization creation, initial owner assignment, onboarding, invitations, and authorized approval for joining existing organizations.
- [x] Define the fresh Growth user schema and identify users by the provider's issuer and subject. Keep Growth memberships and business data product-owned.
- [x] Provision new Growth product users after verified provider sign-in. Use issuer and subject as the identity key, not email.
- [x] Add backend-owned login-start and callback handlers with one-time transaction storage, state, nonce, PKCE, and approved return URLs.
- [x] Validate token signatures, issuer, audience, expiry, and nonce using a maintained OIDC implementation.
- [x] Issue an opaque Growth-local session in an HttpOnly, host-scoped cookie, Secure in production and SameSite=Lax. Keep provider tokens backend-only, protect state-changing requests against CSRF, and define /api/auth/me.
- [x] Remove obsolete private-registration gates that conflict with open registration. Enforce onboarding and organization memberships; authentication alone does not grant access to an existing workspace or role.
- [x] Enforce 7-day inactivity expiry and the 30-day absolute limit in Growth sessions. Define qualifying user activity; background polling must not keep an abandoned session alive.
- [x] Coordinate Growth and provider session renewal. Require fresh authentication at the 30-day limit, preventing silent provider sign-in from bypassing it.
- [x] Implement normal logout across shared login and connected products in this browser. Validate provider logout notifications and revoke product sessions.
- [x] Implement a separate sign-out-all-devices action covering provider and product sessions on every device. Leave Google account sessions unaffected.
- [x] Implement account-disable handling with configurable revalidation, capped at 5 minutes. The 5-minute engineering default remains subject to the owner's policy preference; Growth-initiated logout is immediate.

Acceptance: A fresh test user signs in through the provider and receives the correct Growth access and onboarding.

### Phase 3: Growth login screens and pilot controls

- [x] Replace the current product password-login flow with provider sign-in. Remove superseded authentication routes and local credential handling; do not keep a second login path.
- [x] Connect Growth's sign-in UI to the new backend flow and return users to the intended page.
- [x] Connect open signup, verification, password reset, and invitations to their identity/product behavior.
- [x] Offer email/password, Google, and passkey sign-in through the shared login page.
- [x] Provide account-management entry points for connecting methods, managing passkeys, optional two-factor authentication, and recovery codes.
- [x] Provide normal logout and a separate sign-out-all-devices action with clear descriptions.
- [x] Show concise errors for denied access, expired login attempts, and an unavailable identity provider.
- [x] Keep workspace selection and membership checks in Growth. Leave Core-to-Agents service authentication and API keys separate.
- [x] Update local launcher/environment documentation so the identity provider starts from Labs and Growth consumes its configured endpoint.
- [x] Update current Growth authentication documentation after the implemented behavior is verified.

Acceptance: One browser journey signs in through the local provider, opens a Growth workspace, switches only among permitted workspaces, and signs out.

### Phase 4: Focused verification

Keep checks narrow. Authentication requires these checks even though broad test suites are unnecessary.

- [x] Complete open signup, email verification, password login/reset, and logout with a fresh test user.
- [ ] Complete actual Google sign-in with configured development credentials; verify repeat login resolves the same account.
- [x] Enroll a passkey, sign in, and remove it on the same password account.
- [ ] Verify Google reaches that account after authenticated method connection, once its external redirect is updated.
- [ ] Reject unsafe method connection based only on matching emails.
- [x] Confirm ordinary users and administrators can sign in without two-factor authentication. Verify optional enrollment, recovery codes, and rejection of reused codes.
- [x] Confirm repeat sign-in resolves the same new product user and respects public signup and organization memberships.
- [x] Complete owner invitation creation, Mailpit delivery and authenticated frontend acceptance into the organization.
- [ ] Reject wrong state/nonce/issuer/audience, expired tokens, reused authorization codes, and unsafe return URLs.
- [x] Confirm product-user lookup uses issuer and subject rather than granting access from an email match.
- [x] Deny selection of an unauthorized workspace without changing the active cookie.
- [x] Verify membership removal immediately changes organization access from 200 to 403 while the identity session remains valid.
- [x] Verify 7-day idle and 30-day absolute expiry with controlled timestamps or a test clock. Activity renews only the idle deadline; the absolute limit requires fresh authentication.
- [x] Verify normal logout ends shared login and product sessions in this browser, while another device stays signed in. Verify all-device logout revokes that other session too.
- [x] Verify suspension and provider-outage behavior against the documented revocation policy.
- [x] Inspect cookie attributes and verify CSRF protections on state-changing requests.
- [x] Run focused Core compilation, client type checking, and configuration validation for changed files.
- [x] Check that logs contain no passwords, authorization codes, session cookies, or provider tokens.

Acceptance: Record the commands and observed browser outcomes. Do not describe configured behavior as verified without executing it.

## Local delivery evidence, 2026-10-02

- Native Keycloak 26.6.0, pinned Java 21 and Mailpit run on loopback, with a dedicated PostgreSQL cluster on port 55432. No Docker is used. Start/stop, readiness, configuration, user-free realm export, SQL backup and isolated restore were executed successfully.
- Growth migration applied locally. Core compilation, seven focused authentication tests, Prisma validation, client TypeScript/ESLint and a production client build passed. The final onboarding correction passed Core compilation and the actual browser retry.
- Browser checks passed public signup, email verification, password reset, repeated password sign-in, passkey enrollment/sign-in/deletion, optional OTP plus recovery-code generation/sign-in/reuse rejection, organization creation with initial owner membership, onboarding into workspace Overview, and rejection of unauthorized organization selection. Invitation creation/delivery/frontend acceptance passed; membership removal immediately denied organization access while leaving sign-in valid. Account controls were inspected at desktop, tablet and mobile widths.
- Two browser contexts proved current-browser versus all-device logout. Controlled UTC timestamps proved idle/absolute expiry and that polling does not extend activity. Account disable and an isolated provider-outage configuration proved bounded rejection and fail-closed revalidation.
- Google credentials are configured, but Google returns `redirect_uri_mismatch`. The owner explicitly deferred adding `http://localhost:8080/realms/kasitek/broker/google/endpoint`. Actual Google sign-in and Google method-link verification remain unchecked.
- The 5-minute maximum revalidation interval is a configurable engineering default, not a newly accepted owner policy. Production delivery, other product clients and the later workstreams remain outside this local delivery.
- Synthetic credentials, browser helpers, screenshots, logs, database dumps and exports remain in ignored private directories. No secrets are committed. Implementation stays on Labs `main` and Growth `rewrite`; no push, merge or deployment is included.

## Later product adoption

These are later workstreams, not tasks to start alongside the initial pilot.

### Agents

- [ ] Add independent human sign-in through the shared provider and an Agents-local session.
- [ ] Replace the management UI's current dependence on Growth's human login.
- [ ] Define and enforce Agents-local memberships and permissions with separate machine credentials and authorized Growth integrations.

### Agency

- Partner sign-in and self-service business setup are tracked in the [Agency self-service implementation plan](../agency-self-service/IMPLEMENTATION.md).
- [ ] Define optional provider federation for agency-specific staff and client accounts, including login branding and recovery.
- [ ] Verify cross-agency and client-versus-administrator isolation before any staff/client provider rollout.

### Labs Admin

- [ ] Define explicit staff entitlement. Carry forward optional two-factor authentication for administrators; do not add mandatory MFA without a new owner decision.
- [ ] Replace the current dependency on Growth AdminUser login through a separately registered privileged client.
- [ ] Enforce administrative authorization at the Growth and Agency API endpoints, with suspension and audited access.

## Decisions and remaining setup

The owner has agreed Keycloak, email/password, Google, passkeys, open registration, HttpOnly product cookies, 7-day inactivity and 30-day absolute limits, browser-wide and all-device logout, optional two-factor authentication for everyone, email password reset, and two-factor recovery codes. These choices are complete. Implemented work and executed checks are recorded above. Unticked verification items remain explicit; configuration and source review are not proof of every browser journey.

Remaining setup and product details:

- [x] Record exact local product origins, provider hostname, and callbacks.
- [x] Obtain Google development OAuth credentials and configure the local email sink. Record setup blockers without claiming unexecuted flows passed.
- [ ] Choose the maximum disable/logout propagation delay and its enforcement mechanism.
- [x] Specify Growth organization creation, invitations, onboarding, and initial owner assignment, separate from public registration.
- [x] Document recovery for lost Google access or passkeys using another enrolled method or verified password reset. Prevent removal of the last usable method without an established recovery path.

Production hostname, hosting, real email delivery, capacity, and deployment ownership remain for production rollout. Primary-partner access is being implemented and verified in the Agency workstream. Optional provider federation for staff/client identities remains deferred.

## Agent task boundaries

Start with one implementation task: Labs local identity setup.

After the contract is agreed, separate agents can work on Labs configuration, Growth backend/mapping, and Growth frontend integration. The frontend depends on the agreed backend contract. Assign different files and one integration owner; do not let each agent invent its own login or session policy.

Use the existing Growth rewrite branch. Keep at most main plus one active working branch per other repo. These documents do not create issues, branches, pull requests, merges, or deployments.

## Release record

Build against fresh test accounts and a clean development identity schema. Schema migrations are normal installation steps; there is no existing-account conversion, credential import, dual-login period, or legacy fallback.

Before a real release, fill in:

- Owner and release/configuration revision.
- Schema/configuration revision and startup instructions.
- Test accounts, deployment steps, and failure/recovery procedure.
- Redacted signup, login, logout, and authorization-denial logs and metrics.
- Account database backup/restore evidence and provider upgrade procedure.
- Updated account recovery, authentication, operations, and user documentation.
- Validation evidence and post-release review date.

Provider failure must reject new sign-ins; it must not enable the removed password-login path. Operational backup and restore remain necessary once the new system is in use. No production release is included in this document-writing task.

## References

- [Existing Labs identity proposal](../../kasitek-labs/docs/adr/0001-shared-account-identity-boundary.md).
- [Growth release process](../../kasitek-growth/docs/internal/operations/release-process.md).
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html).
- [OAuth security best current practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).
- [Keycloak configuration guide](https://www.keycloak.org/server/configuration).

- [Keycloak administration guide](https://www.keycloak.org/docs/latest/server_admin/index.html).
