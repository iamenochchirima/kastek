# Agents implementation status

Updated: 2026-10-17.

This page records verified behavior in the current checkout. The [platform architecture](architecture/agent-platform-architecture.md)
describes the target system and the remaining runtime decisions.

## Current product journey

The first UI slice centers on a support assistant:

`Agents → Create agent → Configuration → Test → Deploy → Website`

- `/app` opens `/app/agents`. New agents start at `/app/agents/new`.
- Creation makes a customer-service agent and a private Test installation. It does not create a Live website installation.
- Configuration edits the saved draft. Test selects a saved version for private runs.
- Website publication is an explicit action. It pins a tested version to one website installation.
- Old Studio and Playground URLs redirect to the matching agent flow. Existing personal and external records remain available through a compatibility section.
- The primary navigation contains Agents, Inbox, Knowledge, and Settings. Unfinished destinations are not promoted into the main journey.

These UI changes do not alter backend authorization. Browser requests use Agents-owned sessions,
workspace membership, scoped API handlers, and same-origin checks for mutations. The browser
does not receive service credentials.

## Current runtime and target

The current service uses a TypeScript and Fastify API, PostgreSQL, and a Temporal worker for
durable business-agent runs. Simple runs can execute inside the API.

The target architecture selects self-hosted Restate for business-agent durable execution, with a
PostgreSQL outbox handoff. The Restate runtime and handoff are not implemented or accepted here.
Personal assistance may use a versioned adapter to an isolated Lina runtime; that integration is
also not implemented. Temporal behavior documents the current service only and does not satisfy
the target runtime gate.

## Verification status

On 2026-10-17, the web typecheck, build, and agent lifecycle test passed. API typecheck and the
focused creation, deployment, and browser-route tests passed (15 tests); REST/MCP conformance
passed four tests with one skipped. The web build emitted a chunk-size warning for a bundle just
over 500 KB. The full API suite was not rerun; its previous run had one unrelated Discord retry
assertion failure because the response omitted `provider_message_id`.

The latest authenticated browser run created a support agent and reached its Test run through
Temporal, then ended with `MODEL_CREDENTIAL_MISSING`; it did not verify a model reply. Website
creation now initializes the default binding, and focused tests pass. Authenticated preflight and
publication have not been rerun after that fix. The local API and gateway were not running during
this verification pass. Earlier model-reply evidence predates this slice. No current model reply,
successful publication, Restate acceptance, or production deployment is claimed for this
checkpoint.

`git diff --check` and local relative-link checks across 58 changed Markdown files passed.

## Related contracts

- [Standalone login and session contract](architecture/platform-login.md)
- [Current workflow execution contract](architecture/workflow-execution.md)
- [Target architecture summary](architecture/agent-platform-architecture.md)
- [Tenant isolation inventory](architecture/tenant-isolation-inventory.md)
- [Web routes and local setup](../web/README.md)
