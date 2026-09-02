# Agent release coherence checklist

- [x] Source-defined KasiAi candidate is evaluated by the release gate.
- [x] Production API reconciles and rolls out the candidate before listening.
- [x] Reconciliation is idempotent across restarts and concurrent API instances.
- [x] All active protected KasiAi installations match the published candidate before startup succeeds.
- [x] Worker refuses to start when its source-defined protected-agent candidate does not match the
      published database version.
- [x] Existing run version pinning remains unchanged.
- [x] Release, rollout, and coherence failures have structured redacted logs.
- [x] Unit/regression tests pass; database integration remains environment-gated.
- [x] Agents build and deployment descriptor checks pass.
- [x] Deployment topology/runbook reflects the automatic gate and recovery command.
- [ ] Production deployment records the commit, release identity, active version, and health result.
