# Configure Growth agent execution

Owner: Agents engineering. Last reviewed: 2026-10-23.

This setup connects Growth's Agents workspace and general assistant launcher to the shared
business worker (`AgentsBusinessRunV20`, harness `growth-products-v10`). Growth users keep their
existing business membership. They do not sign into standalone Agents or supply the worker's service credentials.

## Prepare the services

1. Follow [Agents local setup](../README.md#start-locally) to prepare its dedicated database,
   encrypted credential keyring, API, worker and registered Restate deployment.
2. Apply Growth's ordinary database migrations through its existing release process. The review
   store uses `GrowthAgentReview` and the existing `analytics_outbox`. Keep schema changes separate
   from starting the processes. This setup does not reset a Growth database or import legacy state.
3. Start Growth's API and web application through [Growth local development](../../growth/docs/internal/development/local-development.md).
4. Set Growth API `FRONTEND_URL` and Growth web `GROWTH_WEB_ORIGIN` to the same exact browser origin,
   for example `http://localhost:3000`. Set web `CORE_API_BASE_URL` to its Growth API origin.
   The active-business route rejects missing or mismatched origins.

Use the same scheme, hostname and port throughout the browser session. `localhost` and
`127.0.0.1` are different browser origins.

## Configure independent service keys

Create two RSA keypairs outside the repository. Store private keys only in server secrets.
Use SPKI public PEM and PKCS8 private PEM. Preserve PEM newlines in secret-manager values or
quoted multiline entries in private environment files.

For Growth commands, set these values in Growth API configuration:

```dotenv
AGENTS_PRODUCT_API_URL=http://127.0.0.1:4100
GROWTH_AGENTS_SIGNING_PRIVATE_KEY="<Growth command private PEM>"
GROWTH_AGENTS_KEY_ID=growth-v1
GROWTH_AGENTS_ISSUER=https://growth.kasitek.co.za
GROWTH_IDENTITY_ISSUER=https://growth.kasitek.co.za/identity
```

In Agents API and worker configuration, install the corresponding verifier:

```dotenv
GROWTH_AGENTS_PUBLIC_KEY="<Growth command public PEM>"
GROWTH_AGENTS_KEY_ID=growth-v1
GROWTH_AGENTS_ISSUER=https://growth.kasitek.co.za
GROWTH_IDENTITY_ISSUER=https://growth.kasitek.co.za/identity
```

`GROWTH_IDENTITY_ISSUER` identifies Growth's verified internal `User.id` namespace. Keep it
separate from the OIDC issuer that authenticates the human session. Growth derives the actor
and active business on the server. The browser cannot choose an actor in a service command.

For destination actions, configure the second keypair in Agents API and worker:

```dotenv
GROWTH_PRODUCT_API_URL=http://127.0.0.1:4000
AGENTS_PRODUCT_ACTION_PRIVATE_KEY="<Agents action private PEM>"
AGENTS_PRODUCT_ACTION_KEY_ID=agents-v1
AGENTS_PRODUCT_ACTION_ISSUER=https://agents.kasitek.co.za
```

Install its verifier in Growth API configuration:

```dotenv
AGENTS_PRODUCT_ACTION_PUBLIC_KEY="<Agents action public PEM>"
AGENTS_PRODUCT_ACTION_KEY_ID=agents-v1
AGENTS_PRODUCT_ACTION_ISSUER=https://agents.kasitek.co.za
```

Both directions bind the signature to the complete request digest and a short expiry. The command
endpoint is `POST /internal/v1/products/growth/commands`, with audience `agents-product-api` and
subject `growth-api`. Destination actions use `POST /internal/agents/actions`, audience
`growth-agent-actions` and subject `agents-worker`. Production service URLs require HTTPS.

To rotate verifier keys, use `GROWTH_AGENTS_PUBLIC_KEYS_JSON` or
`AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON` with `kid` to public PEM entries. Keep an optional feature
configuration control key in `GROWTH_AGENTS_CONTROL_PUBLIC_KEYS_JSON`; its separate private key
never belongs to the Growth browser service. Restart matching services after configuration changes.

## Automatically provision organisation defaults

Growth records a durable setup job in the same transaction as each organisation and owner
membership. The setup worker creates Growth assistant, Research, Content and Campaigns through
an independent signed provisioning API. Existing organisations enqueue missing setup on their
first authorised bootstrap request or through the bounded operator backfill below.

Apply Growth migration `20261023170000_growth_agent_setup` before deploying the API or worker.
Run Agents `setup:db` to apply the exact supported additive schema upgrade. Unknown schema
checksums remain rejected; do not reset an existing database to work around a mismatch.

Create an independent RSA provisioning keypair. Configure Growth API/worker with:

```dotenv
GROWTH_AGENTS_PROVISION_PRIVATE_KEY="<provisioning private PEM>"
GROWTH_AGENTS_PROVISION_KEY_ID=growth-provision-v1
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_ID=growth-default
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_REVISION=1
```

Configure Agents API with the matching verifier and explicit managed model profile:

```dotenv
GROWTH_AGENTS_PROVISION_PUBLIC_KEYS_JSON={"growth-provision-v1":"<public PEM>"}
GROWTH_MANAGED_MODEL_PROFILE_JSON={"id":"growth-default","revision":"1","providerId":"<installed-provider>","modelId":"<approved-model>","credentialRef":"GROWTH_MODEL_DEFAULT_API_KEY"}
GROWTH_MODEL_DEFAULT_API_KEY=<protected-provider-key>
```

The profile is trusted operator configuration. `credentialRef` names a protected Agents environment
secret, never a field accepted from Growth or its browser. Set provider, model and limits deliberately;
there is no implicit fallback key or automatic model substitution. Credentials enter organisation-scoped
vault custody and product use grants. Existing valid defaults and explicit revocations are preserved.
A profile revision change requires an explicit operator upgrade rather than a retry.

Provisioning uses `POST /internal/v1/products/growth/provision`, audience
`agents-product-provisioning`, subject `growth-provisioner`. Its full request digest covers the
organisation and target revisions. User execution and general configuration credentials cannot
invoke it. Agents checks current Growth eligibility at `POST /internal/agents/provisioning-check`,
with audience `growth-agent-provisioning-lifecycle`, subject `agents-provisioner`, and the existing
Agents action signing key. Both service origins and action verifier configuration remain required.

Run the existing API workers, or start a dedicated Growth worker with
`KASITEK_PROCESS=growth-agent-setup-worker`. If `KASITEK_DISABLE_BACKGROUND_WORKERS=true`, the
API does not deliver setup jobs; start the dedicated worker explicitly. No model inference runs
as part of provisioning. Discovery validates provider metadata; live-model acceptance and evaluations
remain owner-run.

From `products/growth/api`, with the intended protected environment profile, use:

```sh
node --import tsx scripts/agent-setup.ts status
node --import tsx scripts/agent-setup.ts backfill 100
node --import tsx scripts/agent-setup.ts retry <organisation-id>
node --import tsx scripts/agent-setup.ts cancel <organisation-id>
```

Backfill only inserts missing setup jobs. Retry preserves the job's original target and operation
identity. Cancel fences the source job; it does not revoke already accepted conversations or
replace the independent Agents tenant-control operation. Missing or invalid configuration becomes
blocked. Transient failures use bounded retries; exhausted attempts remain visible for repair.

The operator status reports state counts, attempts, pending age and completed setup duration.
Structured `agent.setup.*` logs include organisation/operation/generation and safe failure codes.
OpenTelemetry records `growth.agent_setup.backlog`, transition counts and setup duration through
Growth's existing telemetry. Provisioning does not add customer Analytics events or expose keys,
prompts or private profile data in telemetry.

Growth shows all four defaults during setup and refreshes pending/running state with bounded polling.
A completed setup still requires current membership, entitlements, a healthy runtime and any
operation-specific account or context. Setup must not silently grant publishing or campaign rights.

The manual `setup:growth-model` command remains available for explicit operator model changes.
Automatic repair does not overwrite those settings. For rollback, disable setup delivery first and
retain the additive tables and queued jobs. Apply service configuration/schema before enabling
workers. No production deployment is implied by this local setup.

## Check the available work

Use the general assistant for product guidance and business context. Research reads explicitly
attached Growth records. Content proposes an editable draft, requires a connected publishing
account and exact approval, then returns a receipt for a real `SocialPost` in `DRAFT` state.
Campaigns reads actual WhatsApp campaign context. Scoped analytics context requires its existing
reporting gateway configuration and an explicit range.

Growth remains the review authority. A shared worker decision cannot replace Growth's current
membership, account checks or exact proposal digest. A lost acknowledgement is reconciled from
the stable domain operation before another save. Product evidence remains private and carries
current resource/source/revision checks through history, compaction and artifact access.

These initial Growth features disable external web research, automatic publishing, campaign
launch, personal memory, specialist delegation and sandbox access. Customer channel agents keep
the separate standalone Agents deployment and Inbox path.

## Disable or restore execution

Set `GROWTH_CONTROL_TENANT_ID` and one operator action in private configuration, then run:

```sh
pnpm --dir products/agents/api control:growth
```

Use `GROWTH_CONTROL_ACTION=tenant.disable` to fence new work and reads, revoke execution grants,
and request cancellation of active task trees. Exit code `2` means cancellation needs another
pass. Rerun the same action. An already committed Growth effect remains recoverable.

Use `tenant.enable` to allow future tenant access. It does not revive revoked grants, old runs or
credentials. Use `model.revoke` to clear Growth-managed credential envelopes, use grants and its
model default. Reprovision explicitly with `setup:growth-model` before new work can run.
These operations use operator database authority and have no browser endpoint.

## Inspect outcomes

Growth engineering owns the three registered `growth.agent.*` event contracts and the existing
transactional Analytics outbox. Count accepted `conversations.create`, `turns.submit` and
`tasks.cancel` acknowledgements separately from rejected or unavailable commands. Count exact
review decisions and confirmed saved drafts from their dedicated events. Stable record identities
deduplicate retries. Admission counts do not establish successful agent results.

Use Growth's `kasitek.operation.duration` for the service bridge and Agents'
`agents.operations.duration_p95_ms`, `agents.capacity.oldest_wait_ms` and `agents.usage.tokens`
for execution health. Inspect native task, operation and root model accounting for tenant-level
success, failure and known or unknown costs. Ordinary traces and product facts exclude private
briefs, contents and keys. Configure the existing Analytics publisher to deliver queued outcomes.

## Verify the integration

The engineering journey uses the actual built Growth UI and BFF, authenticated product HTTP,
PostgreSQL and Restate. Only dashboard identity and model responses are controlled fixtures.
It checks Growth-only identity, two turns, quick access/history, API/worker restarts, exact
reviewed draft readback, signed pagination, concurrent configuration, private downloads and
withdrawn evidence. It creates and removes its own databases and Restate container.

With local PostgreSQL administrator access supplied privately as `AGENTS_TEST_ADMIN_URL`,
Docker and Playwright Chromium available, run from the repository root:

```sh
pnpm --filter @kasitek-labs/contracts build
pnpm --dir products/growth/web build
pnpm --filter @kasitek/agents exec vitest run test/growth-product-http.test.ts
```

Browser evidence is saved under `.audit/growth-agent-real-browser/`. A passed deterministic
journey establishes engineering behavior, not model quality or live provider compatibility.

The optional [Growth Harbor mode](../evaluation-adapters/harbor/README.md#growth-product-mode-owner-run)
prepares owner-run cases through normal Growth HTTP with one isolated business and staff session
per trial. Its pure adapter checks do not run evaluations. It does not supply native model-call
exports, model-policy digests or server-native trial reservation/revocation. Configure and discard
the isolated environment through its owner-run setup. The standalone Harbor mode retains its own
native export and trial contracts. Production rollout, hosted retention and alert qualification
remain separate from this implementation.
