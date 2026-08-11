# ADR 0002: Temporal durable execution

- Status: accepted
- Date: 2026-08-11

## Decision

Each agent run is one Temporal workflow. Database reads/writes and external calls are
activities. Workflows contain deterministic orchestration only. Interactive and background
work use separate task queues, beginning with the interactive queue in the proof of concept.

The initial deployment uses Temporal Cloud. The service keeps workflow contracts free of
Cloud-only APIs so the same contracts can be run on a self-hosted Temporal deployment later.

## Consequences

Runs survive process restarts, can wait for approval or external signals, and can retry
activities without inventing a second run history. External-effect activities must be
idempotent or reconciled before they are enabled.
