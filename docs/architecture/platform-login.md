# Agents login integration

Status: Database foundation and backend login routes implemented. Local client
registration and actual browser integration remain unverified.

Labs owns the Keycloak account. Agents owns platform access. An account is
identified by the validated provider issuer and subject, never a matching email.
The same user does not automatically gain access to a Growth or Agency workspace.

## Implemented foundation

Migration `178_platform_identity_sessions.sql` adds accounts, organizations,
memberships and browser sessions. `src/identity/platform-access.ts` owns their
database operations. The identity tables are backend infrastructure accessed
before tenant context is established; they do not have tenant RLS policies or
public CRUD routes. Every subsequent product operation must derive its tenant
context from a validated session and live membership, retaining the existing
RLS enforcement on product records.

- Only a server-validated identity may be recorded or used to issue a session.
  The repository itself does not perform OIDC validation. The OIDC module uses
  openid-client authorization-code validation with PKCE, state, nonce, signed ID
  token verification and the 30-day maximum authentication age.
- Verified, enabled accounts may create a named organization explicitly. Its
  initial creator gets owner membership in the same transaction. A new account
  starts with no memberships. No automatic personal workspace is assumed.
- Organization selection checks current membership. Revoked memberships disappear
  from the next session lookup, including its active organization.
- Session tokens have 256 bits of randomness. Only their SHA-256 digest is stored.
  Opaque tokens are returned only for the later backend cookie integration.
- Inactivity expires sessions after 7 days. Absolute expiry is 30 days from the
  provider authentication time, including when an existing provider session
  creates a new product cookie. Reads do not extend inactivity unless the caller
  explicitly marks user activity. Provider sessions and account status are
  rechecked through the backend realm service account at most five minutes after
  the previous check. Provider failure denies access when a recheck is due.
- Revocation supports a single browser, all local account sessions, and a
  provider session scoped to its issuer. Normal logout revokes the local cookie
  and returns a provider logout URL. Keycloak may ask for confirmation because
  product records do not retain an ID token. All-device logout revokes local
  sessions and calls the provider. Provider backchannel JWT validation remains
  pending; provider session rechecks currently bound revocation delay.

## Backend browser routes

`/api/auth/login` and `/api/auth/signup` initiate the shared provider flow.
`/api/auth/callback` consumes a single-use ten-minute database transaction and
issues a host-only HttpOnly cookie. Secure cookies use the `__Host-` prefix in
HTTPS environments. Development HTTP is restricted to localhost.

`GET /api/auth/me` returns the account, permitted organizations and selected
organization. `POST /api/auth/organizations` creates a named workspace;
`POST /api/auth/organization` selects one. `POST /api/auth/activity` explicitly
records user activity. These POST routes and logout require the configured exact
Origin. Polling `/me` does not extend the inactivity deadline.

`POST /api/auth/logout` returns `redirectTo` and `providerLogoutPending`. The
frontend must navigate to that URL; if the provider is unavailable, the local
session is still cleared and the frontend must report incomplete shared logout.
`POST /api/auth/logout-all` attempts provider-wide revocation after local account
sessions have been revoked. Provider failure returns an error, not a false success.

Without OIDC configuration, auth endpoints report 503 rather than creating a
temporary session. Existing internal service authentication remains independent.

## Next integration steps

1. Register a separate Agents confidential OIDC client, with exact localhost:3100
   callback/logout URLs and its own backend secret. Do not reuse Growth's client.
2. Configure independent Agents realm service credentials. The session-admin
   client needs realm-management/manage-users for user/session lookup and
   all-device revocation, scoped to the shared account realm. Never reuse Growth
   or master-admin credentials in the running product.
3. Connect frontend login, workspace onboarding/selection, account actions,
   explicit activity and logout to the implemented routes. Verify actual browser
   login against the shared provider. Add signed backchannel logout handling.
4. Connect trusted browser session context to Agents API authorization. Do not
   accept browser organization/actor headers as evidence of membership. Preserve
   the independent internal machine authentication contract.
5. Adapt the existing frontend API contracts and prove actual sign-in, create,
   playground response and reopening history. Shared provider configuration and
   repository tests alone do not establish this acceptance journey.

Invitations, full role management and the personal/team workspace relationship
remain platform delivery work.

## Focused verification

Backend TypeScript build passed. Five tests in
`test/platform-access.integration.test.ts` passed against an isolated PostgreSQL 18
cluster on 2026-10-02. The suite creates/removes a unique schema and covers identity
separation, stored-token hashing, workspace denial and revoked membership,
disabled/unverified accounts, idle/absolute expiry, and local/provider-session
revocation. The temporary cluster was stopped afterward.

Six focused browser-boundary checks passed for return destinations, configuration,
unconfigured-service feedback, opaque login cookies, missing callbacks, cross-site
commands and provider-unavailable logout. The three existing internal-auth checks
passed. These route checks use controlled dependencies and do not prove a real
provider login. The live Labs provider discovery endpoint returned HTTP 200.

To repeat with a disposable database:

```sh
PLATFORM_ACCESS_TEST_DATABASE_URL='<disposable database URL>' \
  pnpm exec vitest run test/platform-access.integration.test.ts
```

The test skips when that variable is absent; a skipped run is not verification.

Implementation references: [openid-client](https://github.com/panva/openid-client),
[Keycloak registration prompt](https://www.keycloak.org/docs/latest/release_notes/index),
[Keycloak logout parameters](https://www.keycloak.org/docs/24.0.5/securing_apps/).

See the [frontend checklist](../plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md)
and [platform delivery checklist](../plans/agents/AGENT_PLATFORM_DELIVERY_PLAN.md).
