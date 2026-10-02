# Agents login integration

Status: Backend routes and initial frontend account integration implemented.
Local client registration, password login, onboarding and browser logout verified.
The authenticated agent API facade and actual agent journey remain unfinished.

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
sessions have been revoked. Provider failure returns `providerLogoutPending: true`
so the frontend can leave the revoked session and report incomplete shared logout.

Without OIDC configuration, auth endpoints report 503 rather than creating a
temporary session. Existing internal service authentication remains independent.

## Next integration steps

1. Add signed backchannel logout handling. Initial password login, onboarding,
   account actions and activity integration are implemented. Verify multiple
   workspace switching and all-device provider logout in the browser.
2. Connect trusted browser session context to Agents API authorization. Do not
   accept browser organization/actor headers as evidence of membership. Preserve
   the independent internal machine authentication contract.
3. Adapt the existing frontend API contracts and prove create,
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

## Local setup and browser evidence

With the native Labs provider running, register only the local Agents clients:

```sh
python3 scripts/configure-local-login.py
```

The script reads the separate ignored identity admin environment for this
operator-only setup action. It writes independent Agents secrets to mode-0600
`.env`, sets exact callback/logout URLs and grants the Agents session service
realm-management/manage-users. It does not alter shared realm settings, users,
Growth clients or Google configuration. Master-admin credentials never enter
the running Agents environment. Existing secrets are reused without rotation.

The current local Agents database is an independent native PostgreSQL 18 cluster
at `.artifacts/local-postgres/data`. It listens only on its private Unix socket
directory, with no TCP listener. All migrations through 179 have passed. The API
uses `agents_local_runtime`, a non-superuser member of the existing runtime role;
the migration connection remains separate. Both URLs are in ignored `.env`.

To restart that existing development database from the Agents root:

```sh
/usr/lib/postgresql/18/bin/pg_ctl -D .artifacts/local-postgres/data \
  -l .artifacts/local-postgres/postgres.log \
  -o "-k $(pwd)/.artifacts/local-postgres -p 55434 -c listen_addresses='' -c shared_buffers=32MB -c max_connections=30" start
pnpm dev:api
```

Stop only that database with `pg_ctl -D .artifacts/local-postgres/data stop -m fast`
using the same installed binary path. Do not initialize over existing data or stop
the shared identity/Growth database.

On 2026-10-02 a dedicated local fixture completed real password sign-in, initial
workspace creation, authenticated dashboard/account rendering, a live provider
session recheck, browser logout and subsequent signed-out redirect. Signing in
again restored the saved workspace. Desktop and narrow shell checks passed.
Screenshots are under `.artifacts/`. Seven focused login-boundary checks and the
backend build passed after adding the frontend's provider-unavailable logout
handling. Actual agent creation/model execution and multiple-workspace/all-device
browser checks remain pending.

Implementation references: [openid-client](https://github.com/panva/openid-client),
[Keycloak registration prompt](https://www.keycloak.org/docs/latest/release_notes/index),
[Keycloak logout parameters](https://www.keycloak.org/docs/24.0.5/securing_apps/).

See the [frontend checklist](../plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md)
and [platform delivery checklist](../plans/agents/AGENT_PLATFORM_DELIVERY_PLAN.md).
