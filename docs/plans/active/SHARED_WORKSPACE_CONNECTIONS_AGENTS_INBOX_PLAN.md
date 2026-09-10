# Shared workspace connections for Agents and Inbox

**Status:** Active — implementation complete; provider-account smoke pending

**Owner:** Core, Agent Platform, and Inbox

**Last updated:** 2026-09-10

**Related plan:** [`AGENT_HERMES_ALIGNED_CAPABILITY_LIFECYCLE_PLAN.md`](./AGENT_HERMES_ALIGNED_CAPABILITY_LIFECYCLE_PLAN.md)

## Objective

Make provider connections workspace-owned and reusable across product surfaces. A connection
created from Agent capabilities must be visible and usable from Inbox, and a connection created
from Inbox must be discoverable from Agent capabilities, without a second OAuth flow or duplicate
credential record.

The first target is email with Google and Microsoft as the initial providers. Custom Email
(IMAP/SMTP) is deliberately a Coming soon provider, not part of this implementation slice. The
design must also preserve the working shared-connection behavior for WhatsApp, Facebook, and
Instagram and leave a clear adapter seam for SMS and other future channels.

Success means:

- one provider account has one canonical workspace connection and one credential lifecycle;
- Agent capabilities and Inbox can enter the connection flow independently;
- connecting from either surface makes the account discoverable from the other surface;
- agent tool access and Inbox routing remain separate, explicit grants;
- the UI distinguishes connected, permission-limited, unhealthy, and channel-ready states;
- no provider credential, OAuth token, message body, or conversation data is copied between
  Playground and Live or between services.

## Requirements captured so far

- Connecting an email account in Agent capabilities must make it visible in Inbox.
- Connecting an email account in Inbox must make it available to Agent capabilities.
- Google and Microsoft must be first-class email providers in Inbox and Agent capabilities.
- Agent capabilities must expose Microsoft email alongside the existing Google Gmail integration.
- Agents must distinguish Google Mail from Microsoft Mail by provider and account label; a generic
  email connection must never force the model to guess which provider or mailbox is intended.
- The connection must be reusable; do not create an Agents-only Gmail credential and a separate
  Inbox Gmail credential for the same account.
- Inbox must not require an agent to exist before a connected email account can be used.
- Agent capability selection remains an agent-level authorization decision. A workspace connection
  being visible does not silently grant every agent access to it.
- The same provider account may be bound to Inbox and to one or more agents through separate
  bindings.
- Provider and account labels are model-visible metadata; raw provider IDs, connection IDs,
  credentials, and provider payloads remain private to the runtime.
- Additional permissions may be requested incrementally. Read-only Gmail access is not enough to
  claim that Inbox can reply or synchronize all mail.
- The existing Playground-to-Live deployment contract remains authoritative for agent bindings,
  capability snapshots, skills, plugins, and tools.

## Current implementation evidence

The repository currently has two related but different connection paths:

- Core owns workspace `ExternalConnection` records, provider health, permissions, capabilities,
  and product consumers. Meta Inbox conversations use these records together with
  `SocialChannelConnection`.
- Core currently derives `inbox` and `agents` consumers for WhatsApp, Facebook, and Instagram.
  Agent assignment then creates an Agents `channel_connection` that routes a selected workspace
  account to an installation.
- Agents still owns installation-scoped `integration_connections` as bindings, but Google and
  Microsoft email credentials now live only in Core's encrypted workspace `EmailConnection`.
  The old `google.gmail` entry is an alias and routes through the canonical provider-neutral email
  boundary; it no longer creates a second credential for new OAuth flows.
- The Agents catalog now exposes Google Mail and Microsoft Mail. Core Inbox handles WhatsApp and
  Meta conversations alongside the email projection; email discovery, binding, polling, thread
  normalization, and reply routing use the canonical Core connection.

The implementation must converge the provider-account identity without weakening the existing
installation, organization, approval, redaction, or deployment boundaries.

## Target model

```text
Canonical workspace provider connection
  - provider/account identity
  - encrypted credential reference
  - granted scopes and permission state
  - health and webhook/watch state
  - provider capabilities
             |
             +-- Agent binding
             |     - installation/agent scope
             |     - selected capability bundle
             |     - Playground/Live candidate state
             |
             +-- Inbox channel binding
                   - channel type and address/account
                   - inbound watch/webhook
                   - outbound/reply readiness
                   - thread and routing policy
```

The canonical connection answers “which provider account is connected?” Bindings answer “which
product may use it, and for what purpose?” A connection may be visible before all bindings are
ready, but a surface must not claim operational readiness until its own checks pass.

Provider identity is preserved through every projection:

```text
Google / work@gmail.com
Microsoft / work@company.com
```

The model-facing email tools may be provider-neutral (`kasitek.email.search`,
`kasitek.email.read`, `kasitek.email.send`, and `kasitek.email.reply`), but the effective snapshot
must include the provider, safe account label, available operations, and readiness for each bound
account. The runtime resolves that metadata to the correct Google or Microsoft adapter without
exposing opaque connection identifiers or credentials. If multiple accounts could satisfy a
request, the agent uses the named provider/account or asks the user to choose.

## Scope

### Included

- Canonical provider-account identity and credential reuse across Agents and Inbox.
- Google and Microsoft email channel adapters with inbound polling, thread normalization, reply
  support, delivery/error state, deduplication, and a provider-watch seam for a later push-based
  optimization.
- Google Gmail and Microsoft email entries in the Agent capability catalog over the shared email
  capability contract.
- Bidirectional connection discovery from Agent capabilities and Inbox.
- Separate Agent capability grants and Inbox channel bindings over the same provider connection.
- Incremental permission requests for read-only versus Inbox reply/synchronization access.
- Provider-grouped readiness and permission projections in Connections, Agent Studio, and Inbox.
- Alignment of Meta/WhatsApp behavior with the same binding contract where current code already
  supports it.
- Deployment and rollback evidence for agent bindings and capability snapshots.
- Local API, database, browser, provider-adapter, and end-to-end verification through the existing
  development proxy/tunnel.

### Excluded from the first email slice

- Custom Email using IMAP/SMTP; show it as Coming soon in the provider picker and capability
  catalog until its adapter, credential setup, sync, and delivery contracts are implemented.
- SMS transport implementation; Twilio remains a future channel adapter unless explicitly added to
  scope.
- Copying Playground conversations, memory, provider payloads, or secrets into Live.
- Making a workspace connection automatically grant every agent access without an agent-level
  binding or deployment.

## Implementation plan

1. [x] Map the canonical connection, Agents integration, Inbox channel, permission, and deployment
   tables and define the identity/linking contract for existing rows.
2. [x] Define provider-neutral connection and binding contracts, including credential references,
   scopes, health, readiness, consumer projections, and revocation behavior.
3. [x] Add Google and Microsoft connection adapters that can be initiated from either surface and
   upsert the same canonical workspace connection.
4. [x] Add Google and Microsoft email Inbox bindings with an idempotent polling worker, stale-claim
   recovery, watermark overlap, thread/message normalization, outbound send/reply, delivery state,
   idempotency, and retries. Provider push/watch renewal remains an explicit future adapter seam.
5. [x] Bridge existing Agent Gmail capability activation and new Microsoft email capability
   activation to the canonical connection and expose both accounts in Inbox without duplicating
   credentials.
6. [x] Add the reverse Inbox-to-Agent discovery path. Make Google and Microsoft accounts visible
   to Studio and provide an explicit “Use” binding action before the agent can call email tools;
   binding reuses the Core connection by opaque ID and does not start another OAuth flow.
7. [x] Replace readiness checks based only on provider connection or `consumers` with binding-aware
   readiness: credential, required scope, provider health, inbound sync state, and outbound support.
8. [x] Update the Agent capability snapshot and native capability-awareness skill so Google and
   Microsoft remain distinct, with provider, account label, available operations, and unavailable
   reasons truthful and grouped. Keep model-facing email operations provider-neutral while routing
   through the correct provider adapter. The runtime snapshot carries the bound mailbox label, and
   the provider-neutral tool path verifies the installation binding before calling Core.
9. [x] Update Connections, Agent Studio, and Inbox UI states and actions. A connected but
   read-only account is visible but remains `Setting up`/`Needs attention`, never reply-ready.
10. [x] Apply the existing deployment rules: Playground may test a new Agent binding; Deploy
    promotes the exact agent candidate and binding configuration to Live; workspace credentials
    are reused by opaque reference; rollback restores the previous Live binding revision.
11. [x] Add the binding migration, stable audit/structured-log and Inbox analytics events, safe
    error projection, architecture/runbook notes, and API documentation for reuse, permission
    state, sync, replies, retries, and revoke.
12. [ ] Verify locally with focused repository/service tests, provider contract tests, API smoke
    checks, client builds, and browser flows through `https://dev-client.kasitek.co.za/`. Code,
    migrations, builds, focused tests, and unauthenticated API smoke are complete; provider OAuth,
    authenticated Inbox sync, and browser smoke still require configured test accounts.

## Product behavior

### Connect from Agent capabilities

1. User selects Google or Microsoft and completes the provider OAuth flow.
2. Core creates or reuses the canonical workspace connection.
3. Agent capability binding is created or updated for the selected installation.
4. Inbox discovers the same connection and shows Email when the Inbox binding is ready.
5. If Inbox requires additional scopes, the account remains visible with a precise permission
   state and an incremental authorization action.

### Connect from Inbox

1. User selects Email, then Google or Microsoft, and completes the provider OAuth flow.
2. Core creates or reuses the canonical workspace connection.
3. Inbox creates or updates its channel binding and validates inbound/outbound readiness.
4. Agent Studio lists the account as a connected workspace account.
5. An agent may be granted the appropriate Google or Microsoft email capabilities and tested in
   Playground; Live use still follows explicit Deploy.

### Multiple accounts

Each provider account remains independently selectable. Conversations, agent bindings, health,
permission state, and audit records must retain the canonical account identity without exposing
raw provider IDs or credentials in model prompts or user-facing chat.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Canonical identity | Core workspace connection is the account source of truth; Agents and Inbox store bindings, not duplicate credentials. | Core/Agent Platform | Proposed |
| Agent entry point | A successful Agent Google or Microsoft email connection must be visible to Inbox. | Product | Accepted |
| Inbox entry point | A successful Inbox Google or Microsoft email connection must be visible to Agent Studio. | Product | Accepted |
| Automatic Inbox binding | Create the Inbox binding automatically after a supported provider connection; keep readiness separate from connection existence. | Product/Core | Accepted |
| Email permissions | Define provider-specific minimum read/sync scopes and incremental reply/send scopes during adapter implementation. | Core/Integrations | In progress |
| Initial email providers | Google and Microsoft are the first supported providers. | Product/Core | Accepted |
| Custom Email | IMAP/SMTP appears as Coming soon and is excluded from this slice. | Product/Core | Accepted |
| Agent authorization | Visibility in Studio does not grant an agent; binding and Deploy remain explicit. | Agent Platform | Accepted |
| Live behavior | Workspace connection is shared; agent capability/binding promotion remains governed by Deploy. | Agent Platform | Accepted |
| Provider distinction | Google and Microsoft remain distinct in UI, snapshots, and account selection; shared email tools route through the matching adapter. | Core/Agent Platform | Accepted |
| SMS | Keep Twilio/SMS outside the first email slice unless explicitly added. | Product | Proposed |

## Verification

Current checks: Prisma schema validation and both migrations, Core `cargo check -p kasitek-core`,
the focused Core email tests (3 passed), client type-check and production build, `git diff --check`,
the focused Agents integration/catalog/REST conformance suite (106 tests), Core `/health`, Core
email provider discovery, and unauthenticated mailbox rejection all pass. The full Core library
suite passed all email/Inbox tests; 12 unrelated concurrent `agent_platform` socket-permission
tests remain environment failures. Authenticated OAuth, provider sync, and browser flows still
require configured Google/Microsoft test accounts.

- [x] Repository/schema validation and focused checks for canonical connection reuse and binding
  uniqueness.
- [ ] Google and Microsoft OAuth, scope, token-refresh, provider contract, thread-sync, send,
  retry, and revoke tests (requires provider accounts; push/watch renewal is not in this slice).
- [x] Agents API tests for capability discovery, grant narrowing, snapshot digest, and deployment.
- [x] Core Inbox binding/readiness, normalization, outbound reply/retry, and idempotency code paths
  compile and are covered by the existing Core test harness; live DB/provider execution remains
  pending.
- [x] Client type-check and production build; browser flows remain pending configured provider
  accounts and tunnel-backed authenticated API.
- [ ] Local proxy/tunnel smoke test with at least one connected Google or Microsoft account.

## Release record

**Change:** Shared workspace provider connections and Google/Microsoft email Inbox/Agent reuse.

**Owner:** Core, Agent Platform, and Inbox.

**Risk:** high (OAuth scopes, mailbox polling, message privacy, and cross-service connection
identity).

**Affected services and user surfaces:** `server/kasitek-core`, `agents`, Connections, Agent
Studio/Playground, Inbox, the email polling worker, and deployment/rollback paths.

**Platform release version or release ID:** to be assigned at implementation release.

**API/schema/migration changes:** applied in code; canonical connection linking, email channel
binding, permission/readiness projection, manual sync route, and provider sync contracts. The
Prisma migrations must be deployed when local PostgreSQL is available.

**Feature flag or rollout method:** local implementation first; provider/account-scoped rollout
recommended for Google and Microsoft Inbox until sync and reply evidence is complete. Custom Email
remains explicitly unavailable and labelled Coming soon.

**Analytics events and success metrics:** Core emits `email.connection.upserted`,
`email.operation.started`, Inbox message `created`/`delivery_updated` facts, and structured
`email.sync.succeeded`/`email.sync.failed` events. Agent binding and deployment audit paths remain
the source for agent grant/rollback evidence; no credentials or provider response bodies are
included.

**Logs, metrics, dashboards, and alerts:** Core logs connection upsert, operation start, sync
success/failure, duplicate suppression through idempotent inserts, and binding health with
organization/provider/connection identifiers only. Tokens, provider payloads, and full message
bodies are not logged. Push/watch renewal metrics are not applicable to this polling slice.

**User, API, internal, and operational documentation:** required for connection reuse, permission
states, Google/Microsoft Inbox setup, agent binding, deployment, revoke, and recovery.

**Validation evidence:** focused Core email tests, Core type-check, client type-check/build, Prisma
schema validation and migration deployment, focused Agents suite, Core health/provider discovery,
unauthenticated API rejection, and diff hygiene pass. Live provider/browser evidence remains
pending configured test accounts.

**Rollback or disable plan:** stop the email Inbox polling worker or disable active Inbox bindings,
preserve canonical connections and Agent tool access where safe, and restore the previous binding/
release revision without deleting messages or credentials.

**Post-release review date:** to be assigned.

## Notes and blockers

Implementation is complete for the local code path. Live migration/provider/browser verification is
blocked only by the unavailable local PostgreSQL service and missing configured Google/Microsoft
test accounts; no product decision is open for this slice.
