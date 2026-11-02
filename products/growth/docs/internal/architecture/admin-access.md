# Admin access

The Labs Admin browser authenticates through Growth. The `kasitek_admin_session` cookie contains a random 256-bit token. Growth stores only its SHA-256 hash in `AdminSession`, with an eight-hour expiry and optional revocation time. Raw AdminUser identifiers are rejected. Logout revokes the server session before the browser clears its cookie. Password changes and password resets revoke all of that administrator's sessions.

Cookies are HttpOnly, SameSite=Lax and Secure in production. Configure `ADMIN_FRONTEND_URL` to the browser's actual origin. Admin-site resource API mutations require that origin and reject cross-site requests. Growth repeats the origin check for authenticated mutations. The Next proxy forwards the configured admin origin only after the incoming resource request passes its policy. Authentication and NextAuth routes retain their own entry points.

## Permissions

The shared `adminCapabilities` matrix in `@kasitek-labs/server-support/admin-authority` is enforced by the Admin proxy and receiving product boundary.

| Role | Capabilities |
| --- | --- |
| viewer | Read and aggregate reporting |
| support | Read, aggregate reporting and support |
| security | Read, aggregate reporting and security |
| operator, admin | Read, aggregate reporting, commercial write, operations and export |
| owner, superadmin | All preceding capabilities, support, security and emergency |

API-key, staff and access mutations require security capability. Changing one's own password requires an authenticated read capability. Existing support-content grants remain necessary; reporting access does not authorize customer-content access.

## Product service authority

Set `KASITEK_ADMIN_SERVICE_SECRET` to the same private random value of at least 32 bytes in Admin and each receiving product. It must remain server-side. Missing or short configuration fails closed. Agency no longer accepts `x-admin-secret` alone.

Admin sends `x-kasitek-admin-authority`, an HMAC-SHA256 assertion containing the verified Growth admin ID and role, issuer `kasitek-admin`, receiving audience, capability, HTTP method, complete path including query, SHA-256 body digest, nonce and 60-second expiry. The receiving product checks every binding and derives permissions from the shared matrix. Agency records mutation nonces in its own database to reject replay. It does not create a second admin identity database.

Mutation and export audit logs contain actor ID, role, service, route template, method, status and request ID. They omit tokens, credentials, request bodies and customer content. The assertion header is redacted. Retain these logs through the configured central logging pipeline; they are not billing records.

## Rollout and invalidation

1. Apply Growth Prisma migration `20261023030000_admin_sessions` to the intended environment.
2. Apply Agency migration `20261023030000_admin_authority_nonces` through its normal migration runner.
3. Configure the private service secret and the actual admin origin before starting the updated services.
4. Restart the affected services. All old raw-ID cookies are invalid; sign in normally.

No migration was applied to the connected development PC or production during implementation. Use the disposable test database for verification. Expired/revoked sessions can be pruned after their retention window; removing them never reactivates a session. To revoke every session immediately, set `revokedAt` on active `AdminSession` rows in the owning Growth database through an authorized operational procedure.

Rollback must disable Admin access before reverting the code or migrations. Do not restore raw-ID cookie acceptance. Keep the additive tables while investigating a rollback. No analytics event schema or customer data migration is needed for this access change. Release identity follows the deployed Git commit; security HTTP tests cover local validation, with staging validation and deployment owner-managed.

## Verification

The focused fixtures use `ADMIN_SECURITY_TEST_DATABASE_URL`, pointing only to an isolated disposable PostgreSQL database. Run the Growth `admin-session-security.test.ts`, Agency `admin-authority.test.ts`, shared `admin-authority.test.mjs` and Admin `admin-proxy-policy.test.ts` tests. They cover anonymous and role paths, fabricated/expired/revoked sessions, origin checks, audience/body/query binding and Agency replay prevention. Model evals are owner-run and are not part of these HTTP security checks.
