# Platform login

Agents uses Keycloak 26.6.0 through its independent confidential `agents` client.
Provider configuration is maintained by [local identity](../../../../infra/identity/README.md).
Local real-provider acceptance verifies fresh registration, local verification
email, first-workspace creation, returning login, state/nonce/PKCE rejection,
product logout, signed backchannel logout and replay. The execution client token
is verified with its intended audience and only the execute role. Production
identity deployment remains unverified.

## Identity and product access

The API implements authorization code login with PKCE S256, state, nonce, verified
issuer and audience, and one-use database login transactions. It requires verified
email claims. Account identity is the issuer and subject pair.

The public `/` landing, `/login` and `/signup` pages do not require a product
session. `/api/auth/signup` starts the same authorization-code transaction as
login with `prompt=create`, the provider's registration intent. Registration,
email verification, password recovery and credentials stay with Keycloak.

`/api/auth/login` and `/api/auth/signup` accept `returnTo`. The API permits only
internal `/app` destinations. Absolute, protocol-relative, percent-encoded,
backslash, whitespace and authentication-loop destinations fall back to `/app`.
A separate signed HttpOnly, SameSite=Lax cookie carries the destination, its
ten-minute expiry and a hash of the one-use login token. It grants no login
authority. A missing, expired, modified or mismatched cookie falls back to `/app`;
the OIDC transaction must still complete successfully. Callback failures clear
both transient cookies and return to `/login` with a bounded recovery reason.

Set optional `AGENTS_LOGIN_RETURN_SECRET` to an independent secret of at least
32 characters when return destinations must survive API restarts or multiple API
instances. Reusing the OIDC client secret is rejected. Without this setting the
API generates an independent signing key at startup; a restart invalidates only
the desired return destination, which then falls back to `/app`.

The API owns opaque product sessions, token hashes, expiry, revocation, and Agents
organization membership. On the first authenticated `/api/session` request, an account with no
workspace membership history receives **My workspace** with an owner membership. Account-row
locking prevents duplicate workspaces across concurrent requests. Existing memberships are
preserved, and revoked memberships do not trigger automatic replacement or restoration.
Additional workspaces remain an explicit action in Settings or the workspace selector.
Shared login does not grant access to other users' workspaces. Product
sessions have seven-day inactivity and thirty-day absolute limits. Backchannel
logout verifies provider notifications and deduplicates their IDs.

The browser client and the future execution-service client have independent
secrets. Service authentication alone does not authorize customer resources.
Product backend admission and embedded Growth or Agencies authorization remain
future work; they must not fabricate standalone Agents membership.

## Local endpoints

The browser origin is `http://localhost:3100`; its same-origin `/api` proxy targets
the Agents API on port 4100. Use the same hostname throughout login.

| Endpoint | Local value |
| --- | --- |
| Issuer | `http://localhost:8080/realms/kasitek` |
| Callback | `http://localhost:3100/api/auth/callback` |
| Logout return | `http://localhost:3100/login` |
| Backchannel logout | `http://localhost:4100/api/auth/backchannel-logout` |

Copy the matching `AGENTS_OIDC_CLIENT_SECRET` from the private identity environment
to the private Agents API environment. The API requires at least 24 characters.
Do not put client secrets, provider tokens, or model credentials in the web app.
Startup commands explicitly load `api/.env`; an environment template alone does
not load configuration into a process.

The disposable `api/test/platform-identity-smoke.ts` fixture creates its own
PostgreSQL database, Keycloak and Mailpit process. It exercises real registration
and the emailed verification link without changing the owner's identity realm or
workspace. It uses the Mailpit binary installed by local identity setup; set
`AGENTS_MAILPIT_EXECUTABLE` for another path. Set `AGENTS_PLAYWRIGHT_MODULE` and
`AGENTS_BROWSER_EXECUTABLE` when the default browser/module locations differ.

See [product setup](../../README.md) and the
[implementation boundary](../source-boundary.md) for current acceptance limits.
