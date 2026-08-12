# Agent system implementation progress: slices 2–7

This record is intentionally narrower than the blueprint completion checkboxes. A checkbox is only
marked when the complete deliverable and its verification exist.

## Implemented evidence

- Installation credential records use copy-once scrypt hashes and support rotation/revocation:
  `9f7203d`.
- Installation resource/connector grants and capability discovery are organization- and
  installation-scoped: `5745184`, `b3830c8`.
- Agent invocations can issue short-lived ES256 delegations and kasitek-core verifies issuer,
  audience, expiry, subject, organization, installation, and capability claims:
  `d3c9648`, `ba7458c`.
- Durable external-effect receipts and single-use approval records have migrations and repository
  transitions, including reconciliation-required outcomes: `82ebdb0`, `63a90f7`.
- The Agent Platform has a stateless MCP gateway process, scoped MCP tool discovery/call transport,
  and gateway forwarding tests: `e90661c`, `75f051e`.
- Provider-neutral connector manifests, canonical Telegram/Discord inbound envelopes, and delivery
  adapter boundaries are implemented and unit tested: `6e40567`, `b8e1c50`.
- Core action metadata and typed content adapters cover content listing, draft creation, and publish
  policy metadata without bypassing normalized request context: `440cf2f`, `e1d431a`.

## Verification evidence

Agent Platform `pnpm test && pnpm build` currently passes with 30 test files passing, 9 integration
files skipped because no local database/provider stack is configured, and 85 tests passing. Core
capability tests and `cargo check -p kasitek-core` pass. The skipped integration environment and
existing database/Temporal integration environment remains recorded in the root `BLOCKERS.md`.
Client lint/typecheck/build and admin lint/build now pass; admin lint reports existing warnings.

## Remaining work

The gateway deployment wiring, public Rust `/v1` route split, complete content handler transport,
provider sandbox runs, admin operator delegation/read models, and full UI/production verification
remain unchecked in the blueprint until implemented and run in their target environments.
