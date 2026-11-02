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

Worker registration discovers `AgentsBusinessRunV15`, `AgentsAutomationV1` and, when configured, `AgentsKnowledgeImportV1`.
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

### Reviewed package scripts

A tool-directed version with selected reviewed skills and `sandbox.analyze` exposes `skills.run`.
The required grant operations are `skill.read`, `sandbox.execute`, `artifact.read` and `artifact.write`.
Activate the pinned skill instructions before execution. Reading script source into model context
is optional. Only reviewed Python entries under `scripts/` are supported, with a 16 KiB entry limit.
The complete package is mounted read-only under `/input/skill`; packaged helpers and resources are
available from the package root and selected entry directory. Execution uses a fixed Python
`-I -S -B -c` wrapper with validated paths passed as arguments. It adds no host paths or site packages.
Package files and artifact inputs share the existing 32-file/4 MiB bound. `INPUT_DIR` contains the
authorized artifact inputs and `OUTPUT_DIR` contains export files. `SKILL_DIR` identifies the package.

The original admitted resource operation bounds time and root usage. Immutable schema038 provenance
records the selected revision, package/script digests and relative path. Artifact evidence retains
the package dependency. Current authority checks block withdrawn installations before launch and
before artifact publication or reuse. Finalization and the existing independent reaper retain
resource cleanup. Installation never executes code. Other languages, external dependencies,
credential injection and network access remain unavailable.

The actual isolated check requires disposable database creation and the prepared sandbox:

```sh
AGENTS_SANDBOX_VERIFY=1 pnpm --filter @kasitek/agents exec vitest run test/skill-script-runtime.test.ts test/platform-sandbox.test.ts test/platform-business.test.ts
```

## Calendar booking runtime

The current source uses `AgentsBusinessRunV15` with `modular-programs-v5` and fresh schema
through `038_skill_script_runtime.sql`. Keep each tested worker artifact and database separate from
older local releases. Setup checks the complete SQL digest and does not migrate an owner database.

The Google connector requires `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`,
`GOOGLE_CALENDAR_CALLBACK_URL`, and the encrypted `AGENTS_CONNECTION_KEYS` keyring with
`AGENTS_CONNECTION_ACTIVE_KEY`. The callback must be `/api/google-calendar/callback` on the
configured application origin. Production requires HTTPS. API and worker processes need matching
provider configuration and key access. Missing configuration keeps the provider unavailable.
Never place credentials in a command argument, model context, browser state, or verification output.

A booking proposal waits durably without a provider insertion or held execution slot. Exact customer
confirmation resumes the accepted invocation. Current policy and channel ownership still fence the
send. Claimed or uncertain appointments expose **Check status** through scoped management or public
routes. That route performs only a provider GET under a lease; it cannot create another event.
An active insertion claim returns `BOOKING_IN_PROGRESS` rather than taking over the operation.

`test/booking-business.test.ts` starts its own database, Restate container, API, provider fixture,
and independent worker processes. With `AGENTS_TEST_DATABASE_URL` configured for disposable
DB creation, run from the repository root:

```sh
pnpm --filter @kasitek/agents exec vitest run test/booking-business.test.ts test/booking-workflow.test.ts test/google-calendar.test.ts test/google-calendar-connections.test.ts
```

The acceptance kills and restarts its own worker, preserves the accepted invocation, checks one
provider insertion after exact visitor confirmation, and verifies takeover fences and GET-only
uncertain recovery. Google OAuth/token exchange in that journey is controlled fixture behavior.
Separate signed-OIDC tests verify claim validation against a local issuer. Neither is live Google
OAuth acceptance. See the [release record](../../products/agents/docs/source-boundary.md#catalogue-and-booking-release-record)
for rollout limits, observations, and disable procedures.

## Knowledge and connected-read recovery

`AgentsBusinessRunV15` uses harness release `modular-programs-v5`.
Each operation journals its physical outcome before a separate durable step writes
the native receipt. Receipt retries reuse that outcome without repeating provider
requests. A crash before the outcome is journaled remains uncertain.
The outbox submits roots; the parent workflow submits specialists. The outbox
never submits an ordinary child again. Root retries resolve the accepted workflow
through `/restate/lookup` before recording its invocation identity. Ordered turns
attach to that identity rather than resubmitting a predecessor. A terminal conflict
is uncertain unless the runtime explicitly reports cancellation. The pinned Restate
workflow API rejects a caller-supplied idempotency key on `run`; use workflow
identity and canonical lookup rather than adding that header.
`AgentsKnowledgeImportV1` coordinates owner imports separately from task roots.
Fresh schema bootstrap pins all ordered SQL files through `038_skill_script_runtime.sql`; this product does not migrate
an earlier Agents database. Keep the old database separate when testing a new
schema release.

Prepare document processing after the gVisor runtime:

```sh
bash infra/agents-runtime/document-prepare.sh
```

The preparation step downloads pinned build artifacts and verifies their hashes.
The execution profile has no network. Its manifest binds the Docker image ID,
canonical rootfs export, Node hash, package lock, model revision and complete
gVisor bundle. Digest-specific paths preserve previously accepted profiles.
Repreparing the same inputs produces the same profile identity. Do not edit a
cached release or retarget its artifact paths to newer files.

Enable `AGENTS_DOCUMENT_RUNTIME_ENABLED=1` and configure the private S3 adapter.
Run the independent physical reaper even if the business worker is unavailable:

```sh
pnpm --filter @kasitek/agents start:document-reaper
pnpm --filter @kasitek/agents start:source-object-reaper
```

The worker also starts separate cleanup lanes. Physical document/query cleanup
requires the database and accepted local runtime; it does not require S3 or model
credentials. The object lane requires S3 and retries deletion tombstones. A stale
allocation retains capacity until physical destruction is confirmed. Do not
release a slot by editing its database state alone.

Import recovery uses the original revision, stage and allocation identities.
Unknown URL acquisition is not silently fetched again. Interrupted object PUTs
retain ownership before any bytes are sent. Sealed active raw/text objects remain
private; stage receipts have seven days plus a fifteen-minute cleanup allowance.
Withdrawal blocks new consumption before retained bytes are deleted.

Connected reads persist every physical-attempt claim before sending. A complete
receipt replays without rediscovery; an orphan started claim stays uncertain.
API and worker executable manifests must match, including TypeScript versus
compiled mode. Use matching compiled artifacts for acceptance and production.
Stop new connections/publication independently of receipt inspection. Never repair
a missing receipt by repeating an uncertain send or changing an accepted binding.

Diagnostics expose bounded job/error/state and provider attempt/byte/timing data.
They exclude credentials, source bodies, prompts and raw private URLs. Production
retention, alerting, capacity and key custody remain deployment work. No analytics
exporter or provider billing system is added by this feature.

## Hosted private runtime

The separate [production packaging](production/README.md) pins the same server image and requires
outbound request signing, a persistent volume and private listeners. It does not modify the
unsigned loopback-only local compose profile or grant permission to expose Restate publicly.
