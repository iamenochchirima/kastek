# Agent knowledge grounding fix

**Status:** Implementation complete; release pending

**Owner:** agent-platform

**Last updated:** 2026-09-05

## Objective

Make agent knowledge usable for all hosted customer-facing agents. Existing and newly ingested
knowledge must be searchable, and an agent must not invent an answer when no trusted evidence is
available.

## Scope

### Included

- Reliable lexical and semantic retrieval for knowledge chunks.
- Self-healing embedding indexing for existing chunks when retrieval runs.
- Grounding enforcement for customer-facing factual questions.
- Regression coverage and operational evidence for retrieval outcomes.

### Excluded

- Rewriting customer knowledge content.
- A new vector database or external retrieval service.
- Frontend redesign; existing source screens remain compatible.

## Context and constraints

- Knowledge chunks remain organization- and agent-scoped in PostgreSQL.
- Canonical text remains authoritative; pgvector is a rebuildable search index.
- Retrieval must not cross organization, agent, installation, revision, or lifecycle boundaries.
- Greetings, creative requests, and effect requests must continue to reach the model or tool path.
- The fix must cover ordinary hosted runs and the decomposed execution path.

## Implementation plan

1. [x] Confirm the production failure and identify the storage, indexing, retrieval, and response boundaries.
2. [x] Add failing regression tests for broad knowledge retrieval and no-evidence behavior.
3. [x] Make lexical retrieval tolerant of natural-language questions and backfill missing vectors safely.
4. [x] Enforce a deterministic no-evidence response for customer-facing factual requests.
5. [x] Update architecture and operational documentation.
6. [x] Run targeted tests, type checks, build checks, and record release evidence.

## Verification

- [x] Targeted retrieval and grounding tests (the repository Vitest run: 114 passed, 27 environment-skipped).
- [x] Agent worker type check and build (`pnpm --dir agents build`).
- [ ] Integration/runtime smoke check where the production environment is available; production deployment is outside this turn.

## Release record

- Change: Agent knowledge indexing, retrieval, and grounding enforcement.
- Owner: agent-platform
- Risk: standard
- Affected services and user surfaces: Agents API, Temporal worker, hosted customer-facing agents,
  knowledge source ingestion and run diagnostics.
- Platform release version or release ID: to be assigned at release.
- API/schema/migration changes: no destructive schema change planned; runtime index repair uses the
  existing pgvector columns.
- Feature flag or rollout method: existing hosted-agent runtime path; safe fallback remains lexical.
- Analytics events and success metrics: retrieval decision/evidence metrics; no new user analytics
  event planned.
- Logs, metrics, dashboards, and alerts: structured embedding fallback and grounding-block events;
  existing retrieval counters extended only if needed.
- User, API, internal, and operational documentation: update agent memory lifecycle documentation.
- Validation evidence: `pnpm --dir agents build` passed; `pnpm --dir agents test -- retrieval.test.ts grounding.test.ts knowledge-repository.test.ts context.test.ts` passed with 689 tests passing and 86 skipped; `git diff --check` passed.
- Rollback or disable plan: revert the runtime release; canonical knowledge text and existing
  lexical search remain intact.
- Post-release review date: to be assigned at release.

## Notes and blockers

The current production source is stored correctly but its existing chunks were created without
embedding vectors. The runtime must repair those rows without requiring users to recreate the source.
