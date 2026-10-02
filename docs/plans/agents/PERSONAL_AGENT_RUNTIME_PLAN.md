# Personal agent runtime plan

Updated: 2026-10-02.
Status: Planned. Separate runtime implementation; platform integration is Phase 7 of the [delivery plan](AGENT_PLATFORM_DELIVERY_PLAN.md).

## Scope

Build our own filesystem-based agent, with a persistent workspace for files, instructions, skills, memory and session material. The Agents platform deploys and manages it and connects authorized tools and channels. Hermes/OpenClaw are inspiration; adopting either project or choosing the runtime language is not approved by this document.

## Runtime foundation

- [ ] Choose the runtime language, source location and release ownership before implementation. Define a versioned runtime image/configuration independent of platform server releases.
- [ ] Define workspace layout and ownership for instructions, skills, files, memory and session history. Specify the persistent data and format/version evolution; platform secrets must not live in editable instructions.
- [ ] Implement a bounded model/tool loop with scoped filesystem access, context management, tool results, deadlines, cancellation and usage reporting.
- [ ] Implement local file operations and skill loading, treating file and tool content as data rather than permission authority.
- [ ] Define the task acceptance, status/events, artifacts, cancellation, readiness and restart interfaces. Authenticate both directions and reject incompatible protocol versions.
- [ ] Define duplicate delivery, task ownership and interrupted-run recovery. State when replay is safe, when work fails, and how uncertain external actions are reconciled.

## Platform integration

- [ ] Build scoped tool invocation for platform tools, external connections and later Growth/Agency tools. Do not grant cross-product access merely from shared login.
- [ ] Deploy a versioned runtime into one local isolated environment with persistent workspace storage and scoped communication credentials.
- [ ] Route one existing platform channel to the deployment. Define authoritative personal conversation history and platform projections without conflicting writers.
- [ ] Connect platform controls for deployment/configuration, start/stop/restart, activity, files/artifacts and usage. Establish idle/wake behavior separately from task cancellation.
- [ ] Define workspace backup/export/delete, resource limits, network policy and credential revocation. Select production hosting/isolation before accepting customer code.

## Minimum proof

- [ ] Deploy one runtime, connect one channel and one tool, complete a real task and show its recorded result and usage.
- [ ] Restart and retain declared workspace files/memory; accurately report the fate of interrupted work.
- [ ] Deny another deployment's files/tools and reject duplicate task execution.
- [ ] Stop/cancel work and enforce runtime resource limits; remove deployment data through the declared deletion path.

No runtime code, production sandbox vendor, Kubernetes configuration or customer deployment is created by this planning document. Add the chosen runtime's own dependency references when its implementation is selected.
