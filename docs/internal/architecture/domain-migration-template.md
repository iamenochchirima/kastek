# Core domain migration template

Use this template for each domain moved behind the normalized core boundary. A migration is only
complete when the product adapter and at least one non-product adapter use the same domain
operations, the old transport contract is preserved or versioned deliberately, and the evidence
below is committed.

## 1. Ownership and scope

- Domain name and owning service.
- Product routes and response/status contracts that must remain compatible.
- Public REST, internal capability, MCP/Agent, webhook, worker, and admin surfaces in scope.
- Organization, workspace, installation, resource, and customer ownership rules.
- Explicitly deferred provider or infrastructure verification, linked to `BLOCKERS.md` when it is
  genuinely unavailable.

## 2. Domain layer

- `model.rs`: domain records and value objects only; no Actix types or request headers.
- `commands.rs`: typed mutations, validation, idempotency, and transaction boundaries.
- `queries.rs`: organization/resource-scoped reads and pagination.
- `policy.rs`: principal, grant, ownership, state-transition, and conflict checks with pure tests.
- `postgres.rs` (or provider adapters): SQL and external calls only; every query carries the
  resolved organization/resource scope.
- `transport.rs`: request/response DTOs and wire compatibility, separate from persistence rows.

## 3. Adapters

- Product adapter resolves `RequestContext` from the product session and maps the legacy envelope.
- Public REST adapter resolves its approved principal, re-checks live grants/scopes, and maps the
  versioned contract.
- Internal capability adapter resolves delegated identity, checks the capability/version, and
  calls the same command/query function without duplicating SQL or policy.
- Agent/MCP adapters use the manifest registry and preserve idempotency, approval, audit, and
  redaction metadata.

## 4. Verification gate

- Pure unit tests for normalization, validation, policy, state transitions, conflicts, and scope.
- Product-versus-internal response/behavior parity tests with distinct authentication envelopes.
- Route inventory and status/response contract regression tests.
- Database tests for organization isolation, transactional outcomes, duplicate/replay behavior,
  and provider callback ordering where a seeded database or sandbox is available.
- Typecheck/build/lint/format commands for every touched runtime.
- Evidence entry naming changed paths, preserved contracts, commands run, skipped gates, commit, and
  the next unchecked item. Update the blueprint count only after the full checkbox gate passes.

## 5. Completion checklist

- [ ] Domain files and transport DTOs are separated from global persistence models.
- [ ] Product and non-product adapters call the same domain operations.
- [ ] Organization/resource/principal isolation is enforced in policy and SQL.
- [ ] Idempotency, audit, approval, receipts, and provider effects are explicit where applicable.
- [ ] Required tests and builds pass; unavailable infrastructure is recorded as a genuine blocker.
- [ ] Blueprint, audit count, progress evidence, and commit references are updated.

## Dependency order after bookings

1. Contacts/customers — shared identity and ownership are prerequisites for conversations and
   bookings.
2. Connections — provider credentials and channel ownership feed every communication domain.
3. Content/social posts — reuses connections and establishes publish/provider receipt patterns.
4. Campaigns — depends on customers, connections, content, and delivery policy.
5. Conversations/inbox — depends on customers, connections, message identity, and delivery receipts.
6. Social providers/publishing — split provider adapters after the content operation boundary is
   stable.
7. WhatsApp — split connections, contacts, templates, campaigns, inbox transport, webhooks, calls,
   and delivery workers after the shared messaging contracts exist.
8. Billing — move reconciliation and entitlement effects after usage/audit contracts are stable.
9. Auth/admin — migrate last because it governs cross-domain operator and support access.

Change this order only with a documented dependency or security reason in the progress record.
