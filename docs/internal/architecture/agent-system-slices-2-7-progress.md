# Agent system implementation progress: slices 2–7

This record is intentionally narrower than the blueprint completion checkboxes. A checkbox is only
marked when the complete deliverable and its verification exist.

## Implemented evidence

- Installation credential records use copy-once scrypt hashes, MCP scopes, token exchange, and
  rotation/revocation. MCP requests validate the ES256 installation token against the current
  credential and installation: `9f7203d`, `48b16bf`.
- Installation resource/connector grants and capability discovery are organization- and
  installation-scoped: `5745184`, `b3830c8`.
- Agent invocations can issue short-lived ES256 delegations and kasitek-core verifies issuer,
  audience, expiry, subject, organization, installation, capability, argument-hash, and
  idempotency claims. Replay prevention uses Redis atomic `SET NX`, not process memory:
  `d3c9648`, `ba7458c`, `ac738b0`, `14e2892`.
- Durable external-effect receipts and exact single-use approval records have migrations and
  repository transitions, including reconciliation-required outcomes. Approval decisions require
  `runs:approve`, and effects stay reserved until execution: `82ebdb0`, `63a90f7`, `e94e16a`,
  `ad7e0ec`, `7508423`, `7ecc36a`.
- The Agent Platform has a stateless MCP gateway process, installation-scoped MCP discovery/call
  transport, gateway authentication hardening, and durable MCP runs: `e90661c`, `75f051e`,
  `5d3787e`, `1c95d9c`.
- Provider-neutral connector manifests, canonical Telegram/Discord inbound envelopes, and delivery
  adapter boundaries are implemented and unit tested: `6e40567`, `b8e1c50`.
- Core action metadata and typed content adapters cover content listing, draft creation, and publish
  policy metadata without bypassing normalized request context: `440cf2f`, `e1d431a`.

## Verification evidence

On 2026-08-13, Agent Platform migration `027` through `032` applied to the local Agent PostgreSQL
database. With `RUN_AGENTS_DB_INTEGRATION_TESTS=true`, `pnpm test` passed 39 files / 113 tests, and
`pnpm build` passed. `cargo fmt --check`, `cargo check -p kasitek-core`, and
`cargo test -p kasitek-core --lib` passed (61 tests passed; 2 database tests intentionally ignored).
Temporal recovery, browser, externally hosted MCP, provider sandbox, and the full frontend/admin
matrix remain release gates and are tracked in the canonical checklist and `BLOCKERS.md`.

## Remaining work

The gateway deployment wiring, public Rust `/v1` route split, complete content handler transport,
provider sandbox runs, admin operator delegation/read models, and full UI/production verification
remain unchecked in the blueprint until implemented and run in their target environments.
