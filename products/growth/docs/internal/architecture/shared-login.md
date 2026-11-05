# Growth shared login

This page describes the current Growth login contract. Keycloak 26.6.4 is also selected for the
initial standalone Agents product, with a separate application client and fresh Agents membership
records. Shared identity does not synchronize product permissions or workspace membership.

Growth keeps its own authorization. Its shared-execution integration is not implemented yet.
Embedded features will not require an Agents-product account or subscription. The target execution
architecture is recorded in `products/agents/docs/architecture/agent-platform-architecture.md` in
the repository. This browser login contract does not define external MCP OAuth access or machine
delegation.

Labs operates Keycloak. Growth never accepts human passwords, Google authorization codes,
OTP codes, or email-verification tokens. Passwords, Google, passkeys, optional MFA and
recovery are configured in the Labs realm. A local account is keyed by the verified issuer
and subject in `ExternalIdentity`; matching email addresses do not link accounts.

## HTTP contract

The frontend proxies `/api` to Core. Use the browser origin for `OIDC_REDIRECT_URI`
(`http://localhost:3000/api/auth/callback` in development). Cookies are host-only,
HttpOnly, SameSite=Lax and Secure in production; deployment must keep the product API
under its browser origin. Identity tokens never enter browser storage.

- `GET /api/auth/login?returnTo=/local/path&screen=signup`: starts authorization code
  authentication with PKCE S256, state, nonce and a browser-bound ten-minute transaction.
  `screen=signup` requests the provider registration screen.
- `GET /api/auth/callback`: consumes the transaction once, exchanges the code, validates
  the ID token and access-token hash, requires verified email and provisions the local user.
- `GET /api/auth/me`: returns `{user}` using the existing product profile shape.
- `GET /api/auth/account`: authenticated redirect to the provider account console.
- `POST /api/auth/activity`: real user activity, returns 204. The frontend sends this
  at most once per minute in response to pointer/keyboard events. Background GETs never
  renew product inactivity. Background non-GET requests must set `x-kasitek-background: 1`.
- `POST /api/auth/logout`: returns `{redirectUrl}`; the browser navigates there to end
  central login in this browser. Core clears its local session and cookie first.
- `POST /api/auth/logout-all`: invokes the dedicated provider service account to revoke
  all provider sessions for this user, removes all Growth sessions and returns the logout redirect.
- `POST /api/auth/backchannel-logout`: accepts provider form `logout_token`. RS256 signature,
  issuer, audience, event, sid/sub, issued-at age and one-time jti are checked. Replay is rejected.

All cookie-authenticated unsafe product operations (POST/PUT/PATCH/DELETE), including
activity, profile edits, organization changes and logout, require Origin matching
`FRONTEND_URL`. Machine bearer credentials remain a separate boundary. Provider redirects
and callback destinations are configuration, not user-supplied absolute URLs. Errors expose
no tokens or provider response bodies.

## Sessions and permissions

Session cookie values are random; only SHA-256 hashes are persisted. Refresh and ID tokens
remain in the backend database, so database access and backups are secrets. Protect them with
restricted database credentials, encryption at rest and restricted backups.

The session ends after seven days without activity or thirty days from the provider's
`auth_time`. A new product session cannot reset the provider's absolute authentication age.
Expired sessions cannot be revived by activity requests. Every authenticated request checks
local expiry. At most every `OIDC_REVOCATION_CHECK_SECONDS` (default 300, capped at 300),
Core introspects the refresh token under a row lock without extending provider idle time.
Only actual user activity renews a provider refresh token, using a separate refresh-time
clock; polling cannot postpone provider expiry. An inactive or rejected token removes the session.
Provider outages fail closed once revalidation is due. This five-minute revocation bound is
an engineering default pending final owner policy.

A new user initially has no organization. The user creates one using existing `POST /api/orgs`
and then completes onboarding, or accepts an invitation while authenticated. Existing
membership and role checks remain database-backed. The active organization cookie is only
a preference. It never supplies authorization. Legacy credential invitation activation and
local profile password/email-change endpoints are not registered. Product name, image and
phone editing remain product-local; login email changes happen in Keycloak and synchronize
at the next successful login.

## Configuration and schema

Required: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`.
All-device logout additionally needs `OIDC_ADMIN_CLIENT_ID` and `OIDC_ADMIN_CLIENT_SECRET`
for the Labs `growth-session-admin` service account. These values are server-only.
`FRONTEND_URL` must identify the frontend origin. The provider requires exact callback and
post-logout URLs and a reachable direct Core backchannel logout URL.

Development product invitations can use `LOCAL_MAILPIT_URL=http://localhost:8025`
for a native loopback Mailpit sink; production uses Resend. Missing delivery configuration
is an explicit error. The provider verification/recovery email configuration is separate.

Apply Prisma migration `20261002120000_shared_identity` before starting the new Core.
It clears obsolete local sessions, creates identity/transaction/replay tables and extends
Session. This is a fresh project implementation with no legacy authentication fallback.

## Release record

Owner: Labs/Growth platform. Risk: high (authentication, authorization boundary and schema).
Affected surfaces: all Growth human authentication; product-local permissions remain.
Release identity: pending release; no deployment performed by this change.
Rollout: local first, schema plus Labs configuration plus Core/frontend released together.
Analytics: no new product event catalog; structured `auth.login.success` records success
without credentials. Provider audit events supply failures, recovery and account changes.
Validation: Core compilation and seven focused authentication tests passed. Local browser
signup, verification, password reset, passkey enrollment/sign-in/deletion, optional OTP and
one-time recovery, organization creation/onboarding, workspace denial and both logout modes
passed. Controlled timestamps verified expiry; account disable and provider outage rejected
access at revalidation. Client TypeScript/ESLint and production build passed. Google
returns redirect_uri_mismatch until the owner updates its external OAuth callback.
Invitation creation, Mailpit delivery and frontend acceptance passed; membership removal
immediately denied organization access while leaving the identity session valid. Real Google
method-link browser checks remain outstanding.
Rollback: stop local services and revert this development change; no compatibility login
mode. Restore only a deliberate development backup when schema recovery is necessary.
Production monitoring and release date: pending production work.

## References

- [openidconnect authorization code and PKCE verification](https://docs.rs/openidconnect/latest/openidconnect/)
- [OIDC Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [Keycloak refresh-token introspection implementation](https://github.com/keycloak/keycloak/blob/26.6.4/services/src/main/java/org/keycloak/protocol/oidc/RefreshTokenIntrospectionProvider.java)
- [Mailpit Send API](https://mailpit.axllent.org/docs/api-v1/)
