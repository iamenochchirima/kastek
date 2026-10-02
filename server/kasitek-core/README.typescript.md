# TypeScript migration development

This replacement is in progress. Rust remains the running Growth service until all domains and worker modes pass the migration plan. The TypeScript API currently includes shared login, admin authentication, organizations/invitations, profile/onboarding, bookings/customer details, billing/referrals, notifications/realtime and Analytics reporting. Other routes and worker modes are still being implemented. Do not deploy it as the complete service.

Use Node 24 and pnpm 10.30.1. Install Labs' root frozen lockfile, then prepare its compiled private packages from the pinned source content:

```sh
node scripts/prepare-shared.mjs /path/to/kasitek-labs
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
PORT=4900 KASITEK_DISABLE_BACKGROUND_WORKERS=1 pnpm start
```

The native comparison API uses the existing ignored `.env` and database, while Rust remains on port 4000. Workers cannot start in this migration entrypoint yet. Never run two effect-producing implementations against the same queues. Stop the comparison process with Ctrl+C.

`pnpm test` runs focused checks. PostgreSQL tests run only when their explicit test database environment variables are set; each creates and removes its own schema. They must use a schema-only search path to prevent falling through to live tables. The private Keycloak integration probe and its account fixture remain outside Git in `.audit/`.

Local package tarballs are ignored; the manifest and lockfile pin their source and artifact checksums. Authenticated private registry delivery is still pending and is required before production cutover. No tokens belong in this repository.
