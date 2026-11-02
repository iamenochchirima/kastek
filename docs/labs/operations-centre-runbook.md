# Operate the development incident centre

Owner: Platform engineering. Reviewed: 2026-10-23.

Use the dedicated development profile. This runbook does not enable production deployment,
external alerts, business recovery automation, or owner-run evals.

## Prepare the services

1. Build the shared packages and Operations from the repository root with Node 24.

   ```sh
   pnpm build:operations
   ```

2. Create a dedicated PostgreSQL database and private `.runtime/admin-reporting/operations.env`.
   Keep the directory mode `700` and each environment file mode `600`.
3. Configure the following API settings. Keep real credentials outside Git and tickets.

   | Setting | Value or requirement |
   | --- | --- |
   | `DATABASE_URL` | Dedicated Operations PostgreSQL database |
   | `OPS_ENVIRONMENT`, `ENVIRONMENT`, `NODE_ENV` | `development` |
   | `HOST`, `PORT` | `127.0.0.1`, `14400` for the managed profile; the package default port is `4400` |
   | `OPS_PUBLIC_URL`, `OPS_ALLOWED_ORIGINS` | `http://localhost:3001` |
   | `OPS_OIDC_ISSUER`, `OPS_OIDC_CLIENT_ID`, `OPS_OIDC_CLIENT_SECRET` | Verified issuer, `labs-admin`, and its independent client secret |
   | `OPS_OIDC_REDIRECT_URI` | `http://localhost:3001/api/operations-auth/callback` |
   | `OPS_SESSION_ENCRYPTION_KEY` | Independent 32-byte key encoded as 64 hex characters |
   | `OPS_ADMIN_AUTHORITY_SECRET` | API-only human assertion key matching configured product verifiers |
   | `OPS_SOURCES_JSON` | At most four fixed source records, one per product or Analytics |
   | `OPS_NOTIFICATION_ORIGIN`, `OPS_NOTIFICATION_SECRET` | Growth origin and separate publisher key |
   | `OPS_COLLECTION_ENABLED`, `OPS_EVALUATION_ENABLED`, `OPS_NOTIFICATIONS_ENABLED` | Independent `true` or `false` flags; start with all `false` |
   | `KASITEK_RELEASE_ID`, `KASITEK_COMMIT_SHA`, `KASITEK_ARTIFACT_DIGEST` | Actual development build identities when available |

   Each source record contains `id`, `source`, `origin`, `secret`, `enabled`, and optional
   `intervalSeconds`. Use source names `growth`, `agents`, `agency`, and `analytics`. Local origins
   are the dedicated services on ports `4000`, `14100`, `8090`, and `4300`. Observer keys require
   at least 32 bytes. Put the same destination-specific key in that source's `OPS_OBSERVER_SECRET`.
   Quote the JSON as one literal value in the environment file; do not store escaped JSON text.

4. Set `OPS_BACKEND_URL=http://127.0.0.1:14400` on the admin. Keep its existing product endpoints
   and server-only human assertion configuration.
5. Configure the dedicated `labs-admin` identity client using the
   [Labs admin identity contract](../../infra/identity/README.md#labs-admin-contract).
6. Apply reviewed product migrations through each owning runner before new source APIs start.
   Growth owns notification receipts and its heartbeat table. Agency, Agents, and Analytics own
   their heartbeat migrations. Keep the recorded migration checksums.
7. Apply Operations migrations against the dedicated database.

   ```sh
   node --env-file=.runtime/admin-reporting/operations.env services/operations/dist/migrate-main.js
   ```

   The migrator applies `001_operations.sql`, `002_auth.sql`, `003_delivery_retention.sql`, and
   `004_notification_recipients.sql`. A checksum mismatch fails the transaction. Investigate the
   binary and recorded release before changing a ledger or schema.
8. Provision an explicit verified issuer, subject, stable admin ID, role, operator ID, and reason
   through `services/operations/dist/provision-admin.js`. Use `--active false` to revoke a grant.
   Existing IDs cannot be reassigned to another provider identity. Growth adapters require the
   existing explicit product admin record with the same ID. The fresh signed Labs grant supplies
   the authoritative role.
9. Generate `.runtime/admin-reporting/operations-worker.env` with the process manager's
   `operationsWorkerProfile` helper. Copy only its allowlisted values. Never copy human assertion,
   OIDC-client, session-encryption, or browser-session credentials into that file.

## Start and inspect collection

1. Start the reviewed dedicated product and Analytics services with their reporting profile.
2. Start Operations and its worker through the existing process manager.

   ```sh
   pnpm reporting:dev preflight operations operations-worker
   pnpm reporting:dev start operations operations-worker
   pnpm reporting:dev status operations operations-worker
   ```

3. Sign in through `http://localhost:3001/login` with an explicitly granted administrator.
4. Enable `OPS_COLLECTION_ENABLED=true` in both Operations profiles and restart those two services.
5. Open **Operations**. Inspect each monitor's last completion and measurement coverage. Distinguish
   missing first heartbeats, unsupported measurements, failed queries, and healthy idle sources.
6. Enable `OPS_EVALUATION_ENABLED=true` only after source coverage is understood. This flag enables
   operational rules; it does not run agent or model evals.
7. Enable `OPS_NOTIFICATIONS_ENABLED=true` after the Growth notification bridge and recipient
   mappings are ready. Leave the incident list available if that bridge is unavailable.

`/health/live` proves the API process responds. `/health/ready` checks required Operations tables.
Neither endpoint proves every product is healthy. `/v1/status` requires an admin session and shows
worker progress and pending notification intent. An API watchdog detects stale collection while
workers are stopped. Use an external uptime monitor before any production rollout.

## Investigate an incident

1. Open the incident and inspect its environment, source, observed condition, evidence freshness,
   rule revision, and prior episode.
2. Acknowledge the incident with a reason. Assign an active operator if needed.
3. Follow its customer or receipt reference into the existing customer workspace. Use only the
   owning product's supported recovery controls, including their confirmations and approvals.
4. Inspect the source-owned receipt before repeating an uncertain command. An incident does not
   authorize another send, booking, payment, model turn, or customer reply.
5. Wait for two fresh healthy observations under the current rule. Unknown or stale evidence
   cannot resolve the incident. Manual resolution requires fresh healthy evidence.

For planned work, create a scoped maintenance window in **Operations settings** with a reason and
end time. Collection continues. Pending delivery waits until expiry; superseded transitions are
suppressed. Notification read state does not acknowledge or resolve the incident.

## Recover monitoring or delivery

1. If collection is stale, inspect managed process identity and worker progress. Confirm the
   dedicated database, fixed source origins, observer keys, and environment values.
2. If a source is HTTP-alive but database-unavailable, inspect `source.read_ready` and the source's
   query coverage. Do not turn unavailable measurements into zero.
3. If delivery is pending, restore Growth and its publisher configuration. Keep the original
   Operations outbox rows and recipient outcomes. Stable per-recipient IDs protect retries after
   lost responses. Current revoked recipients remain suppressed.
4. If source audit is unavailable, keep the successful sources visible. Inspect that destination's
   human assertion configuration and `admin:security` grant. Observer credentials cannot read audit.
5. If identity refresh fails, restore the configured identity provider and sign in again. Do not
   restore an expired cookie or infer owner access from a customer account.

Do not delete active incidents, pending delivery intent, audit rows, or migration ledgers to make
an error disappear. The reference describes the [bounded retention rules](../operations/incident-centre.md#telemetry-and-retention).

## Verify a change

1. Point `OPERATIONS_TEST_DATABASE_URL` at an explicitly named disposable engine test database.
   Set `OPERATIONS_TEST_ENV_FILE` to a separate private identity test profile whose database name
   ends in `identity_test_dev`. Never use the operational database or another product's database.
   Database tests skip when these settings are absent; skipped tests are not verification evidence.
2. Run Operations tests and the affected shared/source tests, then build the changed packages.

   ```sh
   pnpm test:operations
   pnpm build:operations
   pnpm verify:boundaries
   ```

3. For the SDK export test, use `services/operations/tests/telemetry.test.ts`. It sends only bounded
   fixture metrics to a disposable local HTTP receiver. It does not prove a hosted Collector exists.
4. For UI verification, use controlled dedicated development incidents, test recipient mappings,
   and disposable customer fixtures. Inspect permissions, acknowledgement, assignment, maintenance,
   audit pagination, responsive layout, and a stopped Growth dependency.

Model-quality, product-purpose, provider, and load eval execution remains with the owner.
Record actual commands, source revisions, and runtime evidence in the release handoff.

## Disable or roll back

1. Set `OPS_NOTIFICATIONS_ENABLED=false` to stop new delivery attempts. Preserve pending rows.
2. Set `OPS_EVALUATION_ENABLED=false` to stop rule transitions while continuing safe collection.
3. Set `OPS_COLLECTION_ENABLED=false` to stop source polling. Read existing incidents and audit
   through the API while Operations and its database remain available.
4. Restart only the selected managed processes after changing their profiles.
5. Roll back only to binaries compatible with the recorded additive schema and notification
   identity contract. Keep the database for reconciliation. Do not restore Growth-dependent
   authentication as an outage fallback.

No production deployment, external alert transport, or Collector cutover is part of this procedure.
