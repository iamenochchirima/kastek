# Shared server support

Private Node 24 ESM helpers replacing the generic Labs Rust crate behavior. Product permissions and domain transactions stay in each service.

Exports:

- `./crypto`: SHA-256, URL-safe tokens, AES-256-GCM using the existing SHA-256 secret derivation and `nonce:tag:ciphertext` envelope. Decryption also accepts the existing `nonce:ciphertext+tag` format.
- `./config`: environment values, origin normalization and explicit development loopback checks.
- `./json`: sorted-key canonical JSON and exact large-integer encoding. `serdeFloat` preserves Rust floating-point spelling. `parseCanonicalJson` retains integer versus float representations for hash comparisons. `parseLosslessJson` retains unsafe JSON integers as bigint.
- `./analytics-producer`: event, observation, scope and manifest builders, privacy validation, payload hashes, transaction-owned enqueue, bounded leases, acknowledgement handling, retries, ingestion, reconciliation and deterministic backfill identity.
- `./analytics-reporting`: ES256 120-second reporting grants, internal scope resolution, catalog/query transport and product response scope redaction.
- `./telemetry`: optional OpenTelemetry, resource identity, trace headers, operation metrics and credential redaction. A missing or unavailable Collector does not block application work.

Use `pnpm build:shared` and `pnpm test:shared` from Labs root. Enqueue requires the caller's checked-out transaction connection. Lease updates retain the source SQL and require the current publisher owner. Database schemas and migrations remain service-owned.

## Number and time contracts

JavaScript cannot distinguish integer `1` from floating point `1.0`. Rust Analytics hashes can. Wrap domain values that the Rust implementation constructed as f64 with `serdeFloat`, or parse original JSON with `parseCanonicalJson` when comparing immutable records. Ordinary safe integer inputs stay integers. Large i64s use bigint or exact decimal strings internally, then `canonicalJson` emits unquoted numeric tokens. Do not use ordinary `JSON.stringify` for these records or turn bigint into quoted strings.

Timestamp strings preserve their UTC fractional precision when already valid RFC3339. Date inputs serialize in UTC, omitting `.000` as chrono does. If a source fact stores microsecond precision, pass its timestamp string rather than a JavaScript Date.

## Private delivery

The package scope is `@kasitek-labs`, configured for GitHub Packages. Package manifests point publication at `https://npm.pkg.github.com` and link to this repository; repository `.npmrc` files map that scope. Supply a classic personal access token as the build secret `NODE_AUTH_TOKEN`, then set it in the trusted user-level pnpm config before install with `pnpm config set //npm.pkg.github.com/:_authToken "$NODE_AUTH_TOKEN"`. Do not put the token in a committed project `.npmrc`. Private installs need `read:packages` and package read access; publication needs `write:packages`. The first publish and package access grants still require owner setup; these changes do not publish either package or prove an authenticated install.

For local migration integration, run `pnpm pack:shared <temporary-directory>` from Labs root, then install both tarballs together into the consumer. The command builds compiled exports and writes `manifest.json` with the source Git SHA, a content digest for the actual source files including local edits, and SHA-256/SHA-512 checksums for each tarball. Consumer lockfiles pin these artifacts by integrity. Packing converts the workspace dependency to exact version `0.1.0`. This verifies compiled package exports without permanent sibling-repository paths. Keep tarballs outside source control. Production consumers must pin the version delivered by GitHub Packages, with credentials provided through the host environment; no token belongs in Git.

## Parity evidence

`tests/parity.test.mjs` checks the two existing encryption envelopes and tampering, serde_json numeric/hash fixtures, privacy rejection, deterministic backfill IDs, ES256 scopes/TTL, exact i64 HTTP ingestion and acknowledgement mapping, and disabled telemetry. Source SQL is retained in `src/outbox-sql.ts`. `tests/outbox-postgres.test.mjs` verified enqueue rollback, duplicate/conflict detection, leases, ownership rejection and reconciliation against a temporary table cloned from the actual local Growth schema. It rolls back all fixture work. Set `SHARED_TEST_DATABASE_URL` to rerun it. Service integrations still need reporting authorization checks before retiring Rust consumers.
