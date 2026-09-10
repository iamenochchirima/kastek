# Model-first capability and grounding architecture

**Status:** Implemented — local verification passed; browser lifecycle verification remains follow-up

**Owner:** Agent Platform

**Last updated:** 2026-09-10

## Objective

Make every admitted agent turn follow one model-first execution path. The model must receive the
effective, per-agent capability projection, be allowed to choose an authorized tool when the
request needs live connected data, and receive the tool result before composing its answer. The
runtime must still prevent unsupported factual answers, unauthorized effects, and false completion
claims, but those protections must happen at the correct boundary: after model/tool selection or
at dispatch, not as a phrase-based gate before the model runs.

Success is a local end-to-end run in which a connected Google Calendar request reaches the model,
selects an authorized Calendar tool, executes it through the existing grant/readiness/approval
boundaries, returns the result to the model, and records the complete trace. A static factual
question with no trusted evidence may still be refused, but the model call and its policy reason
must be visible in the run evidence. The generic pre-model `no_trusted_evidence` short circuit must
not occur for an otherwise admitted turn.

## Scope

### Included

- Reordering the hosted run so the effective capability snapshot, context, model call, tool loop,
  and final grounding review are one coherent lifecycle.
- Removing the pre-model grounding blocker and the connected-data keyword workaround from the
  execution decision.
- Keeping one canonical registry/snapshot as the source for model schemas, provider grouping,
  skill visibility, readiness, and dispatch authorization.
- Ensuring connected services (for example Google Calendar) expose their declared capability
  bundle to the Playground model projection immediately after a successful connection, subject to
  grant/readiness checks.
- Preserving Hermes-style progressive skill discovery and the native capability-awareness system
  skill for every agent.
- Preserving dispatch-time authorization, approval, leases, kill switches, effect receipts,
  idempotency, redaction, and durable run evidence.
- Post-model grounding review, evidence provenance, observability, and local end-to-end tests.
- Updating the related internal architecture/runbook documentation and release record.

### Excluded

- Hosted staging, Railway, Cloudflare production rollout, or new deployment infrastructure. Local
  verification uses the existing runtime and `https://dev-client.kasitek.co.za/` proxy/tunnel.
- A second or legacy execution mode, implicit follow-published behavior, or a permanent compatibility
  fallback. There will be one explicit pinned candidate and one runtime path.
- Replacing Temporal, the existing durable effect/approval contracts, or the existing connection
  credential storage model.
- Copying secrets, raw provider payloads, or conversation data into capability snapshots or prompts.
- Expanding keyword lists to cover individual providers, calendars, email systems, or user wording.

## Context and diagnosis

### The current failure

`agents/src/temporal/activities.ts` builds `capabilitySnapshot`, `modelTools`, context, and the
hosted harness, but then calls `shouldFailClosedWithoutEvidence(...)` before `harness.runTurn(...)`.
For a customer-facing/system agent with no retrieval match, that branch creates the generic
`I don’t have enough approved information to answer that yet.` response, writes
`modelCallSkipped: true`, and returns with zero model tokens, zero iterations, and zero tool calls.
That is why an authorized Calendar connection can be present while the model never sees or calls
`kasitek.calendar.*`. It is an execution-order bug, not a memory-capacity problem.

`agents/src/runtime/grounding.ts` currently uses `questionStarters`, knowledge/effect term sets,
and `connectedDataTerms` to classify messages. The recent Calendar addition only changes which
phrases avoid the short circuit; it does not make the runtime model/tool aware and cannot scale to
natural language or new integrations.

The existing `effective-capabilities.ts`, `context.ts`, and `loop.ts` already contain most of the
right seams: an immutable capability snapshot, provider-grouped summaries, callable schemas,
progressive skill loading, a native capability contract, and a bounded model/tool loop. The plan
is to make that path authoritative instead of bypassing it.

### Source-grounded reference implementations

This comparison uses the checked-out source, not only documentation:

- Hermes runs `assemble_api_request`, calls the model, then dispatches either
  `run_tool_round` or `finish_text_response` in
  `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_loop.py`. Its
  `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_tool_round.py` validates and persists the
  assistant tool-call turn before side effects, then applies call-time guardrails. Its registry and
  model projection derive exact callable schemas from registered tools, toolsets, availability
  probes, and scoped overlays. Its prompt builder provides a skill index and loads full skill
  content through `skill_view` only when needed.
- Waku makes the boundary explicit in
  `/home/enoch/aworkspace/agents/waku-agent/waku/loop/agent.py`: each iteration calls the model
  with `tools.schemas()`, executes returned tool calls, appends tool results, and repeats until the
  model returns text or the iteration limit is reached. Its
  `/home/enoch/aworkspace/agents/waku-agent/waku/tools/registry.py` is a small registry/schema/
  dispatcher, and its procedural loader scans skill metadata then injects only matching bodies.
- KasiTek's existing capability research is recorded in
  [`HERMES_WAKU_CAPABILITY_AWARENESS.md`](../../research/HERMES_WAKU_CAPABILITY_AWARENESS.md).

The decision is to adopt Hermes's scoped registry/projection and progressive disclosure, with
Waku's simple, observable model → tool → result loop, while retaining KasiTek's stronger durable
authorization and effect controls. Neither reference uses a generic “question has no retrieval
evidence, therefore do not call the model” gate.

## Target lifecycle

```text
Admitted run
  -> resolve one immutable effective capability snapshot
  -> build context, capability contract, skill index/body, and exact callable schemas
  -> model call (always, unless a real admission/context/budget/provider failure exists)
       -> text response: final grounding/evidence review
       -> tool call: validate grant/readiness/policy, persist proposal, approve if required,
                    execute with lease/idempotency/effect receipt, append trusted result,
                    call the model again
  -> finalize status, response, provenance, run steps, events, and usage
```

The resulting policy is:

- A connected/live-data request is not rejected before model selection. The model sees the grouped
  provider summary and exact schemas, and the capability-awareness contract tells it to call the
  live source rather than answer from general knowledge.
- Tool calls remain untrusted proposals until registry, grant, readiness, scope, approval, and
  dispatch checks pass. A tool error is returned to the model as bounded tool evidence where the
  loop can recover; it is not converted into a fabricated success.
- A completed text response is reviewed after the loop. If a protected factual request has no
  configured knowledge, trusted memory, or successful tool evidence, the response is replaced by
  the bounded no-information response and the policy decision is recorded. This is a safety
  review, not a reason to skip the model.
- `awaiting_approval`, `awaiting_external_event`, `cancelled`, `failed`, `limited`, and provider/
  context admission failures keep their real status and error. They must never be mislabeled as a
  generic knowledge refusal.

## Implementation plan

1. [x] **Freeze the diagnosis and contracts.** Add a regression fixture for the current Calendar
   failure that asserts capability resolution succeeds while the pre-model block produces zero
   model/tool activity. Define the post-model evidence/provenance fields and status semantics
   before changing the runtime.
2. [x] **Remove the wrong decision boundary.** Delete the `shouldFailClosedWithoutEvidence` branch
   from the pre-harness path in `executeLoopForRun`. Remove `connectedDataTerms` as an execution
   escape hatch. Keep lexical intent helpers only as non-authoritative retrieval/review hints until
   the postflight contract replaces them; no phrase list may decide whether an admitted model call
   is allowed.
3. [x] **Make the model/tool loop authoritative.** Ensure every normal admitted run calls the
   shared harness with the immutable `capabilitySnapshot.model.callableTools` projection. Preserve
   actual context-window, budget, provider, installation, and cancellation gates. Ensure workflow
   subloops use the same path and cannot silently reintroduce a pre-model grounding block.
4. [x] **Strengthen the model-facing capability contract.** Project exact tool schemas plus a
   compact provider/service grouping such as `Google Calendar -> list, create, update, delete`.
   State explicitly that current connected data requires a callable tool result, schemas are the
   authoritative surface, and unavailable capabilities must be reported from snapshot reasons.
   Keep credentials, raw IDs, and provider payloads out of the prompt.
5. [x] **Keep skill awareness progressive and per-agent.** Every agent receives the native
   capability-discovery system skill. Send metadata first; load matching, dependency-ready,
   pinned skill bodies through the existing discovery seam; use `skills_list`/`skill_view` where
   appropriate. Skills teach workflows but never grant tools or connections.
6. [x] **Implement post-model grounding review.** Add a single review function that consumes the
   immutable snapshot, retrieval/memory evidence, tool proposals/results, final response, and
   audience policy. Accept trusted evidence and tool-backed answers; fail closed only after the
   model has had its turn and only for the protected no-evidence factual case. Record whether the
   response was model-only, knowledge-backed, memory-backed, tool-backed, unavailable, or replaced.
7. [x] **Preserve durable tool safety.** Verify that Hermes-style persist-before-effect ordering,
   registry/grant/readiness checks, approval gates, session leases, kill switches, effect receipts,
   idempotency, redaction, replay, and cancellation remain on the dispatch path. A retry or cancel
   must not duplicate an effect or leave the run looping.
8. [x] **Repair observability and operator visibility.** Emit bounded structured events for model
   start/complete, tool proposed/executing/completed/failed, capability snapshot digest, and
   post-model grounding review. Keep `modelCallSkipped` only for real admission/context failures;
   it must be absent for the Calendar regression. Surface the live activity and final reason in the
   existing Studio/Playground observatory without logging message bodies, credentials, or raw
   provider output.
9. [x] **Add focused tests before broad verification.** Cover:
   - Calendar connection → Playground snapshot → model tool call → tool result → final response;
   - static no-evidence question → model called → postflight bounded refusal;
   - a “what/how/why” wording variant and a new provider name that are not in a keyword list;
   - unavailable/ungranted Calendar → typed unavailable result and no callable schema;
   - tool failure, approval wait/resume, cancellation, iteration/budget limit, and provider error;
   - skill index/body loading and the invariant that a skill cannot grant a tool;
   - Playground changes visible on the next Playground run, Live unchanged until Deploy, and
     rollback restoring the prior pinned snapshot.
10. [x] **Update documentation and release evidence.** Supersede the pre-model portion of
    `AGENT_KNOWLEDGE_GROUNDING_FIX_PLAN.md`, link this plan from the capability lifecycle plan,
    update the internal runtime/runbook documentation, and record the release fields below. Do
    not add a legacy fallback or a second execution path.

## Verification

- [x] No repository lint script exists; `git diff --check` passed.
- [x] `pnpm --dir agents build` and the focused grounding, effective-capability, harness, activity,
  deployment, skill, and cancellation tests.
- [x] Local API/Temporal/MCP smoke passed through explicitly local API/gateway endpoints. The
  smoke covered credential exchange, discovery, idempotent REST execution, MCP negotiation, and
  durable REST/MCP completion. Browser Calendar verification through the existing proxy remains a
  follow-up because this change has no browser-test harness.
- [ ] Browser check of Playground and Live: connect/configure, test in Playground, Deploy, test in
  Live, edit again, confirm Live remains unchanged, then roll back and verify the old snapshot.
- [x] `git diff --check` passed; changed internal documentation links resolve to checked-in files.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Model admission | An admitted run reaches the model; grounding is not a pre-model router. | Agent Platform | Proposed |
| Callable authority | One scoped registry and immutable effective snapshot own schemas, readiness, and dispatch admission. | Agent Platform | Existing direction; confirm |
| Live data | The model must use an authorized live-data tool when current connected state is required; postflight rejects unsupported answers. | Agent Platform | Proposed |
| Grounding fallback | Keep a bounded no-evidence response only as post-model safety for protected factual requests. | Product/Safety | Approval required |
| Intent heuristics | Keyword sets may inform retrieval/review telemetry but cannot block model/tool selection. | Agent Platform | Proposed |
| Skills | Native capability-awareness skill is shared by all agents; bodies load progressively and never grant permissions. | Agent Platform | Existing direction; confirm |
| Deploy lifecycle | Playground changes become Live only through explicit Deploy; versions are pinned and rollback restores the prior snapshot. | Studio/Agent Platform | Existing direction; confirm |
| Rollout | Local-only verification through the existing proxy/tunnel; no hosted staging work in this plan. | Release owner | Decided |

## Notes and blockers

- The user approved the target lifecycle and implementation proceeded locally. Browser lifecycle
  verification is intentionally separate from this runtime fix.
- The main unresolved product choice is whether a final no-evidence response should replace the
  model's text silently or include a concise “I could not verify that” explanation. The runtime
  evidence and status contract are independent of that copy choice.
- If a tool is connected but not callable, the model must see a typed unavailable reason through the
  capability contract or discovery tool; it must not be told that the tool succeeded.

## Release record

| Field | Decision |
| --- | --- |
| Change | Replace pre-model phrase-based grounding short circuit with a model-first capability/tool loop and post-model evidence review. |
| Owner | Agent Platform |
| Risk | High: changes model admission, tool invocation, grounding, and user-visible failure semantics. |
| Affected services and user surfaces | Agents runtime/Temporal worker, model gateway, capability registry, connection adapters, skills, Playground, Live chat, Studio execution observatory. |
| Platform release version or release ID | Not applicable until the implementation is approved and released locally; assign before any hosted release. |
| API/schema/migration changes | Prefer no migration. If event/provenance fields need persistence, use additive bounded fields and a repeatable migration; no destructive cleanup in this change. |
| Feature flag or rollout method | No legacy or dual execution mode. Local verification through the configured development proxy/tunnel; promote the tested artifact explicitly. |
| Analytics events and success metrics | Track `model_call_started/completed`, tool proposal/execution outcomes, post-model grounding review, live-data tool routing, and generic pre-model block count. Success: Calendar requests have model/tool activity; pre-model block count is zero for admitted turns; unsupported factual answers remain bounded. |
| Logs, metrics, dashboards, and alerts | Structured run/correlation/install/snapshot identifiers, provider/tool names, bounded reason codes, token/latency/status metrics; never log secrets, full messages, or raw provider payloads. Alert on repeated tool failures, loop/limit exits, stale snapshots, and unexpected pre-model skips. |
| User, API, internal, and operational documentation | Update this plan, the capability lifecycle plan, grounding/runtime runbook, local proxy smoke instructions, and public connection/capability behavior where user-visible. |
| Validation evidence | To be recorded after approval: focused tests, agent build, local proxy smoke, browser Playground/Live/rollback check, and diff/documentation checks. |
| Rollback or disable plan | Revert the exact runtime release and restore the previous pinned Live candidate if a release is made. Preserve run evidence and never mutate in-flight snapshots. |
| Post-release review date | Set when the local release ID is assigned. |
