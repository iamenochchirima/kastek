# Platform login

Agents uses Keycloak 26.6.0 through its independent confidential `agents` client.
Provider configuration is maintained by [local identity](../../../../infra/identity/README.md).
Local real-provider acceptance verifies login, state/nonce/PKCE rejection,
product logout, signed backchannel logout and replay. The execution client token
is verified with its intended audience and only the execute role. Signup-email
delivery and production identity deployment remain unverified.

## Identity and product access

The API implements authorization code login with PKCE S256, state, nonce, verified
issuer and audience, and one-use database login transactions. It requires verified
email claims. Account identity is the issuer and subject pair.

The API owns opaque product sessions, token hashes, expiry, revocation, and Agents
organization membership. Shared login does not grant workspace access. Product
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

See [product setup](../../README.md) and the
[implementation boundary](../source-boundary.md) for current acceptance limits.
