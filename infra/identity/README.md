# Local shared identity

Labs operates native Keycloak 26.6.0 with a dedicated PostgreSQL database and Mailpit. No Docker is used. This setup is for local development. Production requires HTTPS, a stable hostname, production email delivery, secret management, and a separately reviewed deployment.

## Start

Copy `.env.example` to `.env`, replace every secret placeholder with independent random values, and keep file permissions at `0600`. Do not commit `.env` or exports. Python's `secrets.token_urlsafe(32)` can generate each secret.

```sh
./identity.sh install
./identity.sh start
./identity.sh status
./identity.sh stop
```

`install` explicitly downloads checksum-pinned Keycloak, a Java 21 runtime, and Mailpit into ignored `.runtime/`. Archives are deleted after extraction. Linux x86_64 is supported by the supplied lock; another platform needs its own approved runtime URLs. PostgreSQL uses already installed native binaries, or `IDENTITY_POSTGRES_BIN` pointing to them.

`start` validates required secrets and SMTP settings before creating or starting processes, then creates a separate local PostgreSQL cluster on port 55432, starts Mailpit and Keycloak, checks readiness, configures optional recovery-code authentication, and enables Google when both credentials are supplied. `stop` stops only these identity processes; it does not stop the laptop's existing PostgreSQL database. Runtime data and process logs remain in `.runtime/`.

Java heap is capped at 512 MB with a 128 MB initial heap. Total process memory includes non-heap allocations and can exceed that cap. PostgreSQL shared buffers are 32 MB and its connection count is limited. Measure actual RAM before running the complete product stack; stop identity when it is not needed.

- Shared login and account console: `http://localhost:8080/realms/kasitek/account/`
- Provider administration: `http://localhost:8080/admin/`, using the separate `master` realm and credentials from `.env`.
- Development email inbox: `http://localhost:8025/`
- Readiness: `http://localhost:9000/health/ready`
- Discovery: `http://localhost:8080/realms/kasitek/.well-known/openid-configuration`

PostgreSQL uses port 55432 and SMTP uses port 1025. Identity HTTP, PostgreSQL, and Mailpit bind to loopback only. Do not expose these development services publicly.

## Growth contract

Core uses these environment settings. Copy the same client secret from the ignored identity `.env` without logging it.

```dotenv
OIDC_ISSUER_URL=http://localhost:8080/realms/kasitek
OIDC_CLIENT_ID=growth
OIDC_CLIENT_SECRET=<same GROWTH_OIDC_CLIENT_SECRET>
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
OIDC_ADMIN_CLIENT_ID=growth-session-admin
OIDC_ADMIN_CLIENT_SECRET=<same GROWTH_SESSION_ADMIN_SECRET>
```

The callback goes through Growth's existing same-origin API proxy to Core on port 4000. The logout return URL is exactly `http://localhost:3000/login`. The backchannel endpoint is Core's `http://localhost:4000/api/auth/backchannel-logout`. The separate revocation service account has realm-management/manage-users permission to end provider sessions. This is a privileged backend-only credential; never expose it to the browser. It is restricted to the shared account realm, not the master administration realm. Each production product gets its own OIDC client and exact callbacks; there are no wildcard redirects or shared parent-domain product cookies.

## Agents contract

Agents uses the confidential `agents` browser client. The Vite web app runs on port 3100 and proxies `/api` to the Agents API on port 4100. Its callback is exactly `http://localhost:3100/api/auth/callback`, its logout return is `http://localhost:3100/login`, and its backchannel endpoint is `http://localhost:4100/api/auth/backchannel-logout`. Authorization code login requires PKCE S256. Password and implicit grants are disabled. Copy `AGENTS_OIDC_CLIENT_SECRET` from the ignored identity `.env` into the Agents API's ignored environment with the same name.

The independent `agents-execution` confidential service client uses `AGENTS_EXECUTION_CLIENT_SECRET` and client credentials. Its access token has audience `agents-execution` and the client role `execute`. Browser flows, wildcard redirects, optional scopes and full scope access are disabled. It receives no realm-management permissions. The `configure` command creates missing Agents clients, reconciles their callbacks and scopes, and updates their independent secrets. It preserves Growth and Agency registrations.

Service authentication identifies a caller. An application execution grant separately authorizes a product, organization, resource, initiating principal, immutable agent version, capabilities and lifetime. Admission and subsequent actions must check current grant validity. Provider token exchange is not the application grant or its revocation mechanism. Agents memberships remain in the Agents product database; shared login alone grants no product access.

These registrations configure the identity provider. They do not prove that the application's login, backchannel logout or execution API has been implemented or verified. Validate provider configuration offline with `python3 -m unittest discover -s infra/identity -p 'test_*.py'` from the repository root. Exercise the real application login and logout paths before release.

## Agency partner contract

Agency uses a separate confidential client named `agency-partner`. Its local callback is `http://localhost:3010/api/tenant/api/partner/auth/callback`, its post-logout return is `http://localhost:3010/login?audience=partner`, and its backchannel logout endpoint is Agency's `http://localhost:8090/api/partner/auth/backchannel-logout`. Set the same independent `AGENCY_PARTNER_OIDC_CLIENT_SECRET` in this ignored identity `.env` and Agency's ignored Tenant API `.env` as `TENANT_PARTNER_OIDC_CLIENT_SECRET`. The `agency-partner-session-admin` service account uses a separate `AGENCY_PARTNER_SESSION_ADMIN_SECRET` in identity and `TENANT_PARTNER_OIDC_ADMIN_CLIENT_SECRET` in Agency; its realm-management permission revokes this user's shared-provider sessions for all-device logout. Then run `./identity.sh configure`. The API validates issuer, audience, nonce and PKCE, and enforces its own 7-day inactivity and 30-day absolute session limits. Agency owner identities and memberships remain in the Agency database; Keycloak login alone grants no business access.

## Account behavior

Registration is public. Email/password registrations require verification. By default, local verification messages go to Mailpit at `http://localhost:8025/`; this does not deliver to real inboxes. To use real addresses during local development, set `IDENTITY_SMTP_HOST`, `IDENTITY_SMTP_PORT`, and `IDENTITY_SMTP_FROM` together in the ignored `.env`. Set both `IDENTITY_SMTP_USERNAME` and `IDENTITY_SMTP_PASSWORD` when the provider requires authentication. Authenticated SMTP requires TLS: choose either `IDENTITY_SMTP_SSL=true` or `IDENTITY_SMTP_STARTTLS=true` as required by that provider. Set `IDENTITY_SMTP_FROM_DISPLAY_NAME` and `IDENTITY_SMTP_REPLY_TO` if needed, then run `./identity.sh configure`. These settings are applied to the local Keycloak realm; credentials are never printed. Leave the SMTP override fields blank to keep Mailpit as the local default.

Growth's current transactional mail adapter uses Resend. Keycloak can use Resend's SMTP service with host `smtp.resend.com`, port `465`, username `resend`, SSL enabled, and a Resend API key as the password. The sender must be on a verified Resend domain. Use a dedicated sending-only API key restricted to that domain for Identity rather than sharing Growth's key. See [Resend SMTP setup](https://resend.com/changelog/smtp-service) and [API key permissions](https://resend.com/changelog/new-api-key-permissions).

Password reset belongs to Keycloak. Google is the only social provider. Passkeys are enabled with resident credentials and user verification, using `localhost` as the local relying-party ID. Use `localhost` consistently, not a mixture of localhost and IP addresses. A production RP domain must be settled before enrolling production passkeys.

Users add passkeys or connect Google from the account console after signing in. The default first-broker-login flow requires proof of an existing account before linking; matching email alone must never silently merge identities. Optional OTP enrollment requests recovery codes, which are one-time second-factor alternatives. No default action forces OTP enrollment for ordinary users or administrators.

Provider and product sessions have a 7-day inactivity limit and 30-day absolute limit. Remember-me does not increase either limit. Growth must enforce its own limits, fresh authentication at the absolute deadline, idle activity rules, and product revocation. Provider configuration alone cannot revoke opaque product cookies.

Normal logout ends the shared provider session and the calling product's session for this browser. Growth and Agency have separate all-device revocation clients and must revoke their own local sessions as well as the provider sessions for that subject. Neither operation logs the user out of Google. Agency staff/client identity federation remains follow-up work; their current accounts stay workspace-specific.

## Google setup

Create or reuse a Google OAuth web client approved for this development application. Register this exact authorized redirect URI:

```text
http://localhost:8080/realms/kasitek/broker/google/endpoint
```

Configure consent-screen audience and allowed test users as appropriate to that Google project. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the ignored `.env`, then run `./identity.sh configure`. No guessed credentials are generated. Google stays unavailable until real credentials exist. In this local implementation the existing credentials are configured, but the owner has deferred correcting Google's redirect URI; actual Google login remains unverified. Production uses a separate approved HTTPS broker callback and deployment secrets.

## Configuration and recovery

The realm JSON imports only when `kasitek` does not already exist. Changing it does not update an existing realm automatically. The configure command reconciles login scope mappers, client secrets, Google credentials, optional recovery-code execution, authenticated credential deletion and audit settings. Other realm edits require reviewed Admin API or console changes, then export. Never delete the native database directory to apply a configuration edit to accounts you need to keep.

```sh
./identity.sh backup
./identity.sh stop
./identity.sh export
./identity.sh restore .backups/identity-<timestamp>.sql
./identity.sh start
```

Backups contain account and credential data. Keep the ignored backup directory private. The restore command requires stopped identity services and restores only into an isolated `identity_restore_check` database on port 55432. Validate it before deliberately replacing the active identity database; never run restore against Growth's database.

The export command requires stopped identity services and runs the pinned Keycloak export against the dedicated database, excluding users. Exported configuration can contain secrets. On 2026-10-02 the user-free realm export, SQL backup and isolated restore were executed successfully. The export is saved under `.backups/realm-export/kasitek-realm.json`. Take a database backup before upgrades. These scripts do not manage production backups.

Lost passkey or Google access can be recovered with another enrolled method or verified password reset. Recovery codes recover the second factor, not the primary identity. Avoid deleting the last usable login method without a recovery path. Account disable and logout require bounded product revocation; Growth's documented integration defines that enforcement.

## Verification and references

Check readiness/discovery and use the actual Growth browser code flow. Test fresh signup/email verification, password reset, optional OTP/recovery, passkeys, method linking, expiry, and logout. Google requires configured credentials and passkeys require a capable browser/authenticator. Configuration inspection is not proof of those browser flows.

- [Keycloak configuration](https://www.keycloak.org/server/configuration)
- [Keycloak administration, passkeys, recovery codes and session settings](https://www.keycloak.org/docs/latest/server_admin/index.html)
- [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth security, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)

## Labs admin contract

Labs administration uses the independent confidential `labs-admin` client. Its callback is
`http://localhost:3001/api/operations-auth/callback`; its logout return is
`http://localhost:3001/login`. Backchannel logout goes through
`http://localhost:3001/api/operations-auth/backchannel-logout` to Operations.
PKCE S256 is required. Password, implicit and service-account grants are disabled.
The client receives no customer membership or realm-management roles.

Set an independent `LABS_ADMIN_OIDC_CLIENT_SECRET` in the ignored identity `.env` and run
`./identity.sh configure`. Copy that secret into the Operations service's private profile as
`OPS_OIDC_CLIENT_SECRET`, alongside `OPS_OIDC_ISSUER`, `OPS_OIDC_CLIENT_ID=labs-admin`,
`OPS_PUBLIC_URL=http://localhost:3001`, the exact `OPS_OIDC_REDIRECT_URI`, and
`OPS_SESSION_ENCRYPTION_KEY` (32 random bytes encoded as 64 hex characters).
Production requires HTTPS and separately reviewed client registration and operator grants.

Identity login grants no administrator access. Provision an explicit issuer, provider subject
and stable administrator ID in the Operations database with the service's `provision-admin`
command. The operator ID, reason and resulting grant are audited. Name and email are display
metadata; neither assigns roles or links customer accounts. Existing IDs cannot be reassigned
to a different identity. Principal disable or role changes revoke existing sessions through
an incremented grant revision.

Operations stores only hashed opaque cookies and encrypts provider refresh tokens server-side.
Sessions have a 30-minute inactivity deadline and an 8-hour absolute deadline. Provider refresh
is required at most every 60 seconds; unavailable or revoked refresh credentials invalidate the
session. Local logout remains effective during provider outages. A Growth outage does not
prevent existing Operations sessions or new shared-provider logins.
