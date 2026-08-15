# Temporary Agent Platform Unblocked-Work Checklist

**Created:** 2026-08-15

**Purpose:** Track implementation that can be completed and verified with the repository's local
PostgreSQL, Temporal, Rust, and TypeScript test environments. This is an execution aid, not a
replacement for the canonical blueprint or audit checklist.

## Operating rules

- Keep the canonical blueprint and audit checkboxes unchanged unless the complete parent item's
  implementation and verification gates pass.
- Record local evidence here even when a parent item also requires a provider, browser, hosted, Redis,
  external-client, or product-policy gate.
- Do not implement unsupported public principals or approval-role policy by inference.
- Preserve unrelated worktree changes and stage only files owned by this batch.

## Batch A — core contract convergence

- [x] Inventory every currently enabled bounded domain operation and its product, public REST, and
  private delegated adapter.
- [x] Add shared contract assertions for operation identity, organization/actor context, resource
  scope, validation, idempotency, approval classification, and error mapping.
- [x] Exercise every bounded capability handler against the typed Core boundary contract. This is
  transport/client contract evidence; a seeded Core database run remains a separate follow-up.
- [ ] Record missing operations as implementation gaps; do not mark the broad Slice 3 ownership row
  complete until transactional outbox, provider idempotency, effect receipts, and lifecycle events
  are all verified.

**Canonical mapping:** Blueprint Slice 3 deliverable and verification rows.

## Batch B — durable MCP/REST behavior parity

- [x] Run equivalent MCP and installation-REST invocations through the shared acceptance service for
  bounded content, contacts, inbox, templates, bookings, campaigns, and reporting operations.
- [x] Assert matching authorization, operation/run, tool-evidence, installation context, and argument
  outcomes while
  allowing protocol-specific envelopes.
- [ ] Assert durable effect-receipt and audit convergence for local approval-gated operations.
- [ ] Add duplicate, rejection, cancellation, and cross-organization isolation cases.
- [ ] Keep unsupported workspace API-key, service-account, and OAuth principal rows explicitly open.

**Canonical mapping:** Blueprint Slice 7 REST/OpenAPI conformance and MCP/REST behavior-parity rows.

## Batch C — service-level admin authorization and incident checks

- [x] Cover viewer, support, operator, security, admin, and owner authorization at the service/API
  boundary using the existing policy matrix.
- [x] Verify organization/resource isolation, redaction, command idempotency, support-grant expiry,
  and dual-control command denial/approval paths.
- [x] Run a local incident-signal drill covering reconciliation, failed runs/deliveries, provider
  failures, credential revocation, and sensitive-data access recovery. Full seeded projection/effect
  recovery remains a follow-up.
- [x] Run Core, Agent, typecheck, format, and build verification for the completed batch.
- [ ] Leave browser-based role E2E and hosted deployment evidence open as separate gates.

**Canonical mapping:** Blueprint Slice 12 admin verification and incident-drill rows.

## Deferred external or policy gates

- [ ] Live WhatsApp/Telegram/Discord/provider sandbox effects and recovery.
- [ ] Authenticated cross-browser client/admin smoke tests.
- [ ] Hosted gateway/scaling smoke and real Codex/Claude/n8n client verification.
- [ ] Redis multi-instance/restart/expiry replay verification.
- [ ] Workspace API-key, service-account, and OAuth principal support.
- [ ] Approval actor/resource role matrix and production entitlement/quota policy.

## Evidence log

| Date | Batch | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-15 | Baseline | Agent local PostgreSQL + Temporal suite: 61 files / 257 tests; Core library suite: 132 passed / 3 ignored | Existing baseline; new work pending |
| 2026-08-15 | Batch A | `agents/test/core-capability-adapter-contract.test.ts`: all 22 bounded Core-owned capabilities route through typed handlers; corrected list/update/delete output schemas | 2 tests passed |
| 2026-08-15 | Batch B | `agents/test/rest-mcp-local-parity.test.ts`: nine bounded reads through MCP and installation REST share acceptance, run lifecycle, context, and tool-evidence paths | 2 tests passed |
| 2026-08-15 | Batch B | `agents/test/rest-mcp-durable-parity.integration.test.ts`: PostgreSQL-backed MCP/REST parity persisted 18 completed runs, 18 completed tool invocations, and matching lifecycle events | 1 integration test passed |
| 2026-08-15 | Batch C | `agents/test/operator-projections.test.ts`: incident signal generation and recovery-clear path; existing Core role matrix and Agent command tests retained | Focused tests passed |
| 2026-08-15 | Verification | Agent build; full Agent suite with PostgreSQL + Temporal: 64 files / 263 tests / 0 skips; Core fmt/check/lib: 132 passed / 3 ignored | Green |
