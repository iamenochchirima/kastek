# Platform 0.2.0 release

Owner: Enoch Chirima. Risk: high. Status: candidate; hosted acceptance pending.

The owner authorized merging the accumulated implementation into `main` and deploying Railway
backends and Vercel frontends. This includes Agents execution, Growth OAuth MCP and equivalent
REST/internal operations, Facebook content management, administration and operations.

## Configuration and data

The destination uses fresh databases, as explicitly selected by the owner. Leave the old Railway
project, databases and production Meta app settings unchanged. Users need new memberships and
provider connections in the destination. Environment exports remain private and uncommitted.

Deploy the merged `main` commit; record its SHA and provider deployment IDs in rollout evidence.
`VERSION` identifies the candidate, not a completed production rollout. Backend packaging lives
in `infra/backend`, the Agents API Dockerfile, `infra/identity/HOSTED.md` and the signed
`infra/agents-runtime/production` profile.

Growth keeps its embedded workers with its persistent media volume; its separate analytics
publisher handles backfill. Other products retain their documented API/worker commands.
Products and Identity use six separate databases. Agents additionally needs private object
storage and durable Restate data. MCP/OAuth discovery uses Growth's public API origin.

Apply Growth's tracked migrations, the fresh Agents schema, Agency startup migrations and the
separate Analytics/Operations migrations to their owning databases. Never restore the retired
Agents schema into the new platform. Configure exact callbacks and independent service keys.

## Validation and observation

The complete application build and import checks passed locally. The Growth API suite passed
147 tests; 92 fixture-dependent checks skipped. Separate focused owned PostgreSQL verification
passed 12 tests without skips, covering access/revocation, transactional analytics and retained
publication identities. New setup targets manifest/policy8 and adapter5.

Real Operations, Agents, Identity and Restate images built successfully. Identity's fresh realm,
execution roles and session revocation grants passed against PostgreSQL. Restate signed discovery,
invocation, unsigned rejection and durable restart replay passed. Four Vercel hosting tests
passed; hosted cookies, streaming, uploads and tenant host forwarding remain acceptance checks.
Local Facebook tests establish manual provider behavior, not hosted agent acceptance.

Reuse registered analytics events and bounded logs. Configure service/environment/release
identity and verify telemetry delivery; hosted retention and alerts remain to be observed.
New deployment-only events and API contracts: not applicable. Current behavior and hosting
requirements remain in the feature map, deployment topology and hosting cutover documentation.

## Rollout and rollback

Merge to `main`, link hosting projects to the monorepo and configure explicit build/start paths,
health checks and environments. Verify database, API, Identity and worker readiness before traffic
cutover. Check hosted OAuth, uploads, tenant isolation and reviewed agent actions.

Keep previous provider source settings, deployment IDs and domain targets for rollback. Restore
matching frontend/backend artifacts without dropping additive schemas, receipts or durable queues.
Disable Growth agent effects/access separately when needed. Never blindly retry an uncertain
provider mutation. Keep old production data untouched.

Post-release review: first working day after cutover; record the actual date, artifact identities,
health outcomes and remaining provider acceptance in rollout evidence.
