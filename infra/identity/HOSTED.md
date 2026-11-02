# Hosted Identity

This image runs the pinned Keycloak 26.6.0 server with PostgreSQL. It does not use
`identity.sh`, local runtime data, Mailpit or the development `.env` file.

Build from the monorepo root:

```sh
docker build -f infra/identity/Dockerfile -t kasitek-identity:RELEASE_ID .
```

Configure the hosted service before starting it:

| Variable | Value |
| --- | --- |
| `KC_HOSTNAME` | Exact public HTTPS Identity origin |
| `KC_DB_URL` | Private PostgreSQL JDBC URL, `jdbc:postgresql://HOST:5432/DATABASE` |
| `KC_DB_USERNAME`, `KC_DB_PASSWORD` | Identity-owned database credential |
| `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD` | Independent bootstrap administrator, password at least 32 characters |
| `KC_HTTP_PORT` | `8080` |
| `RESEND_API_KEY` | Identity-owned Resend key authorized to send from the configured domain |

Railway terminates TLS. Keep `KC_HOSTNAME_STRICT=true` and the full HTTPS hostname.
Do not expose a separate direct plaintext endpoint or trust caller-controlled forwarding
headers. The public Railway proxy must overwrite forwarding headers. The image enables
health checks on the application listener; use `/health/ready` on port 8080.
Keycloak PostgreSQL data belongs on the separate database service's persistent volume.
No identity application volume is required. Use one replica initially; scale and cluster
configuration require separate validation.

## HTTPS email

The hosted image selects the `resend` email-sender SPI at build time. It sends Keycloak's
existing verification, password-reset and action templates through
`https://api.resend.com/emails`. Railway Free, Trial and Hobby plans block outbound SMTP;
HTTPS works without changing the account plan or weakening verification.

Set `RESEND_API_KEY` only on Identity, and verify the sending domain in the same Resend
account. The sender uses the realm's `smtpServer.from`, `fromDisplayName` and `replyTo` fields.
The realm configuration helper continues to populate those fields from `IDENTITY_SMTP_FROM`,
`IDENTITY_SMTP_FROM_DISPLAY_NAME` and `IDENTITY_SMTP_REPLY_TO`. Its existing SMTP transport
settings can remain stored for rollback, but the hosted sender does not use the SMTP host,
port, username or password and never falls back to SMTP. The local development runtime still
uses Mailpit and its default SMTP sender.

The provider validates HTTPS certificates, refuses redirects and bounds connection/request
waits to five/ten seconds. It does not automatically retry an uncertain send. Failures report
a bounded category or HTTP status, without logging provider response bodies, recipients,
credentials or action links. Keycloak's existing verification expiry and resend controls apply.

The email-sender SPI is internal to Keycloak, so keep the server pinned to 26.6.0 and repeat
provider tests and real verification-email acceptance before upgrading it.

The Docker build compiles the provider against the pinned Keycloak distribution and runs its
transport tests before packaging the jar. To run those checks outside Docker, set `JAVA_HOME`
to a JDK 21 installation and `KEYCLOAK_HOME` to Keycloak 26.6.0, then run:

```sh
IDENTITY_PROVIDER_BUILD_DIR=/tmp/kasitek-email-provider bash infra/identity/email-provider/build.sh
```

The checks use an injected transport and send no email. Hosted acceptance must separately
retry a real pending verification email and confirm provider acceptance/delivery. Monitor
`SEND_VERIFY_EMAIL_ERROR` and Keycloak readiness after rollout. Roll back to the previous
image and managed sender configuration if necessary; SMTP availability must be established
before treating that image as a working email fallback. No database migration is needed.

References: [Railway outbound email](https://docs.railway.com/networking/outbound-networking),
[Keycloak provider configuration](https://www.keycloak.org/server/configuration-provider),
[Resend send API](https://resend.com/docs/api-reference/emails/send-email).

## Realm and clients

Run `python3 infra/identity/configure_hosted.py` from a trusted release environment after
Identity is healthy. Supply its environment directly; the script never reads `.env`.
It sends administrator requests only to the validated HTTPS origin and refuses redirects.
It creates the `kasitek` realm when absent, then reconciles owned realm settings and
managed clients. It does not delete users or replace the database. Rerunning can update
managed callback settings or client secrets; retain the previous configuration for rollback.

Required configuration:

- `IDENTITY_PUBLIC_URL`, identical to `KC_HOSTNAME`.
- `GROWTH_FRONTEND_URL`, `AGENCY_FRONTEND_URL`, `AGENTS_FRONTEND_URL`, `ADMIN_FRONTEND_URL`.
- `GROWTH_BACKEND_URL`, `AGENCY_BACKEND_URL`, `AGENTS_BACKEND_URL`, used for backchannel logout.
- Seven different random secrets of at least 32 characters:
  `GROWTH_OIDC_CLIENT_SECRET`, `GROWTH_SESSION_ADMIN_SECRET`,
  `AGENCY_PARTNER_OIDC_CLIENT_SECRET`, `AGENCY_PARTNER_SESSION_ADMIN_SECRET`,
  `AGENTS_OIDC_CLIENT_SECRET`, `AGENTS_EXECUTION_CLIENT_SECRET`,
  `LABS_ADMIN_OIDC_CLIENT_SECRET`.
- `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD`, matching the hosted administrator.
- `IDENTITY_SMTP_HOST`, `IDENTITY_SMTP_PORT`, `IDENTITY_SMTP_FROM` and encrypted transport
  through `IDENTITY_SMTP_SSL=true` or `IDENTITY_SMTP_STARTTLS=true`.
  If authentication is required, supply both `IDENTITY_SMTP_USERNAME` and `IDENTITY_SMTP_PASSWORD`.
  Optional `IDENTITY_SMTP_FROM_DISPLAY_NAME` and `IDENTITY_SMTP_REPLY_TO` customize the sender.

Google login remains disabled unless `IDENTITY_GOOGLE_ENABLED=true` and both
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Register the exact
`IDENTITY_PUBLIC_URL/realms/kasitek/broker/google/endpoint` with the provider before enabling it.
The passkey relying-party ID is the Identity hostname. Changing this hostname after
passkeys are enrolled requires a separate authentication migration.

Match each secret to its consuming backend's current configuration names. Product
memberships and admin grants remain in their product databases; realm login grants no
product access by itself. Growth and Agency session-revocation service accounts receive
`realm-management/manage-users`; human login clients receive no such roles.
Agents execution retains its separate narrowly scoped execution role and audience.

## Acceptance and rollback

Verify discovery's issuer and HTTPS endpoints, callback destinations, registration,
real verification email delivery, login/logout, all-device session revocation and cross-product
permission isolation. Confirm the browser proxy overwrites forwarding headers and rejects
spoofed Host/origin inputs. Offline configuration checks do not establish provider or email
acceptance. After initial bootstrap, remove the bootstrap password from the running service
and store administrative recovery access privately. Keep it only in the trusted release
environment when intentionally running realm configuration again.

Record image digest, source snapshot, secret/configuration revision, database backup,
readiness and authentication evidence in the release record. This packaging adds no product
analytics event; existing Keycloak event retention remains seven days. Infrastructure logs
must omit credentials and tokens. Monitor failed logins, email failures and readiness.
Rollback uses the previous image and managed configuration; back up the database before a
Keycloak upgrade and follow Keycloak's upgrade policy. A schema-changing upgrade cannot be
reversed by changing the image alone. Do not delete the database during rollback.

References: [container deployment](https://www.keycloak.org/server/containers),
[hostname](https://www.keycloak.org/server/hostname),
[reverse proxy](https://www.keycloak.org/server/reverseproxy),
[realm import](https://www.keycloak.org/server/importExport).
