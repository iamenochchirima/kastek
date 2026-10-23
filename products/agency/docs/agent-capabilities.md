# Agency product capabilities

The shared execution product namespace is `agencies`; the installed operation
namespace is `agency.workspace_agents.read`.

Agency exposes `POST /internal/agents/capabilities` for the installed
`agency.workspace_agents.read` operation. It returns permitted workspace-agent
IDs, names, statuses and timestamps from `workspace_agents`. It excludes agent
configuration, conversations and message bodies. Existing browser metadata APIs
retain their session and workspace behavior.

## Service trust and destination authority

The caller is the Agents worker, authenticated with an RS256 JWT. Configure
`AGENTS_PRODUCT_ACTION_ISSUER` and either `AGENTS_PRODUCT_ACTION_PUBLIC_KEY` or
`AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON`, a key-ID to PEM mapping. The optional
`AGENTS_PRODUCT_ACTION_KEY_ID` selects the single-key ID, default `agents-v1`.
The audience is `product-capability-actions`, subject is `agents-worker`, and
`requestDigest` is SHA256 of the complete canonical JSON invocation. Tokens
require `iat`, `exp` and `jti`, with a maximum 120-second lifetime. No request can
supply a key URL, service endpoint or executable handler. Missing service trust
returns unavailable. The Agents client uses its separately configured Agency
service URL and signing key. These credentials never enter model context.

A valid service signature authenticates the caller. It does not grant access to
an Agency workspace. Agency owns two tables introduced by migration
`20261023200000_product_capability_authority.sql`:

- `product_capability_mappings` maps an exact origin product, origin tenant and
  actor issuer/subject to an existing Agency workspace and tenant user. The
  invocation's `originTenantId` and destination `tenantId` are separate fields.
- `product_capability_grants` pins the mapping, operation, binding ID/digest,
  manifest/descriptor digests, handler and policy revision to an explicit
  allowlist of agent IDs. Each mapping and grant has expiry and revocation state.

Destination administrators issue these rows through trusted database operations.
There is no public grant-creation API or automatic same-ID mapping. Installing a
manifest through the trusted publication/control path or selecting a tool does
not create a mapping or grant. The Agents runtime must register the compatible
installed adapter and validate this product-owned manifest through shared
contracts; it never imports Agency private runtime source. Live Agency remains
unavailable until that trusted installation and explicit mapping exist.
`registerAgencyProductCapabilities` installs the signed HTTP transport when
`AGENCY_PRODUCT_API_URL` and `AGENTS_PRODUCT_ACTION_PRIVATE_KEY` are configured.
Its compatible manifest descriptors still come from the product-owned trusted
publication; configuring transport does not publish tools or grant their use. No standalone
Agents account or membership is created. An operator must obtain the exact
validated immutable binding digest before issuing its grant; a changed binding
requires a newly authorized grant.

Every call checks the mapping/grant, active workspace, active mapped tenant user,
workspace membership and current `AGENT_ROLES` from the existing Agency domain:
owner, admin, automation_manager or support. Mapping a user from another
workspace fails. A grant cannot expose an agent outside the destination
workspace even if its ID is present in the allowlist. The metadata and checks
share one database snapshot.

## Read and later use

The invocation uses the shared `ProductCapabilityInvocation` contract. The
operation accepts `agentId`, `after` and `limit`; arbitrary input keys fail.
Pagination uses stable IDs and returns `next`. The maximum requested page is 50,
and pages shrink to the descriptor's existing response byte ceiling with a
continuation cursor. Names/statuses are bounded metadata projections.

The `authorize` control checks current destination authority. Each read returns
versioned source observations. Before later model use or delegation, the shared
harness must use `evidence` control with the source ID and revision. Agency checks
current authority, agent scope and the authoritative metadata revision again.
Revoked grants, role changes, disabled workspaces, removed records and changed
metadata fail this check. Reading metadata does not launch an Agency agent.

## Verification and release

Focused API tests use actual Agency migrations and PostgreSQL in disposable
schemas. They cover pagination, excluded configuration, signed request binding,
foreign identities/workspaces, current role checks, revocation and source
revision changes. Run `TENANT_TEST_DATABASE_URL=<disposable-database-url> pnpm
--filter @kasitek/agency-tenants exec tsx --test tests/product-capabilities.test.ts
tests/migrations.test.ts`. Test results are integration evidence, not evaluations.

Risk is standard. Apply the additive migration and compatible service code before
issuing mappings/grants. Rollback disables the service trust or revokes grants;
no existing browser API or data needs to change. Logs record operation, binding,
request/task IDs and mapping reference without record bodies. Customer analytics
events, Agency assistant UI, provisioning, voice execution, production deployment
and evaluation runs are not applicable to this metadata release.
