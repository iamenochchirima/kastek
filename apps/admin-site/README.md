# Admin

Central admin UI. It calls Growth, Agents, and Agency over HTTP for scoped reporting, and retains Growth commercial operations and Agency administration. It has no direct product database dependency.

Copy `.env.example` to `.env.local`, then run:

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm build
```

This app has its own lockfile and is excluded from the Labs root workspace. The `--ignore-workspace`
flag makes pnpm install this app's dependencies instead of treating it as an unlisted workspace
package.

Set `OUTREACH_DRAFTS_DIR` only when draft files are stored outside the default
`local-work/outreach-emails/organized/categories` directory under the repository root.

To verify SMTP settings, set `SMTP_*` values in `.env.local` and run `pnpm test:smtp` from this
directory. Add `-- --to=address@example.com` to send a test message.

The conversations pages read from Core's `/api/admin/conversations` routes. The old `/api/conversations/messages` handler had no caller in this repository and wrote directly through Growth's Prisma package, so it was removed during the move.

Git deployments remain disabled in `vercel.json` until hosting cutover is handled separately.

Core proxy requests forward the browser cancellation signal, including activity
streams. Quotation PDF downloads map Core's snake_case quotation record into
the existing renderer's draft fields. Invoice records use Core's camelCase
response and go directly to the existing invoice renderer.


Operations now exposes Growth webhook recovery and support grants only. Old Agents runtime
operator panels, projections and installation commands are removed. The old health, data-quality
and audit page links redirect to Operations. Shared execution monitoring belongs to Agents.

## Admin route and list behavior

Analytics is the primary reporting entry. `/dashboard` remains a redirect without a second
navigation item. Outreach campaigns, drafts and delivery history stay grouped separately from
Operations and Commercial. Operations contains Growth webhook recovery and support grants;
retired Agents operator panels remain removed.

Growth organization links open `/organizations?q=<id>`. This searches the existing Growth
organization lookup and shows at most 25 matches. Agency workspace identifiers are separate.

Web services, outreach campaign leads and delivery history filter and page in Growth SQL.
List callers request `paginate=true&page=1&limit=50` for `{ items, total, page, limit }`.
Delivery list metadata also includes `sent` and `failed` matching the full filter. Normal pages
are capped at 200 records; CSV exports are capped at 20,000 attempts and labelled accordingly.
The bounded array response remains available to existing list callers without `paginate=true`.
Campaign and Web service summary cards explicitly describe the current page where appropriate.

Page read failures render an error with Retry, including failed catalogue reads. Billing editing
controls do not mount until the authoritative catalogue loads. Route transitions show a skeleton.
The unsupported Web services Delete All control and collection DELETE proxy are removed. Bulk
lead actions retain failed selections; field and add-lead forms retain input and show errors.
SMTP acceptance is distinct from confirmed delivery.

## Commercial workflow safety

Set `OUTREACH_DRAFTS_DIR` to a readable draft directory. Discovery is recursive;
preview and import accept the same snake_case and camelCase fields. Missing configuration
and invalid files are errors, not empty successful imports. Import reports per-record failures.

Outreach submission claims a durable attempt in Growth before SMTP. `accepted` means SMTP
accepted the recipient; it does not mean delivery. Partial rejection is retained per recipient.
Transport ambiguity or a database failure after SMTP leaves the attempt blocked. Open **Send
attempts** on the lead, verify the provider evidence, then record the outcome. Retry is available
only after confirmed non-submission or rejection. Never resolve uncertainty based only on a
client timeout. Preserve accepted recipients when reconciling a partial outcome.

Invoice GET requests only read records. **Update cycle** explicitly materializes the current
invoice's recurring cycle and reminder notifications. Saving an invoice also updates its cycle.
Recording sent/reminded/paid is manual bookkeeping; these buttons do not send email.
All invoice mutations and send reconciliation record the authenticated administrator.

Apply migration `20261023095000_admin_commercial_safety` before enabling these routes.
The migration adds the send-attempt and commercial-audit tables; it preserves existing records.
Rollback disables SMTP submission and invoice mutation controls before reverting application code;
keep attempt/audit rows for reconciliation. No database migration or provider submission is part
of development verification.

Focused checks (mocked SMTP and an isolated disposable PostgreSQL database only):

```sh
CORE_COMMERCIAL_TEST_DATABASE_URL=postgres://... products/growth/api/node_modules/.bin/tsx --test products/growth/api/tests/admin-commercial.test.ts
products/growth/api/node_modules/.bin/tsx --test apps/admin-site/scripts/admin-commercial.test.ts
```

The SQL tests create and remove their own random schema. Do not point them at a customer database.

## Cross-product reporting

The Analytics routes use one shared reporting view:

- `/analytics`: product overview.
- `/analytics/customers`: customers and access.
- `/analytics/adoption`: recorded adoption.
- `/analytics/usage`: usage and model cost.
- `/analytics/revenue`: invoiced, paid, refunded and outstanding coverage.
- `/analytics/reliability`: failures, backlog, delivery and intervention coverage.

Product, product-owned organization/workspace ID, UTC start and exclusive end, reporting timezone,
and record page are retained in the URL. Choose a product before applying an organization ID.
Growth or Agency scopes also expose Agents execution attributed to that consumer, without
adding those execution costs to another product total. Product metrics remain separate.

Each source shows its availability, latest observed source record and completeness checkpoint.
Unknown checkpoints remain Unknown. Unsupported, stale, partial and unavailable values retain
their source state and reason; unavailable values do not display zero. Current-state metrics are
labelled Current. Metric definitions and paginated safe source records are available through
native disclosures; monetary values preserve their source currency and exact integer precision.
Source records identify their kind and are not a claim that every metric has a matching detail row.
Customer records show their product-owned organization/workspace name and ID. Selecting one
keeps the current period and timezone and applies that product and organization scope.
Event projection trends remain separate from authoritative totals. Each series retains its domain,
source, availability, scope coverage and completeness checkpoint. Gaps remain unknown. Exact bucket
values remain available in a table; values beyond the JavaScript safe integer range do not render
a rounded chart. There is no cross-product unique-user total.

Export CSV posts to the audited reporting export route with the same scope and domain as the
screen. Only sessions with `admin:export` see the action. Saving requires `admin:write` and stores
a private versioned cross-product definition through the existing Reports API. Reports can reopen
that scope or request the same bounded export. The server independently rechecks permissions.

Focused UI regressions are in `tests/admin-report-format.test.ts`. Run them with the workspace
TypeScript loader, then typecheck and lint the app. Browser acceptance must exercise all six
routes at desktop, tablet and mobile widths, a source outage, filter/pagination preservation,
private save/open, CSV export and viewer permissions. Model evals and live provider acceptance
remain owner-run.

The [reporting operations reference](../../docs/operations/admin-reporting.md) records source
coverage, authorization, server-only configuration, per-owner migrations, runtime grants, and
rollback. Activation, previous-period comparisons, refund facts, and cross-product unique people
are unavailable where no authoritative measurement exists. Global trend coverage describes
instrumented scopes rather than every current organization.
