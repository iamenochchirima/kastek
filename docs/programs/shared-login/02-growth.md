# Growth shared-login pilot

Status: Draft. Owner repository: kasitek-growth. Working branch: rewrite.
Outcome: Growth uses one provider-based login flow for a fresh project. Labs owns shared authentication; Growth owns its users, workspaces, memberships, and product sessions.
Dependency: Labs identity contract and a working local provider.

The current checklist is IMPLEMENTATION.md. Agents and Agency remain future plans.

## Work

- [ ] Implement open registration and Keycloak verification/recovery. Define Growth organization creation, invitations, onboarding, and initial owner assignment.
- [ ] Define the Growth product-user schema using issuer and subject as the external identity key.
- [ ] Add Core-owned login-start and callback handlers using state, nonce, PKCE, exact approved redirects, and one-time transaction storage.
- [ ] Validate provider signatures and claims, provision the permitted product user, and issue a Growth-local session.
- [ ] Define /api/auth/me and connect the client login, verification, and recovery screens to the provider flow.
- [ ] Remove superseded local password authentication and credential handling. Do not retain dual-login flags or legacy fallbacks.
- [ ] Enforce Growth workspace memberships on protected operations. Shared sign-in does not grant a role automatically.
- [ ] Implement HttpOnly host-scoped cookies, Secure in production and SameSite=Lax, CSRF protection, 7-day idle and 30-day absolute limits, browser-wide and all-device logout, and bounded account-disable handling.
- [ ] Update environment, startup, and authentication documentation.

## Focused verification

- [ ] Fresh users complete signup, verification, email/password, Google, passkeys, password recovery, optional two-factor/recovery codes, and logout. Use the focused checks in IMPLEMENTATION.md.
- [ ] Repeat sign-in resolves the same product user without relying on email matching.
- [ ] Invalid claims, wrong state/nonce, expired tokens, code replay, and unsafe return URLs fail.
- [ ] Invitation and signup rules are enforced; another workspace and revoked membership are denied.
- [ ] Provider outage, expiry, logout, and account suspension follow the session policy.
- [ ] One browser journey and focused Core/client checks pass.

## Release

Use fresh test identities and a clean development schema. No existing-user migration, credential import, compatibility period, or legacy fallback is required. Authenticated enrollment of Google and passkeys on a new account is included. Schema installation, operational backups, and authentication failure handling still belong to the new system.

Keep work on rewrite. Record schema/configuration revision, documentation, login/denial metrics, validation, and recovery steps before deployment. Do not promote Growth to main as part of this plan.
