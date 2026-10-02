# Agents login integration

Status: Database foundation implemented. OIDC routes, provider revalidation,
browser cookies and frontend integration are not implemented yet.

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
  The repository itself does not perform OIDC validation.
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
  explicitly marks user activity. Provider-check timestamps are stored, but
  bounded provider revalidation still needs implementation.
- Revocation supports a single browser, all local account sessions, and a
  provider session scoped to its issuer. Local revocation does not yet call the
  provider or implement provider backchannel JWT validation.

## Next integration steps

1. Register a separate Agents confidential OIDC client, with exact localhost:3100
   callback/logout URLs and its own backend secret. Do not reuse Growth's client.
2. Add authorization-code login/signup with PKCE, state and nonce, validated
   issuer/audience/signature/expiry and provider authentication time. Keep token
   exchange and provider credentials in the backend.
3. Set the host-only HttpOnly session cookie, implement `/api/auth/me`, explicit
   workspace onboarding/selection, logout and provider session revalidation.
   Protect changing requests against cross-site submission. Polling and live
   subscriptions must not count as user activity by themselves.
4. Connect trusted browser session context to Agents API authorization. Do not
   accept browser organization/actor headers as evidence of membership. Preserve
   the independent internal machine authentication contract.
5. Adapt the existing frontend API contracts and prove actual sign-in, create,
   playground response and reopening history. Shared provider configuration and
   repository tests alone do not establish this acceptance journey.

Invitations, full role management and the personal/team workspace relationship
remain platform delivery work. No public routes have been added by this foundation.

## Focused verification

Backend TypeScript build passed. Five tests in
`test/platform-access.integration.test.ts` passed against an isolated PostgreSQL 18
cluster on 2026-10-02. The suite creates/removes a unique schema and covers identity
separation, stored-token hashing, workspace denial and revoked membership,
disabled/unverified accounts, idle/absolute expiry, and local/provider-session
revocation. The temporary cluster was stopped afterward.

To repeat with a disposable database:

```sh
PLATFORM_ACCESS_TEST_DATABASE_URL='<disposable database URL>' \
  pnpm exec vitest run test/platform-access.integration.test.ts
```

The test skips when that variable is absent; a skipped run is not verification.

See the [frontend checklist](../plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md)
and [platform delivery checklist](../plans/agents/AGENT_PLATFORM_DELIVERY_PLAN.md).
