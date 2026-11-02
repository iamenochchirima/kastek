# Private Restate deployment

This single-node Railway packaging uses the same pinned Restate 1.7.13 image digest as the
independent local compose profile. Build from the repository root using
`infra/agents-runtime/production/Dockerfile`; Railway's configuration path is
`infra/agents-runtime/production/railway.json`.

Attach a persistent volume at `/restate-data` before the first startup. Keep ingress port 8080,
admin port 9070 and the Agents worker private; do not create public domains or public TCP proxies.
The configured listeners bind `0.0.0.0` so the private Railway network can reach them. Ingress
signing authenticates Restate to the worker; it does not authenticate callers to Restate ingress
or admin. Private network access therefore remains an authorization boundary.

Set `RESTATE_SIGNING_PRIVATE_KEY_PEM` only on this Restate service to a fresh Ed25519 PKCS8 PEM
private key, with actual newline characters. Do not bake it into the image, repository, command
arguments or logs. The entrypoint requires the value, writes a 0600 file in a 0700 temporary
directory outside the persistent volume, removes the variable from the server process environment,
and points `[worker.invoker].request-identity-private-key-pem-file` at that file. Restate validates
the key before serving requests. A malformed or unsupported key fails startup. The private file
is recreated from the runtime secret after a container replacement; preserve that secret.

Derive the matching public SDK identity using the deployment operator's private environment:

```sh
node infra/agents-runtime/production/request-identity.mjs
```

This helper reads `RESTATE_SIGNING_PRIVATE_KEY_PEM` and prints only the corresponding
`publickeyv1_` identity. Set that value as `RESTATE_REQUEST_IDENTITY_KEYS` on Agents workers and
set `RESTATE_WORKER_HOST=0.0.0.0`. Never enable `AGENTS_ALLOW_UNSIGNED_WORKER` in production.
Use the private Restate 8080 origin for Agents ingress and its 9070 origin for deployment
registration. Register an immutable release-specific worker endpoint, then verify signed discovery
and a real owned execution before enabling product traffic. Retain old worker endpoints for
existing journals. During signing-key rotation, workers may accept both public identities before
the signing service switches keys; remove the old public identity only after rollback acceptance.

`RESTATE_NODE_NAME` may override the stable `agents-production` node name. Keep the node name and
volume together across restarts. This is a single-node configuration with no high availability;
back up its durable volume and verify recovery before relying on it for production work. Do not
attach one volume to two concurrently running nodes. Do not reinitialize or delete the volume as
a restart or rollback step. Roll back compatible server artifacts with the existing volume and
signing secret intact; verify the pinned release's storage compatibility before a downgrade.

## Verification

With Docker available and root workspace dependencies installed, build and run:

```sh
docker build -f infra/agents-runtime/production/Dockerfile -t kasitek-restate:packaging-check-20261102 .
node infra/agents-runtime/production/verify.mjs
```

Choose a working Docker context through `DOCKER_CONTEXT` if necessary. The verification generates
a temporary fixture key in memory and creates its own container, volume and signed SDK endpoint.
It checks required-secret failure, actual Restate configuration parsing, 0600 key-file permissions,
signed discovery and invocation, unsigned request rejection, and replay after a container restart
without rerunning the handler. It cleans up only those fixtures. It does not deploy services,
configure production secrets or verify hosted private-network policy.

The release record must retain the source SHA, image digest, volume identity, public signing
identity, worker registration and hosted verification evidence. No database migration or new
analytics event applies; existing execution logs and durable journals remain authoritative.
No private keys belong in that record.

Configuration references: [Restate 1.7.13 signing options](https://github.com/restatedev/restate/blob/v1.7.13/crates/types/src/config/worker.rs)
and [SDK identity verification](https://restatedev.github.io/sdk-typescript/interfaces/_restatedev_restate-sdk.EndpointOptions.html).
