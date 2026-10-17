# Agents local runtime

This local runtime uses Restate server 1.7.13 with SDK 1.17.3. The compose image
includes its verified digest. The development compose environment has no production ingress authentication.
Ingress and administration ports bind to loopback. Worker request identity is
configured separately; the worker must remain private.

## Verify the execution contract

From the repository root, run:

```sh
bash infra/agents-runtime/verify.sh
```

The check requires Docker, Python 3.12 or later, Node 24, and network access to
the npm registry and the Restate image registry. Set `NODE_BINARY` if Node is not
on your path. The script installs two exact SDK artifacts in a temporary directory
and checks their SHA-512 registry integrity values. It does not change workspace
dependencies.

The check starts its own temporary container and worker. It verifies registration,
seven-day workflow and journal retention, duplicate submission identity, worker
restart without repeating a recorded step, and cancellation's terminal outcome.
It removes its container, worker, and temporary files afterward. Its JSON output
identifies the versions and results.

This deterministic fixture verifies the runtime contract. It does not verify the
FAQ journey, model calls, PostgreSQL admission, permissions, or provider effects.

## Run Restate for local application development

```sh
docker compose -f infra/agents-runtime/compose.yaml up -d
```

The ingress URL is `http://127.0.0.1:18080`. The admin URL is
`http://127.0.0.1:19070`. The named volume retains journal data across container
restarts. Stop this local runtime with:

```sh
docker compose -f infra/agents-runtime/compose.yaml down
```

The standalone verification script uses separate containers and ports. It does
not use or modify this compose environment.

The worker defaults to `RESTATE_WORKER_HOST=127.0.0.1`. A Dockerized Restate server
cannot reach that host loopback through `host.docker.internal`. For a private
Docker development bridge without request signing, set these worker variables:

```sh
RESTATE_WORKER_HOST=0.0.0.0
AGENTS_ALLOW_UNSIGNED_WORKER=1
```

Apply host firewall restrictions to that development listener. Production never
accepts this unsigned override and requires `RESTATE_REQUEST_IDENTITY_KEYS` from
the configured cluster. Keys use the SDK's `publickeyv1_` format and may be
comma-separated during rotation. Signing does not replace private worker access,
TLS, or ingress authorization.

The standalone SDK check uses real HTTP2 requests and temporary Ed25519 keys:

```sh
pnpm --filter @kasitek/agents exec vitest run test/platform-worker-security.test.ts
```

It proves valid-signature discovery and denial of unsigned, forged, expired, and
wrong-path requests, including invocation paths. It does not verify a deployed
cluster's signing configuration or key distribution.

## Application contract

Commit the accepted task and outbox command in one PostgreSQL transaction. Send
the workflow with the stable task ID as its workflow key. Workflow run handlers
reject an `Idempotency-Key` header because their workflow key already identifies
the execution. Service handlers require an explicit idempotency key instead.

Persist the returned invocation ID. Reconnect and cancellation use this same
invocation. A successful cancellation request is not confirmation of termination.
Stop dispatching settled tasks, and bound outbox retries within configured runtime
retention. After retention expires, the same key can start another execution.

The business harness records each model, tool, and compaction operation through
its own durable boundary. Conversation history, selected knowledge, approved
personal memory, and pinned skills form a bounded context snapshot. The minimal
website FAQ uses that same controller with its optional capabilities disabled.

Record database and provider operations through `ctx.run`. Database writes also
need stable operation identities. An external operation may finish before Restate
records its response, so execution durability does not prove exactly-once effects.

Root admission reserves up to 32,000 accounted tokens against the organization's
100,000-token UTC admission-day allowance. Business children subdivide that allocation. Model
and compaction calls across the tree consume operation reservations under the same root; later
midnight crossings do not create a new allowance. Private PostgreSQL stores
context snapshots and memory revisions. S3-compatible storage holds large
artifacts under scoped metadata. See the [implementation boundary](../../products/agents/docs/source-boundary.md)
for the complete current profile and capability limits.

Use immutable worker endpoints for releases. Replacing worker code at an existing
endpoint can break journal replay. Keep the Restate admin API private.

References: [HTTP invocation](https://docs.restate.dev/services/invocation/http),
[durable steps](https://docs.restate.dev/develop/ts/durable-steps),
[cancellation](https://docs.restate.dev/services/invocation/managing-invocations),
[versioning](https://docs.restate.dev/services/versioning).

## Report and automation recovery

Worker registration discovers `AgentsBusinessRunV3` and `AgentsAutomationV1`.
Use a fresh dedicated development database after schema changes; setup rejects
an incompatible checksum. Keep immutable worker endpoints for journal replay.
Do not point old journals at changed workflow/descriptor code.

A timer outbox starts one Restate workflow per immutable automation revision.
Its durable sleeps survive worker restarts. New revisions fence old timers and
start at future schedule instants. Continuous-revision downtime coalesces missed
intervals; it does not queue every missed run. The occurrence inbox, quota,
grants, tasks and task outbox commit together. Review waits remain active roots
but hold neither compute capacity nor a sandbox allocation.

For a stuck run, inspect its occurrence status/error, task events and action
state. `blocked` identifies admission permission/quota errors; `skipped_overlap`
means an earlier occurrence still owns the automation slot. Renew finite owner
authorization explicitly when expired. Pause changes future admission only;
revoke blocks new claims and requests cancellation of accepted work.

An approved action with no dispatch claim can still be invalidated by connection
rotation, expiry, source deletion or authority changes. A claimed/uncertain action
uses only scoped status GETs. Inspect the receiver's receipt by the original action
ID. Never delete the action record, manually replay its POST or claim a rollback
of an accepted report. If the receiver never accepted it, the task can remain
uncertain rather than resend. Retain action/receiver identities at least eight
days after terminal settlement; current stores do not automatically delete them.

Losing an encryption key can make pending dispatch and receipt inspection
unavailable. Retain old key IDs during deliberate key rotation and verify status
inspection before retiring them. Stop future writes with automation/connection
revocation while preserving reconciliation credentials and durable receipts.
Disabling all workers also stops reconciliation and is not a completed rollback.

## Verify identity

```sh
bash infra/agents-runtime/verify-identity.sh
```

This check requires Docker, Node 24, Playwright and Chrome. Set `NODE_BINARY`,
`AGENTS_PLAYWRIGHT_MODULE` or `AGENTS_BROWSER_EXECUTABLE` when those tools are not
in their normal locations. It starts disposable Keycloak 26.6.0 and PostgreSQL
containers, creates private fixture credentials, and cleans its resources. It does
not use or modify the shared development realm.

The real provider check covers PKCE login, invalid state/nonce/verifier denial,
opaque product sessions, signed backchannel logout, replay and malformed-token
denial. The execution-service token must have the exclusive intended audience and
execute role without realm-management authority. Signup-email delivery and
production identity deployment are outside this check.

## Verify private content and memory

From the repository root, with workspace dependencies installed:

```sh
bash infra/agents-runtime/verify-storage.sh
```

This check uses real PostgreSQL 17.6 and MinIO. It verifies scoped revisioned
memory, explicit candidate acceptance, correction, forgetting and expiry,
immutable skill revisions, signed private object writes/reads/deletion,
content integrity, lost-response recovery and cleanup when deletion races a write.
It does not use a filesystem replacement or a simulated S3 service.

The script builds MinIO from the official `RELEASE.2025-09-07T16-13-09Z` source
archive using Go 1.26.9. Archive SHA-256 values are:

- MinIO source: `c9598dcce3440977e79f787f2ba0e7e4d92c8d556bd51e7cef3785bafd6635f3`.
- Go Linux amd64: `42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d`.

Docker Hub and Quay image access and the MinIO binary archive were unavailable
when this check was introduced. The checked source build avoids requiring those
artifacts. It downloads Go modules and checks their normal module checksums.
This source-build path currently supports Linux amd64 and Python 3.12 or later.

Set `NODE_BINARY` when Node 24 is outside `PATH`. Optionally set
`AGENTS_TEST_MINIO_BINARY` to an existing MinIO executable or
`AGENTS_TEST_DATABASE_URL` to a disposable PostgreSQL server with database-creation
rights. The script owns and removes its temporary server/data and any PostgreSQL
container it starts. The tests create and drop their own databases.

Application storage uses `AGENTS_S3_ENDPOINT`, `AGENTS_S3_REGION`,
`AGENTS_S3_BUCKET`, `AGENTS_S3_ACCESS_KEY_ID` and `AGENTS_S3_SECRET_ACCESS_KEY`.
Provision a private bucket separately. Missing storage remains unavailable; no
local content fallback is enabled. Configure HTTPS outside loopback development.
Credentials stay outside model context, ordinary history and logs.

Forgetting and source-history deletion prevent future retrieval and invalidate
derived context. They do not claim physical erasure of historical revisions,
completed provider requests, runtime journals or backups. Retention and production
secret storage remain explicit release concerns.

## Temporary isolated analysis

The optional local backend pins gVisor release 20261012.0 and Python 3.12.12 by
image digest. It uses direct rootless OCI execution inside a transient systemd
user service. Docker is used to extract the pinned image; generated code is not
run through Docker's ordinary runtime.

```sh
bash infra/agents-runtime/prepare-sandbox.sh
bash infra/agents-runtime/verify-sandbox.sh
```

The check uses actual disposable PostgreSQL and the local isolation backend. It
requires Linux x86_64, user namespaces and a systemd user manager with delegated
CPU/memory/process limits. Missing required enforcement blocks execution.

Configure private S3 storage, set `AGENTS_SANDBOX_ENABLED=1`, and start the
independent reaper from `products/agents/api`:

```sh
pnpm dev:sandbox-reaper
```

For compiled services use `pnpm start:sandbox-reaper`. The reaper and worker must
share the private allocation directory and dedicated Agents database. The API
and worker require the same pinned runtime paths. Path overrides are documented
in the environment example. Start cleanup before enabling analysis admission.

The profile allows one CPU, 512 MiB RAM, no swap, 64 host tasks, guest process
limits and 256 MiB scratch. Commands last at most 120 seconds. Allocation leases
last at most ten minutes and cannot exceed the root deadline. One sandbox per
root and two per organization are permitted. Up to 32 input files/4 MiB are
staged read-only. Export permits four text/Markdown/JSON artifacts, each at most
1 MiB and 4 MiB total. Diagnostic output is capped at 64 KiB; model-facing
excerpts are smaller. Network, dependency downloads and credential injection are
disabled. Code writes export files under `OUTPUT_DIR`.

After worker loss, the adapter attaches to the original resource or reads its
receipt. Unknown commands are not repeated. Required artifacts are published
before normal destruction; durable export references support replay afterward.
The independent reaper stops expired or cancelled allocations. Cleanup failure
remains visible and is retried; stopping new admission must not stop the reaper
or discard receipts. Production isolation, capacity and operational certification
remain separately verified deployment gates.
