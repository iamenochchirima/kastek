# Admin

Central admin UI. It calls Growth Core for Growth operations and the Agency service over HTTP for tenant administration; it has no direct database dependency.

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
