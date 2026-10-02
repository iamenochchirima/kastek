# TypeScript Core migration runtime

Growth's compiled Node 24 API now runs locally on port 4000 with Rust stopped.
All 537 source business operations and ten dedicated/combined worker modes are
implemented. Rust source remains recoverable until its deletion gate passes.
This is a local migration checkpoint, not a production release.

Use Node 24.15.0 and pnpm 10.30.1. Install the Labs root frozen lockfile, then
prepare the private packages from the pinned source content:

```sh
node scripts/prepare-shared.mjs /path/to/kasitek-labs
pnpm install --frozen-lockfile
pnpm build
KASITEK_DISABLE_BACKGROUND_WORKERS=1 pnpm start
```

The bootstrap loads Core's ignored `.env`. Existing process variables take
precedence. It does not apply Prisma migrations. Never start competing real
workers against the same queues. Worker selection, shutdown, local launchers,
release impact and focused verification commands are documented in
[the native Core guide](../../docs/internal/development/typescript-core.md).

Focused PostgreSQL fixtures require their explicit test database variables and
create/drop synthetic isolated schemas. They do not read customer rows or fall
through to public tables. Local provider fixtures send no real messages,
charges or posts. Consumer checks use compiled Next proxies and, for the Labs
website, actual browser forms and widget assets.

The remaining migration gates include authenticated private-package delivery,
active CI/Railway preparation, later Analytics/Agency/full-stack integration and
Rust retirement. Google redirect configuration and genuine live provider checks
remain owner-deferred. The existing source's unsupported publishing platforms,
missing transcription/UI-interaction Core proxies and ambiguous provider
acknowledgements are recorded separately from migration regressions.
