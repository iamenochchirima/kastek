# Client database migration baseline

The repository now carries the historical client-schema baseline that predates the
first incremental Prisma migration. Migration
`20260301000000_initial_client_schema` was generated from the schema at
`f964059^`, the supported pre-organisation client schema. The incremental
migrations beginning at `20260326143000_add_whatsapp_contact_list_memberships`
then apply the contact-list, campaign, push, calling, organisation, billing,
inbox, social, public API, and admin changes in order.

## Verification

On 2026-08-14, all 50 Prisma migrations were applied to a newly-created local
PostgreSQL database with:

```text
DIRECT_URL=<disposable-local-url> DATABASE_URL=<disposable-local-url> \
  pnpm --dir client/packages/database exec prisma migrate deploy
```

The command completed successfully, including the baseline and every current
incremental migration. The disposable database was removed after the check.

Existing databases that predate this committed baseline already contain the
baseline tables. Before their first deploy after this change, an operator must
review the migration status and resolve the baseline as applied once:

```text
pnpm --dir client/packages/database exec prisma migrate resolve \
  --applied 20260301000000_initial_client_schema
```

That resolve operation is intentionally a deployment step, not an automatic
application migration: it records the existing schema history without recreating
tables or touching customer data. It must only be run after the target schema is
confirmed to match the historical baseline and a backup is available.

The clean-database result proves the repository migration chain is provisionable;
it does not replace seeded core fixtures, Redis recovery, provider sandbox, or
hosted/browser verification.
