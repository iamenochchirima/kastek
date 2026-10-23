# Customer operations

Owner: Platform engineering. Reviewed: 2026-10-23.

The Labs admin provides `/customers` and `/customers/:product/:customerId` for current
Growth, Agents and Agency account investigation. Reporting links open this workspace;
the workspace links back to the selected product's reports. Products own their queries,
permissions, schemas and transitions. The admin BFF uses HTTP and never joins their databases.

## Access and configuration

Metadata requires `admin:read`; previews and commands require `admin:operate` at both
the BFF and owning service. Viewers, support and security roles cannot issue these commands.
Growth validates the opaque admin session. Agents and Agency validate destination, actor,
capability, method, exact path/query and raw-body digest in a short-lived signed assertion.
Nonce rejection prevents assertion replay. Durable operation IDs separately prevent duplicate effects.

Customer operations are available only in explicit development or test environments.
Set `NODE_ENV=development` or `test` on product APIs and `KASITEK_ENVIRONMENT=development`
on the admin. The latter describes deployment scope separately from Next's production-build
`NODE_ENV`. A production deployment environment disables this feature.

Set these flags independently on the admin and each owning service:

```dotenv
KASITEK_CUSTOMER_OPERATIONS=1
KASITEK_CUSTOMER_ACTIONS=
```

An empty action list permits metadata and receipt inspection. Add only the actions required
for that service to the comma-separated `KASITEK_CUSTOMER_ACTIONS` value:

| Service | Action | Outcome |
| --- | --- | --- |
| Growth | `webhook.replay` | Requests replay of one failed outgoing webhook; requester records the first approval. |
| Growth | `webhook.replay.approve` | A distinct operator approves; preconditions are rechecked and delivery is queued. Queued is pending, not delivered. |
| Agents | `task.cancel` | Records cancellation intent for an active root and direct children. Runtime owns stopping, usage settlement and cleanup. |
| Agents | `ingress.retry` | Requeues selected quarantined ingress on an active connection/deployment through existing duplicate prevention. |
| Agency | `client.suspend`, `client.resume` | Atomically changes active/suspended client state and records lifecycle outbox and audit evidence. Archived clients are excluded. |

Normal collection pages default to 50 and cap at 100. Cursors preserve the owning collection's
ordering; deployment cursors include the source kind to distinguish equal IDs across tables.
An ingress command selects between 1 and 100 records. These are interface bounds, not capacity claims.

## Account facts and relationships

Each section identifies its source and observation time. Unsupported facts differ from unavailable
queries and empty results. Numeric balances and usage retain exact decimal strings.

Growth exposes its own subscription, effective entitlement, configured limit and enforcement facts.
Credit reads preserve stored balances, reservations, grants and ledger without expiring grants or
creating accounts. Expired but unprocessed grant amounts remain explicitly identified. Agency
exposes recorded monthly usage and configured limits; enforcement and commercial entitlements
remain unsupported where no authoritative implementation exists. An Agents token allowance
describes execution admission, not a paid subscription.

Cross-product links come only from verified Agents `product_execution_tenants` records with
issuer and client identity. A revoked mapping is inspectable but cannot authorize new recovery.
Email, name, equal IDs and Agency `external_ref` never create a link. Missing integration and
unavailable mapping lookup stay explicit. Evaluation tasks and website/messaging fixtures are
excluded from customer recovery and metadata projections.

Metadata does not include instructions, prompts, message bodies, credentials or provider payloads.
Existing Growth content inspection still requires its scoped, reasoned support grant, lasting at
most 60 minutes. Grant changes and access audits are transactional. These grants confer no
Agents or Agency content access. New controls do not expose customer replies, impersonation,
tool approvals, arbitrary reruns, financial adjustments or credential revocation.

## Receipts and uncertainty

Every command binds its ID to actor, product, customer, action, target, reason and expected state.
Identical requests return their recorded outcome. Conflicting reuse fails. State transitions and
required audit/outbox intent commit together in the owning product. There is no distributed transaction.

The admin keeps the submitted command in that browser tab's session storage until its receipt
can be read. An unresolved response blocks new commands. **Retry same request** preserves the
original ID and body. **Check outcome** reads the authoritative receipt. A previous operation's
result cannot establish a later operation's outcome.

Receipts distinguish awaiting approval, pending, confirmed, rejected, failed and unknown.
Receipt reconciliation may update administrative receipt state; overview reads do not change
business state. Growth freezes a terminal delivery outcome so a later delivery cycle cannot rewrite
an earlier receipt. Unknown outbound sends are never resent through these controls.

## Observe and recover

The customer workspace exposes source failures and bounded operation histories. Inspect a receipt
by its exact customer and operation ID. Preserve the original ID after timeout; do not create a new
command to bypass uncertainty. For pending cancellation, inspect runtime dispatch, task disposition,
usage settlement and sandbox cleanup. For ingress, inspect selected record state and connection
health. For Growth, inspect approvals and actual webhook delivery, not only the command queue.

Use owning-service structured operation logs and persisted receipt/audit records for request,
rejection, conflict and final outcome counts. Monitor pending age from `created_at`/`createdAt`
against the current receipt status. During development, review pending operations older than
15 minutes; this is an investigation threshold, not an automatic cancellation or retry rule.
Re-quarantined ingress and unknown effects require investigation. The admin history is the
development operations view; no external paging integration or production monitoring claim is made.

Do not log reasons, request bodies, assertions or customer content in general telemetry. Receipt
storage contains the required reason under admin authorization. Development receipt/audit records
are retained without automatic deletion until the owner resets the dedicated fixture database.
Production retention and alert routing require separate decisions before enabling production access.

## Development verification

Use the dedicated services described in [Administrative reporting](admin-reporting.md).
Apply the owning migrations before new API binaries:

- Growth: `20261023130000_admin_customer_operations`; record its checksum in Prisma's ledger.
- Agency: `20261023190000_admin_customer_operations.sql`, through the SQLx-compatible migration runner.
- Agents: `069_admin_customers.sql`, through `setupPlatformSchema` and its checksum-verified additive upgrade.

Run focused suites in each product's existing test runner. Agents tests create/drop a disposable
database; Growth and Agency tests use isolated schemas. Never point them at customer databases.
The shared suite is `packages/server-support/tests/admin-customers.test.mjs`.

After building and starting the dedicated services, run:

```sh
node scripts/customer-operations-smoke.mjs
```

This reads the private, ignored reporting acceptance fixture and verifies actual metadata, BFF
authorization and responsive rendering. It writes safe evidence under
`/tmp/kasitek-customer-operations-proof`. It does not print credentials.

The optional controlled lost-response journey changes only the dedicated Agency fixture client
and restores its initial state:

```sh
KASITEK_CUSTOMER_OPS_EXERCISE_FIXTURE=1 node scripts/customer-operations-smoke.mjs
```

Model quality, purpose-specific and load eval execution remains with the owner. This verification
does not invoke models, bookings, payments, real webhooks or customer communications.

## Release and rollback

This is a high-risk development feature affecting privileged admin, the three APIs, shared
contracts and product-owned audit/receipt storage. Record the actual implementation commit SHAs,
artifact/configuration revisions and migration checksums in the release evidence. `VERSION=0.1.0`
alone does not identify a deployed release. No release tag or production deployment is created here.

Enable metadata before actions. To stop new work, empty the action list and restart the affected
admin/API processes. Keep metadata enabled to inspect receipts; admitted work still settles normally.
Do not delete receipts, audit rows or outbox records. The additive schema can remain while code
rolls back to a compatible binary. Growth's replay queries require the new columns, so an older
database cannot run the new API binary.

No new Analytics event names or Collector/exporter configuration are introduced. Agency client
status changes retain their existing product analytics/outbox behavior. Administrative outcome
measurement uses the durable operation records and existing structured logging. Public customer
documentation and production communication are not applicable to this development-only admin change.
The owner schedules post-release review if a production rollout is separately approved.
