# Production email and service references

Owner: Enoch Chirima. Risk: standard. Configuration revision:
`production-email-and-references-2026-11-02`. Platform baseline: 0.2.0.

## Railway variables

Growth, Agents and Agency APIs and workers use
`https://${{analytics-api.RAILWAY_PUBLIC_DOMAIN}}` for their Analytics ingestion/reporting
URLs. These direct service references let Railway display the dependency. The production
shared variables `NODE_ENV=production` and `KASITEK_ENVIRONMENT=production` supply the
corresponding environment settings on the existing Node and Analytics services. Shared values
are scoped to the production environment. Credentials, product permissions, release identities
and databases remain service-owned; no secret was made a shared variable.

Before rollout, every existing rendered variable was compared with its previous value. All
values, including credentials and resolved URLs, were identical. Private snapshots contain the
previous raw settings. Reapplying those settings and redeploying the affected services rolls
back the reference change without changing data.

## Identity email

The first hosted verification attempt failed inside Keycloak with `MailConnectException` and
`SocketTimeoutException` connecting to `smtp.resend.com:465`. A bounded TCP probe from the
Identity container reproduced the timeout. The same container connected to `api.resend.com:443`,
and Resend confirmed that `kasitek.co.za` is a verified sender domain. The previous local SMTP
AUTH probe did not test connectivity from Railway or email delivery.

Railway [requires HTTPS email APIs on its Free, Trial and Hobby plans](https://docs.railway.com/networking/outbound-networking).
Hosted Identity therefore sends Keycloak's rendered verification and account emails through
Resend's HTTPS API using the email-sender SPI. Realm templates, action tokens, email verification
requirements, sender identity and product callbacks remain owned by Keycloak. The dedicated
`RESEND_API_KEY` stays on Identity; it is never a global variable. Local development retains
its Mailpit flow. See [hosted Identity](../../infra/identity/HOSTED.md) for configuration.

## Release decisions

API and schema migrations: not applicable. New product events: not applicable. Existing
Keycloak email errors and service readiness remain the failure signals; no email body, action
link, recipient or credential belongs in application logs. Central retention and alert delivery
remain the documented platform gap. Verification of a provider's acceptance is separate from
inbox delivery and completed human verification.

Rollout uses the merged Identity artifact and existing database. Rollback restores the previous
Identity image and raw configuration without deleting accounts or disabling verification. That
image still requires permitted SMTP egress, so reverting alone does not restore email delivery
on a plan that blocks SMTP. Do not bypass verification to recover service.

Public entry points and API contracts are unchanged. Documentation changes cover hosted Identity,
service topology and this operational release record. Feature-map changes are not applicable.
Post-release review: 2026-11-03.

## Verification

Reference rollout: all 19 Railway deployments succeeded. Analytics, Growth, Operations and
Identity health checks returned 200. Analytics retained three producer registrations and a
current projection heartbeat. Twelve Analytics URL references and 22 shared-variable references
were applied across ten consumers, with every existing resolved value unchanged.

Email source verification: 13 provider checks passed, including real loopback stalled-body
and oversized-response cases, sanitized rejection/timeout handling, template fields and required
configuration. The final Identity container built successfully, and its persisted configuration
selects the `resend` provider. Twelve existing Identity configuration tests, product import
boundaries and whitespace checks passed. Hosted email acceptance is verified after deployment;
completed human verification and inbox delivery must be reported separately.
