# Agents threat model

This reference covers the standalone Agents API, worker, dedicated database,
website widget, identity provider, and model boundary. It does not certify a
production deployment. See the [implementation boundary](source-boundary.md).

## Enforced boundaries

- OIDC uses the independent Agents client, authorization code flow, PKCE, state,
  nonce, verified claims, and a one-use login transaction. Accounts use issuer and
  subject identity. Matching email addresses do not merge accounts.
- Product sessions use opaque random cookies and stored token hashes. Membership,
  resource scope, expiry, and revocation determine product access.
- Website admission binds the deployment, origin, visitor session, immutable
  version, and approved public knowledge. Private sources cannot be published to
  website visitors. Browser mutation endpoints enforce their origin boundary.
- Execution grants bind the calling product, organization, resource, principal,
  version, permitted operations, knowledge, limits, and expiry. The model effect
  rechecks live grants and current standalone membership or deployment authority.
- Disabled capabilities are enforced by configuration and runtime validation.
  The FAQ cannot request business actions, subagents, or sandbox access.
- The model receives bounded instructions, question text, and approved retrieval
  excerpts. Retrieved content is reference data. Provider keys stay in the worker
  environment and are excluded from browser responses and ordinary logs.
- Atomic task admission and stable operation identities limit duplicate work.
  Interrupted external effects remain uncertain instead of being blindly repeated.
  Daily reservations, concurrency limits, input limits, timeouts, and output bounds
  restrict resource use.

## Operational limits

The local Restate ingress and admin ports bind to loopback. Worker access must
remain private. The development setup does not configure production request
signatures, ingress authentication, TLS, secret rotation, or network policy.
Never expose its admin API or worker endpoint publicly.

The startup schema command requires a fresh dedicated database. Runtime credentials
must remain separate from other products. Production database roles, backups,
retention, disaster recovery, and monitoring need deployment verification.

Cancellation does not prove an in-flight provider stopped. Restate journals cannot
make a provider effect exactly once. An uncertain model operation consumes its
reservation conservatively; confirmed completion and failure remain distinct.

Structured stdout uses bounded lifecycle errors. OTLP export, durable log retention,
redaction inspection in a deployed environment, alerts and signup-email delivery remain
release work. Local browser identity and real free-model acceptance pass separately.
Production rollout and rollback are not authorized or verified by local tests.
