# KasiTek Developers Platform Checklist

**Status:** Proposed focused implementation plan
**Owner:** Direct KasiTek product
**Scope:** Workspace Developers section, API keys, REST onboarding, MCP onboarding, multi-client AI-agent connections, and developer documentation
**Out of scope:** White-label tenant portal, a public plugin marketplace, broad SDK generation, and a general agent-platform rewrite

## Purpose

This checklist defines the bounded Developers product slice inspired by the PostEverywhere developer
experience shown in the product references. It exists to keep implementation focused on a coherent
developer setup flow and to prevent the work from expanding into unrelated Agent Platform, billing,
provider, or white-label work.

The intended experience is:

```text
Developers
  ├── Quick start
  ├── API keys
  ├── MCP
  ├── CLI and SDKs
  ├── API reference
  ├── Workspace/resource IDs
  └── Webhooks (later)
```

The user should be able to create one named Developer API key, choose how they want to use KasiTek,
receive a copyable setup example, test the connection, and manage the key later. The user should
not need to understand installation-token audiences, internal delegation, gateway processes, or
transport-level read/write scopes.

This is a product and integration slice over the existing Agent Platform. It does not replace or
reorder the Agent Platform audit checklist, execution blueprint, or approved MCP architecture.

## Governing repository documents

Before implementation, read these documents in the repository order defined by `AGENTS.md`:

1. [`KASITEK_AGENT_SYSTEM_AUDIT_REMEDIATION_CHECKLIST.md`](KASITEK_AGENT_SYSTEM_AUDIT_REMEDIATION_CHECKLIST.md)
2. [`KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md`](KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md)
3. [`KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md`](KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md)
4. [`PROJECT_PLAN.md`](PROJECT_PLAN.md)

Relevant existing contracts include:

- [`docs/api/agent-connection-guide.md`](docs/api/agent-connection-guide.md)
- [`docs/api/mcp-integration.md`](docs/api/mcp-integration.md)
- [`agents/docs/mcp-integration.md`](agents/docs/mcp-integration.md)
- [`server/kasitek-core/src/identity/principal.rs`](server/kasitek-core/src/identity/principal.rs)
- [`agents/src/http/app.ts`](agents/src/http/app.ts)
- [`client/apps/client/src/components/dashboard/agents/agent-connection-wizard.tsx`](client/apps/client/src/components/dashboard/agents/agent-connection-wizard.tsx)

## Product decisions for this slice

These are the proposed decisions to approve before implementation. Do not silently change them
during coding.

- [ ] Developers is a workspace product area in `client/apps/client`, not an admin-console area and
  not a white-label tenant-portal feature.
- [ ] The primary connection experience is **Connect an AI agent**, not a Codex-only setup flow.
- [ ] The first client tabs are Claude, ChatGPT, Claude Code, Cursor, and Other MCP client. Codex is
  included in client-specific setup rather than treated as the only integration.
- [ ] Browser-based sign-in and approval is preferred for clients that support OAuth or hosted
  connectors. API-key setup remains available for REST, scripts, and clients that cannot use the
  browser flow.
- [ ] Authorized workspace users can access developer setup during the testing phase without a
  billing or paid-plan guard.
- [ ] Developer credentials are workspace-owned. The creator is recorded for audit, but the key is
  not tied permanently to that person’s browser session.
- [x] The visible product concept is a named **Developer API key**. REST and MCP use the same key;
  the Agent Platform keeps an internal installation principal for capability and activity records.
- [x] REST API keys authenticate the public `/v1` API directly through the workspace API-key
  principal.
- [x] MCP accepts the normal long-lived workspace Developer API key directly. The Agent Platform
  creates or resolves an internal external-connected installation behind the scenes so the
  implementation retains installation identity, capability grants, resource policy, revocation,
  audit, idempotency, and approval behavior.
- [x] API-key validation is performed by Core on every MCP request. No separate user-managed MCP
  token, secret exchange, or transport credential is required.
- [ ] There are no MCP-versus-REST read/write checkboxes. Access is represented by capabilities,
  resource constraints, availability, and approval policy.
- [ ] The testing default is a visibly labelled full test-access profile. It removes commercial
  entitlement guards but does not grant secret reads, organization privilege changes, billing
  mutations, workspace deletion, approval bypass, audit bypass, or cross-organization access.
- [ ] Reads and reviewable drafts may run immediately. External effects such as publishing, sending,
  scheduling, deleting, or booking confirmation retain their existing approval, idempotency,
  receipt, and reconciliation requirements.

## Current baseline

These foundations already exist and should be reused rather than replaced:

- [x] External-connected agent installations exist in the Agent Platform.
- [x] Legacy external-agent installation credentials use copy-once secret creation, hashing,
  rotation, revocation, and audience-bound token exchange where that advanced flow remains in use.
- [x] A separately deployed MCP gateway exists with the hosted `/mcp` transport.
- [x] Capability discovery and invocation are filtered through installation grants and shared policy.
- [x] Public REST `/v1` has a partial typed contract and an agent-installation authentication path.
- [x] The Agents area has an external-agent connection flow and installation detail controls.
- [x] The Agent Platform already contains a local stdio bridge that forwards MCP messages to the
  configured gateway.
- [x] Workspace API-key principals are implemented and accepted by the public `/v1` API.
- [x] A dedicated Developers product area exists.
- [x] A one-step multi-client AI-agent connection flow exists.
- [ ] A published `@kasitek/mcp` compatibility package exists for clients that require local stdio.
- [ ] A separate REST SDK or CLI package exists; it is not bundled into the MCP server package by
  default.
- [x] Local and hosted setup URLs are selected from environment configuration rather than hardcoded
  in the client.

## Target terminology

Use these terms consistently in UI, API documentation, and code comments:

| Term | Meaning | User visibility |
| --- | --- | --- |
| Developer API key | Named workspace credential used to bootstrap or call approved developer surfaces | Shown once; metadata shown thereafter |
| External agent installation | Workspace-owned non-human principal representing Claude, ChatGPT, Codex, Cursor, n8n, or another runtime | Visible in Developers and Agents |
| MCP Developer API key | The same workspace API key used by REST and MCP | Shown once; stored in the client environment |
| REST API key/token | Credential accepted by the public `/v1` API under its approved principal policy | Key metadata and setup instructions visible |
| `@kasitek/mcp` package | Optional local stdio compatibility bridge for clients that cannot use remote HTTP | Installed by the client with `npx` or equivalent |
| REST SDK/CLI | Separate programmatic integration surface for applications and scripts | Separate package and documentation |
| Capability grant | Business operation the agent may use | Visible as access, not transport read/write |
| Resource scope | Workspace resources the operation may access | Visible where relevant |
| Approval | Required user/admin authorization for a consequential effect | Visible in approval/activity UI |

Avoid exposing “installation secret,” “MCP scope,” “REST scope,” or “audience” as the primary
onboarding language. Keep those terms in technical documentation and diagnostics only.

## Navigation and information architecture

### Current implementation status

The current slice implements the direct-product Developers surface, workspace REST API-key
lifecycle, `/v1` API-key principal, environment-aware MCP setup guidance, and the local
`@kasitek/mcp` adapter. Actual package publication is intentionally deferred. Items that require a
live database, deployed Agent Platform, hosted client, or additional audit/rate-limit coverage stay
unchecked until those checks produce evidence.

Developers must not duplicate provider/account identity management. Account IDs, connected
platform accounts, and provider linkage remain owned by Connections; Developers may link to that
context when setup instructions need an identifier.

### Developers entry point

- [x] Add a Developers entry point in the direct product workspace navigation.
- [x] Make the entry point available to the intended workspace roles during testing without a
  payment lock.
- [x] Preserve the separate Agents area for agent definitions, runs, grants, approvals, and runtime
  activity.
- [ ] Link between Developers credentials and the linked external agent installation without making
  users configure the same access twice.
- [x] Add role/permission checks before exposing credential metadata or mutation controls.
- [ ] Add loading, empty, stale, degraded, retry, unauthorized, and revoked states.

### Connect an AI agent

- [x] Use the user-facing heading “Connect an AI agent” or equivalent plain language.
- [x] Provide tabs or cards for Claude, ChatGPT, Claude Code, Cursor, and Other MCP client.
- [x] For hosted-connector clients, show a short flow: open client settings, add the
  connector/server URL, sign in, approve, and test a safe request.
- [ ] Show “No API key needed” only when the selected client really uses browser-based
  authentication. Do not imply that every MCP client has the same authentication capability.
- [x] For local-stdio clients, show the `@kasitek/mcp` setup command and the minimum environment
  configuration required.
- [x] For generic clients, show the hosted/local endpoint, authentication method, protocol revision,
  and a copyable configuration block.
- [x] End each client flow with a safe example prompt and a link to available capabilities.
- [ ] Record which client/setup path was selected for diagnostics without recording credentials.
- [ ] Keep client-specific instructions as adapters over the same MCP endpoint and capability
  registry; do not create client-specific business logic.

### Quick Start

- [x] Explain in one short paragraph what KasiTek’s API and MCP connection provide.
- [x] Show the three-step path: create a Developer API key, choose a client, test a safe request.
- [x] Provide a primary “Create API key” action.
- [ ] Provide client choices for Claude, ChatGPT, Claude Code, Cursor, Other MCP client, cURL,
  JavaScript, and Python where supported.
- [x] Do not require users to choose MCP write or REST write transport permissions.
- [x] Link to API reference and the MCP setup guide.

### API Keys

- [x] Show an empty state with one clear “Create API key” action.
- [ ] Create keys with a name, optional description, environment, and access profile.
- [ ] Use a test-phase default access profile with clear exclusions.
- [x] Show the complete secret only once after creation.
- [ ] Show only safe metadata later: name, prefix, created time, creator, last used, expiry, status,
  linked installation, and allowed access profile.
- [x] Provide rotate, revoke, suspend/resume where supported, and copy setup instructions.
- [x] Confirm destructive credential actions and explain their immediate effect.
- [x] Never expose hashes, raw secrets, private keys, provider credentials, or token contents.

### MCP

- [x] Show the environment-specific MCP endpoint.
- [x] Show a client selector: Claude, ChatGPT, Claude Code, Cursor, Other MCP client.
- [x] Generate client-specific setup text from the selected environment and authentication method.
- [x] Provide a “Connect” action for the shared Developer API-key setup.
- [x] Provide a “Copy setup” action and, where supported, a client-specific “Add to” action.
- [x] Provide the `@kasitek/mcp` command for clients that require a local stdio server.
- [ ] Provide “Test connection” that performs discovery and reports effective capabilities.
- [ ] Show granted, unavailable, not configured, and approval-required reasons safely.
- [ ] Explain that the MCP connection can read/write only within granted capabilities and resources.
- [x] Do not expose token exchange commands in the primary Developers flow.
- [ ] Do not require a package when the selected client supports direct remote Streamable HTTP MCP.
- [ ] Do not make the MCP package a second REST client or duplicate the capability registry.
- [ ] Provide a link to the linked external installation’s activity, grants, and revoke controls.

### CLI, SDKs, and API reference

- [ ] Publish cURL examples for health, discovery, one read, one draft, and one approval-required
  operation.
- [ ] Publish JavaScript and Python examples only for endpoints that are verified and stable.
- [ ] Publish the core-owned OpenAPI document and explain authentication and idempotency.
- [ ] Document workspace IDs, installation IDs, resource IDs, and safe identifier lookup.
- [ ] Keep CLI installation and generated SDKs out of the first implementation unless separately
  approved after the HTTP contracts stabilize.
- [ ] If a CLI is later added, its login flow must avoid writing long-lived secrets into source files,
  shell history, or prompts.

## Credential and authentication contract

### Storage and lifecycle

- [x] Decide whether the existing installation credential model can represent user-facing Developer
  API keys without a duplicate secret store.
- [x] If a new workspace API-key record is required, add a migration and preserve explicit principal
  types rather than treating every credential as an agent installation.
- [x] Hash credentials at rest with a high-entropy API-key digest and never store the raw value.
- [x] Store a non-secret display prefix for identification.
- [ ] Store organization, creator, name, status, environment, creation time, expiry, last-used time,
  revocation time, rotation history, and linked installation when applicable.
- [x] Recheck active status, organization, expiry, and API scope on every REST and MCP request.
- [x] Make rotation/revocation effective immediately for new requests because MCP uses the API key
  directly; no issued MCP token remains valid after revocation.
- [ ] Emit redacted audit events for create, view-once, exchange, use, rotate, revoke, suspend, and
  failed authentication.
- [ ] Rate-limit key creation, discovery, and failed authentication.

### REST

- [x] Add workspace API-key authentication to the core public `/v1` principal boundary.
- [x] Define REST key scope and resource policy using business capabilities, not `read`/`write`
  transport labels.
- [ ] Enforce organization and resource isolation before business queries or mutations.
- [ ] Require idempotency keys for mutations and expose durable operation status for asynchronous work.
- [ ] Preserve rate limits, usage attribution, audit, deprecation, and stable error contracts.
- [ ] Keep unsupported principal types rejected explicitly until their own contract is implemented.

### MCP

- [ ] Keep MCP authentication at the gateway/Agent Platform boundary.
- [ ] Resolve every MCP connection to an active external agent installation.
- [x] Use the workspace Developer API key directly for MCP. Core validates key status, workspace,
  expiry, and scopes on every request; the Agent Platform maps the key to an internal installation
  without allowing client-supplied organization or installation identifiers to override it.
- [ ] Filter `tools/list` and `tools/call` by installation capability grants, resources, availability,
  approval policy, and kill switches.
- [ ] Ensure MCP calls produce the same durable audit, usage, approval, idempotency, and receipt
  outcomes as equivalent hosted-agent operations.

## Environment and setup contract

- [x] Define environment configuration for hosted, local, and test URLs.
- [x] Hosted defaults:
  - MCP: `https://agents.kasitek.co.za/mcp`
  - REST: `https://api.kasitek.co.za/v1`
- [x] Local defaults:
  - MCP: `http://127.0.0.1:4200/mcp`
  - MCP authentication: `Authorization: Bearer <developer-api-key>`
  - REST: `http://127.0.0.1:4100/v1` where the local Agent REST transport is intended
- [x] Do not hardcode hosted endpoints in a setup component that is expected to support local
  development.
- [x] Make generated MCP setup use `KASITEK_API_KEY` as the environment variable for the shared
  Developer API key.
- [ ] Never commit a real API key, installation secret, exchanged token, or private key.
- [ ] Document that hosted credentials and local credentials belong to different databases and cannot
  be exchanged across environments.
- [ ] Verify that the local stack starts the Agent API and gateway before claiming local setup works.
- [ ] Verify that a local credential can be created, exchanged, discovered, revoked, and rejected
  after revocation.

## AI client and MCP package setup contract

- [ ] Provide a standard remote MCP setup for clients that accept a URL.
- [ ] Provide a local stdio setup for clients that require a command-launched server.
- [ ] Publish `@kasitek/mcp` only as a thin adapter that forwards JSON-RPC to KasiTek’s MCP gateway.
- [ ] Keep the package responsible for bounded transport forwarding, protocol negotiation, endpoint
  selection, and approved authentication/bootstrap behavior.
- [ ] Keep business tools, capability manifests, authorization, approvals, audit, usage, and
  receipts on KasiTek’s hosted services.
- [ ] Support hosted and local endpoints through explicit configuration such as `KASITEK_MCP_URL`
  or the repository-approved equivalent.
- [x] Accept the shared Developer API key through `KASITEK_API_KEY` without writing credentials to
  source files.
- [ ] Provide a generic configuration block that can be adapted to Claude, ChatGPT, Claude Code,
  Cursor, Codex, and other clients.
- [ ] Provide a short client-neutral prompt telling the agent to discover tools, use safe reads first,
  and ask before consequential writes.
- [ ] Keep raw keys out of `AGENTS.md`, prompts, repository files, screenshots, and shell history.
- [ ] Treat a package, skill, CLI, and plugin as separate distribution decisions even if they share
  the same MCP endpoint.

## API and MCP documentation

- [ ] Add a Developers Quick Start document linked from the UI.
- [ ] Document key creation, one-time display, rotation, revocation, expiry, and safe storage.
- [ ] Document REST authentication, supported principals, scopes, resources, pagination, errors,
  idempotency, rate limits, and operation status.
- [ ] Document MCP authentication, endpoint, protocol revision, discovery, tool calls, approvals,
  cancellation, errors, and API-key lifecycle.
- [ ] Include Claude, ChatGPT, Claude Code, Cursor, Codex, generic MCP, cURL, JavaScript, and Python
  setup examples only after each path has been tested.
- [ ] Document when `@kasitek/mcp` is required and when direct remote MCP makes it unnecessary.
- [ ] Document the separation between the MCP package and the REST API/SDK surface.
- [ ] Include local and hosted examples with clearly different URLs.
- [ ] Include a security section explaining that API keys are secrets and should be rotated after
  exposure.
- [ ] Keep API examples free of real credentials and customer data.
- [ ] Keep OpenAPI, generated capability documentation, UI setup snippets, and runtime behavior in
  sync.
- [ ] Add a concise server-wide MCP instruction describing discovery, approval, rate, and safety
  behavior. Codex reads MCP server instructions during initialization; see the
  [official MCP guidance](https://learn.chatgpt.com/docs/extend/mcp).

## Implementation progress

- [x] Add the first `@kasitek/mcp` package slice as a standalone, buildable local stdio adapter.
- [x] Keep the package free of business tools, capability policy, product data, and REST client
  behavior.
- [x] Support explicit hosted/local endpoint configuration, bearer forwarding, bounded responses,
  protocol discovery, compatibility checks, and notification silence.
- [x] Add focused package tests alongside the existing internal stdio bridge tests.
- [ ] Connect the package to the final authenticated Developers setup flow before publishing it.

Package publication is deliberately out of this implementation scope. The package remains
buildable and transport-only; publication and the final authenticated bootstrap flow require a
separate release decision.

## Security and policy gates

- [x] Confirm no payment or subscription guard blocks the Developers section during controlled
  testing.
- [ ] Preserve organization isolation and resource ownership.
- [ ] Preserve capability grants and installation status checks.
- [ ] Preserve secret, credential, billing-mutation, role-management, workspace-deletion, approval-
  bypass, and audit-bypass exclusions from full test access.
- [ ] Require approval for declared external effects.
- [ ] Require idempotency for every mutating operation.
- [ ] Store no raw key/token in logs, traces, audit payloads, workflow history, MCP output, or UI
  responses after the one-time creation screen.
- [x] Reject expired, revoked, rotated-out, malformed, cross-organization, and cross-installation
  API-key requests. Legacy installation credentials retain their audience checks.
- [ ] Prevent a client-provided installation, organization, or actor identifier from overriding the
  authenticated principal.
- [ ] Apply request limits to key creation, exchange, discovery, and tool invocation.
- [ ] Add a documented key-compromise response: revoke, rotate, and inspect activity.

## Verification checklist

### Automated

- [ ] Credential repository tests cover creation, hashing, one-time display, lookup, rotation,
  revocation, expiry, last-used tracking, and organization ownership.
- [ ] Core authentication tests cover workspace API keys, unsupported principals, scope/resource
  denial, idempotency, rate limits, and stable error responses.
- [ ] Agent authentication tests cover direct Developer API-key MCP authentication, workspace
  ownership, revocation, suspension, internal installation mapping, and capability filtering.
- [ ] MCP/REST parity tests cover equivalent reads, drafts, approvals, idempotency, audit, and
  operation references.
- [ ] Client tests cover Developers navigation, key creation, one-time secret display, copy actions,
  empty states, revoke/rotate, client selection, setup snippets, and failure states.
- [ ] Secret scans confirm no real credential is present in repository files, test fixtures, docs, or
  generated examples.

### Runtime and client compatibility

- [ ] Local smoke: create a local credential, configure the local MCP package or a direct local MCP
  client, discover tools, call a safe read, and verify audit/usage evidence.
- [ ] Hosted smoke: create a test credential, connect at least one hosted AI client, discover tools,
  call a safe read, and verify the linked installation.
- [ ] REST smoke: authenticate with a supported developer key, list a resource, submit an idempotent
  draft, repeat the request, and verify no duplicate.
- [ ] Revocation smoke: revoke the credential and confirm new REST/MCP requests fail promptly.
- [ ] Approval smoke: invoke one approval-required operation and verify the preview, decision,
  execution, receipt, and activity timeline.
- [ ] Test at least one hosted AI client, one local stdio client using `@kasitek/mcp`, one generic
  MCP client, cURL, and one typed REST client.
- [ ] Verify the setup flow works without exposing the key in the prompt, repository, or logs.

### Required commands after implementation

Run the narrowest relevant checks first, then the integration checks:

```bash
pnpm --dir agents test
pnpm --dir agents build
pnpm --dir client/apps/client lint
cargo check -p kasitek-core
cargo test -p kasitek-core
```

Also run the relevant migration, HTTP, MCP, REST conformance, client, and local-runtime tests. Any
unavailable PostgreSQL, Temporal, Redis, provider, browser, hosted, or external-client check must be
recorded with the exact command and impact rather than reported as complete.

## Phased implementation boundary

### Phase 0 — Confirm product decisions

- [ ] Approve the principal/key model.
- [ ] Approve who can create, rotate, revoke, and view keys.
- [ ] Approve the test access profile and immutable exclusions.
- [x] Use a normal Developer API key for the first MCP release. OAuth or delegated credentials are
  future options, not part of this user-facing flow.
- [ ] Decide whether Developers is workspace-owner/admin only or has a dedicated developer role.

**Exit:** no unresolved decision changes storage, authentication, or UI ownership during Phase 1.

### Phase 1 — Contracts and information architecture

- [ ] Define stable API DTOs for key metadata, creation response, rotation/revocation, setup targets,
  connection status, and capability access.
- [x] Define hosted/local environment configuration.
- [x] Define the Developers routes and navigation labels.
- [x] Define copy-once and security copy.
- [ ] Update the relevant OpenAPI and MCP documentation contracts before wiring UI.

**Exit:** UI can be built against typed contracts without inventing response shapes.

### Phase 2 — Credential and authentication foundation

- [ ] Implement only the credential/principal changes required for the approved API-key flow.
- [ ] Add migrations and repository tests.
- [ ] Add REST authentication or the approved exchange path.
- [ ] Preserve existing installation-token behavior and external-agent compatibility.
- [ ] Add revocation, audit, rate, and cross-organization tests.

**Exit:** a real test credential can authenticate the intended transport and be revoked safely.

### Phase 3 — Developers UI

- [x] Build Developers shell and Quick Start.
- [x] Build API Keys list/create/detail/lifecycle states.
- [ ] Build MCP client setup and connection test.
- [ ] Link credentials to external installations and Agents activity.
- [ ] Add local/hosted endpoint selection from configuration.

**Exit:** a user can create a test key and receive correct setup instructions without technical
credential choreography.

### Phase 4 — Documentation and compatibility

- [ ] Add tested client-specific examples for Claude, ChatGPT, Claude Code, Cursor, Codex, generic
  MCP, cURL, JavaScript, and Python.
- [ ] Publish and smoke-test `@kasitek/mcp` only after its package contract and authentication path
  are stable.
- [ ] Add API reference links, OpenAPI, identifiers, errors, approvals, and idempotency guidance.
- [ ] Run local and hosted smoke checks with at least one real hosted client and one stdio client.

**Exit:** a new developer can connect and perform a safe read using only the Developers section and
linked documentation.

### Phase 5 — Controlled release

- [ ] Enable the Developers section for the controlled test workspace/user profile.
- [ ] Keep payment/plan enforcement disabled as previously approved.
- [ ] Keep effect approvals, audit, rate limits, isolation, and kill switches enabled.
- [ ] Review credential use, failed authentication, revocation, and tool activity evidence.
- [ ] Record remaining gaps in `BLOCKERS.md` or this checklist.

**Exit:** the setup path is usable, observable, reversible, and bounded.

## Explicitly out of scope for the first implementation

Do not add these while implementing this checklist unless a new scope decision is recorded:

- [ ] Public plugin marketplace or plugin submission workflow.
- [ ] A new hosted agent runtime or visual workflow builder.
- [ ] White-label Developers UI in `tenant-portal`.
- [ ] Broad SDK generation before the REST contract is stable.
- [ ] Direct database access from MCP, the MCP package, or public REST.
- [ ] Combining the full REST API client/SDK into the MCP package. REST remains a separate transport
  and programmatic integration surface unless a later CLI decision intentionally unifies commands.
- [ ] Generic unrestricted `execute` or `write` tools.
- [ ] API-key access to secrets, billing mutation, organization role management, or workspace
  deletion.
- [ ] Removing approval, idempotency, receipts, audit, rate limits, or revocation for convenience.
- [ ] Replacing the Agent Platform capability registry with transport-specific tool definitions.
- [ ] A second credential store that duplicates installation credentials without an approved reason.

## Definition of done

This checklist is complete only when all of the following are true:

- [ ] Developers is a discoverable, authorized workspace product area.
- [ ] A workspace user can create, copy once, rotate, revoke, and inspect a named developer key.
- [ ] REST authentication works through an explicit supported principal and stable `/v1` contract.
- [ ] MCP setup works for the supported client path and resolves to an active external installation.
- [ ] No MCP/REST transport read-write selector is required.
- [ ] Capability, resource, availability, approval, idempotency, audit, usage, and kill-switch
  behavior remain enforced.
- [ ] Local and hosted setup instructions use the correct environment-specific endpoints.
- [ ] A supported hosted AI client and a supported local stdio client can discover the server and
  tools without a secret being pasted into a prompt or committed to the repository.
- [ ] At least one safe read, one draft, one approval-required action, and one revocation path have
  runtime evidence.
- [ ] Client, Agent, Core, migration, contract, security, and secret-scan verification has passed or
  each remaining gap has explicit evidence.
- [ ] Documentation and generated setup snippets match the deployed behavior.
- [ ] No unrelated plugin, SDK, tenant, billing, provider, or agent-runtime work was pulled into the
  slice without a recorded scope decision.

## Change-control rule

If implementation reveals a need for a new principal type, a new credential store, direct long-lived
MCP API-key acceptance, OAuth, a plugin package, a CLI package, or tenant-platform changes, pause and
add the decision to the open-items section before coding it. Do not solve a product-policy question
by silently expanding the implementation.

## Open decisions and blockers

- [ ] Final workspace roles allowed to manage Developer keys.
- [ ] Whether key environments are `test`/`live`, `development`/`production`, or another vocabulary.
- [ ] Key expiry default and maximum lifetime.
- [ ] Whether one Developer key can link to multiple external installations.
- [ ] Whether MCP OAuth is required for first release or follows short-lived exchange.
- [ ] Whether public REST workspace API-key support is first-release scope or a separate API milestone.
- [ ] First supported client-specific “Connect/Add to” flows and the required OAuth/connector
  behavior for each client.
- [ ] Whether the REST SDK and CLI are separate follow-up packages, or whether a later CLI unifies
  REST and MCP commands without merging their transport implementations.
- [ ] Whether `@kasitek/mcp` should be published as a standalone package or under a broader
  `@kasitek/cli` package with an `mcp` subcommand.
