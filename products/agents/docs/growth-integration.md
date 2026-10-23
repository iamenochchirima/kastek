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

## Provision the Growth model

Configure the Agents credential vault before provisioning a model. In private operator
configuration, set `GROWTH_MODEL_TENANT_ID` to the actual Growth organization ID, then set
`GROWTH_MODEL_PROVIDER_ID`, `GROWTH_MODEL_ID` and `GROWTH_MODEL_API_KEY` explicitly.
An optional `GROWTH_MODEL_ENDPOINT` must pass the provider setup policy.

From the repository root, run:

```sh
pnpm --dir products/agents/api setup:growth-model
```

The command registers the Growth execution tenant, discovers model metadata, encrypts the key,
and records an explicit Growth service-use grant and default. It does not run a model-quality
evaluation or establish live inference compatibility. A normal server environment key does not
become a model connection or runtime fallback.

Open Growth **Agents**. Missing service trust, current permissions, enabled features or a usable
managed model produces an unavailable state. New messages pin the current feature configuration,
model route and context revision. In-progress work retains its accepted route and still checks
current credentials and Growth authorization before use.

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

Controlled HTTP, Restate and PostgreSQL checks use isolated services and state. The existing
Harbor preparation adapter targets standalone Agents identities. Growth-scoped trial preparation
is not established by these product journeys. The owner runs purpose evaluations and live-provider acceptance. Those checks, production rollout, hosted
retention and production alert thresholds are separate from this setup.
