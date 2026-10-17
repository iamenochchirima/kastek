# Agents local runtime

This local runtime uses Restate server 1.7.13 with SDK 1.17.3. The compose image
includes its verified digest. It has no production authentication configuration.
Ingress and administration ports bind to loopback. The worker must remain private.

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

## Application contract

Commit the accepted task and outbox command in one PostgreSQL transaction. Send
the workflow with the stable task ID as its workflow key. Workflow run handlers
reject an `Idempotency-Key` header because their workflow key already identifies
the execution. Service handlers require an explicit idempotency key instead.

Persist the returned invocation ID. Reconnect and cancellation use this same
invocation. A successful cancellation request is not confirmation of termination.
Stop dispatching settled tasks, and bound outbox retries within configured runtime
retention. After retention expires, the same key can start another execution.

Record database and provider operations through `ctx.run`. Database writes also
need stable operation identities. An external operation may finish before Restate
records its response, so execution durability does not prove exactly-once effects.

Use immutable worker endpoints for releases. Replacing worker code at an existing
endpoint can break journal replay. Keep the Restate admin API private.

References: [HTTP invocation](https://docs.restate.dev/services/invocation/http),
[durable steps](https://docs.restate.dev/develop/ts/durable-steps),
[cancellation](https://docs.restate.dev/services/invocation/managing-invocations),
[versioning](https://docs.restate.dev/services/versioning).

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
