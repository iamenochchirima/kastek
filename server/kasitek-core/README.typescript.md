# TypeScript migration development

This replacement is in progress. Rust remains the running Growth service until all domains and worker modes pass the migration plan. The TypeScript API currently includes shared login, admin authentication, organizations/invitations, profile/onboarding, bookings/customer details, billing/referrals, notifications/realtime, connections, early access, Social/AI, WhatsApp connections/marketing and Analytics reporting. Other routes and worker modes are still being implemented. Do not deploy it as the complete service.

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

The private Agents workspace reporting service is ported in `src-ts/services/workspace-reporting.ts` and registered at `GET /api/internal/agents/v1/workspace/report`. It retains delegated capability authorization, organization-scoped aggregate queries, distinct contact-list membership counts and exact integer JSON serialization. This does not replace the browser workspace summary. Set `CORE_WORKSPACE_TEST_DATABASE_URL` to run its isolated PostgreSQL check.

Connections includes the workspace projection, status/access routes, provider permission inventory, email OAuth state/credential helpers and social account persistence. The port fixes the original email projection's unquoted `healthStatus` reference to match the database column. Set `CORE_CONNECTIONS_TEST_DATABASE_URL` to run its isolated PostgreSQL check.

Social/AI includes all 46 registered Rust routes, seven OAuth providers, content/media, AI ideas/captions, publishing/deletion, insights and provider callbacks. Bluesky retains encrypted PAR state, signed client authentication, DPoP/nonce handling and endpoint/account validation. Provider behavior has fixture and isolated PostgreSQL coverage. The port fixes an original insights query that built placeholders without binding their parameters. Native Social worker functions are implemented; the migration entrypoint still refuses worker modes until all workers are integrated. Google sign-in's previously deferred live redirect configuration remains separate from these fixtures.

WhatsApp connections includes manual setup, embedded signup, encrypted token replacement, refresh and health checks. Marketing includes contacts/consent/list CSV import/export, templates, campaign lifecycle and a native campaign-worker function. Checks use provider fixtures and isolated schemas. Campaign exclusions now ignore IDs outside the scoped audience, correcting a source query that could attach an unrelated contact. WhatsApp inbox, calling and inbound webhooks remain in progress. Set `CORE_WHATSAPP_TEST_DATABASE_URL` to run these PostgreSQL checks.

The action registry preserves all 19 source definitions and the ordered execution pipeline. Content adapters and batches delegate to the real Social services, with exact policy/schema and outcome checks. The remaining internal bridge and public domain bindings are still being integrated; this library port alone does not make their HTTP routes available. Set `CORE_ACTIONS_TEST_DATABASE_URL` to run the isolated batch checks, and `CORE_SOCIAL_TEST_DATABASE_URL` for Social checks.

Early-access lifecycle routes include application review, approval/batch approval, invitation preview/resend/activation, revocation/restoration and organization status. The service uses the existing billing/credit and organization functions, an atomic invitation claim, and the original process-level activation serialization. Focused checks cover admin permissions, concurrent activation, exact-once credit allocation, revocation, delivery failure/resend and expiry. Set `CORE_EARLY_ACCESS_TEST_DATABASE_URL` to run its isolated PostgreSQL checks. Provider email delivery is verified with a local fixture; no real mail is sent by those checks.

Local package tarballs are ignored; the manifest and lockfile pin their source and artifact checksums. Authenticated private registry delivery is still pending and is required before production cutover. No tokens belong in this repository.
