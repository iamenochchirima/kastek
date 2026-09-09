# Hermes context and runtime telemetry research

Status: Research complete  
Hermes source: `/home/enoch/aworkspace/agents/hermes-agent`  
Hermes revision inspected: `9a84bee265daad14340a80d7585928cd8ea1f9eb`  
Scope: context-window discovery, request context construction, compression, recovery, usage anchoring, model timing, and TUI telemetry

## Conclusion

Hermes does not solve context safety with a status bar or a single token counter. It has a feedback loop:

```text
resolve model window
  -> construct the actual provider request
  -> estimate its pressure before dispatch
  -> compact before the threshold when possible
  -> dispatch the model request
  -> replace estimates with provider usage
  -> anchor subsequent estimates to that real usage
  -> recover from provider overflow with bounded retries
  -> project the same runtime state into the TUI
```

The proposed Kasitek design is directionally correct, but it needs two changes to match the mature parts of Hermes:

1. Context occupancy cannot be one permanently "exact" number. It moves through known states: estimated before the first response, provider-reported after a response, unknown immediately after compaction, then provider-confirmed again.
2. The Playground must consume durable runtime events and snapshots. It must not calculate context usage, latency, or timing from UI state.

The useful pattern to adopt is the closed feedback loop. Kasitek should not copy Hermes's Python objects, CLI-specific state, hardcoded model table, or session-rotation implementation verbatim.

## What Hermes actually does

### Context-window discovery

Hermes resolves context length per model, provider, endpoint, and account route. Its ordered resolver checks explicit configuration, model and custom-provider overrides, endpoint-scoped facts, a persistent cache, provider-specific APIs, live custom endpoint metadata, local runtime probes, model catalogs, hardcoded family defaults, and finally a warned fallback. This matters because one model name can have different usable limits on different providers. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/model_metadata.py:1844-1939`.

The resolver does not treat every metadata field as a context window. For example, it gives explicit window fields priority and only uses `max_tokens` as a last resort because some providers use that field for maximum output rather than total context. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/model_metadata.py:717-732`.

Local providers receive special handling. Hermes can query the live endpoint, reconcile a stale cached value when a local server restarts with a different context setting, and avoid persisting transient LM Studio and entitlement-specific Codex OAuth values. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/model_metadata.py:529-588`.

Provider errors are also a discovery source, but only when the provider states an actual limit. Hermes parses a reported context maximum and accepts it only when it is lower than the current value. It does not guess a smaller window from a generic "too long" error. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/model_metadata.py:1053-1086`.

Exact Hermes behavior:

- An explicit configured value wins.
- Cache keys include the model and endpoint.
- Provider-aware values win over generic catalog values.
- Live local runtime configuration can override stale disk metadata.
- Unknown models fall back to a default and emit a warning.
- A provider-reported limit can correct and persist the active window.

Recommended Kasitek adaptation:

- Build a typed model-capability resolver owned by the runtime, with `{provider, endpoint, model, account/credential class}` as its lookup identity.
- Return provenance with every result, such as `config`, `provider_metadata`, `local_probe`, `provider_error`, `catalog`, or `fallback`.
- Store confidence and observation time. A fallback must never look as authoritative as a provider response.
- Resolve both total context and maximum output. Keep them as separate capabilities.
- Re-resolve when the model, provider, endpoint, credential class, or local runtime configuration changes.

### Context construction

Hermes begins a turn by recovering a rotated compression session when needed, restoring the primary runtime, refreshing MCP tools between turns, copying durable conversation history, appending the new user message, and building or restoring a session-cached system prompt. It then runs turn-start compaction before injecting plugin and memory context. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context.py:744-856`.

Plugin `pre_llm_call` context is injected into the current user message rather than the system prompt. Oversized hook output can spill to disk so one plugin cannot permanently inflate future requests. External memory is prefetched once before the tool loop. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context.py:578-630` and `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context.py:671-691`.

Hermes records an `api_content` sidecar containing the exact bytes sent for injected user context. Historical rows replay that sidecar, which keeps the provider-visible prompt prefix stable. It structurally clones messages for dispatch, strips persistence and display fields, preserves provider-specific reasoning continuity, and adds the cached plus ephemeral system prompt to the wire copy. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context.py:694-724` and `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context.py:917-1003`.

The turn-start estimate is not the last safety check. After Hermes assembles the real API request, it calculates pressure again. This second check includes request-only injections, effective system content, and tool schemas. It prefers a valid usage anchor and otherwise floors a rough estimate at the last real provider prompt count. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_request_assembly.py:227-264` and `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_preflight_gate.py:60-99`.

Exact Hermes behavior:

- Durable transcript and provider wire request are related but distinct representations.
- The system prompt stays stable within a session for prompt caching.
- Dynamic plugin and memory context is bounded and attached to the current request.
- Context pressure is recalculated from the assembled request before every model call, including calls after tool results.
- Tool schemas count toward pressure. They are not free metadata.

Recommended Kasitek adaptation:

- Introduce an immutable `AssembledModelRequest` record for each model attempt.
- Compute context pressure from that record after all instructions, memories, skills, tool schemas, gateway data, and provider transformations have been applied.
- Persist a redacted request manifest and content hashes. Do not persist secrets or raw private context in telemetry.
- Keep the canonical conversation, compacted conversation, and provider request as separate types so code cannot accidentally use cumulative history as the outgoing prompt.

### Token estimation and usage anchoring

Hermes uses a fast rough estimator before it has provider usage. It estimates ASCII by roughly four bytes per token, treats CJK-family characters as denser, charges images a fixed token estimate, strips fields that do not reach the provider, and includes the system prompt and tool schemas for full-request estimates. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/model_metadata.py:1955-1988` and `/home/enoch/aworkspace/agents/hermes-agent/agent/model_metadata.py:2082-2133`.

After a successful model response, Hermes captures an anchor from provider-reported prompt and completion usage plus the position and identity of the transcript boundary. Future occupancy can use the exact anchored total plus a rough estimate of only the messages appended since that response. If compaction or a splice changes the boundary, validation fails and Hermes returns to full estimation. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/model_metadata.py:2136-2181`.

Hermes keeps two related anchors. The latest anchor supports pressure calculations. The first response in a user turn becomes the display anchor, preventing a reasoning-heavy tool loop from making the context meter jump to the inflated prompt size of the final same-turn request. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_usage.py:109-125` and `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_status_bar_mixin.py:271-300`.

Compaction invalidates both anchors, sets `last_prompt_tokens` to an explicit sentinel, stores a diagnostic post-compaction estimate, and waits for a new provider response before calling the new occupancy real. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_compression.py:3106-3128`.

Exact Hermes behavior:

- Provider prompt usage is the authority when present.
- Estimates fill gaps; they are not silently relabeled as actual usage.
- Cumulative session tokens and current context occupancy are different counters.
- Anchors fail closed when their transcript boundary is stale.
- The next real provider response judges whether compaction actually cleared the threshold.

Recommended Kasitek adaptation:

- Represent occupancy as `{tokens, basis, observedAt, requestId}` where `basis` is `provider_reported`, `anchored_estimate`, `full_estimate`, or `unknown_after_compaction`.
- Store cumulative usage separately under the run and session accounting records.
- Anchor by durable message or event IDs and content hashes, not process-memory object identity. Hermes's `id()` boundary works inside its process but does not fit Temporal replay or worker replacement.
- Make every Playground value expose its basis in the detail panel. The compact bar can omit the label unless the value is estimated or unknown.

### Compression triggers

Hermes derives the trigger from the usable input budget, not the raw context window. It subtracts a positive output reservation, applies a configurable percentage, protects small windows from unreachable thresholds, and supports an absolute token cap. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:2192-2253`.

The default compressor starts at a 50 percent threshold. For windows below 512K, Hermes raises the percentage floor to 75 percent. Lean mode keeps a recent tail budget equal to 2.5 percent of the context window, clamped between 10K and 25K tokens. Summary output is capped at the lower of five percent of the context window or 10K tokens. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:639-639`, `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:753-754`, `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:989-990`, and `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:1737-1797`.

Compression can run at turn start, immediately before an API call after the complete request exists, after tool results, after an idle interval, or reactively after a provider overflow. The preflight path re-estimates after each pass, permits another pass only after more than five percent reduction, and stops after a configured attempt limit. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context_compaction.py:224-417` and `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_preflight.py:240-311`.

Exact Hermes behavior:

- Prompt tokens alone drive post-response context pressure. Completion and reasoning tokens do not automatically count as future prompt occupancy.
- A provider-reported prompt count is preferred after model calls.
- Missing usage falls back to an overhead-aware estimate.
- A shared per-turn attempt budget prevents compaction loops.
- Real provider usage, rather than message-count reduction, decides whether a compaction was effective.

Recommended Kasitek adaptation:

- Use configurable soft and hard thresholds. The soft threshold starts maintenance; the hard threshold blocks dispatch until the request fits.
- Calculate both thresholds from `contextWindow - reservedOutput - providerSafetyMargin`.
- Run the final gate against the fully assembled request immediately before the Temporal activity that calls the provider.
- Carry the compaction-attempt budget in durable workflow state so retries and worker replacement cannot reset it.

### Compression content policy

Hermes compacts the middle of the transcript. It protects a head region, chooses a recent tail by token budget, keeps the latest user and assistant turns, avoids splitting tool-call groups, and can keep several recent user turns. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:4183-4227` and `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:4323-4339`.

The compressor first prunes old tool results and blank echoes. It then selects the middle window, demotes stale tool results in the retained tail, summarizes the middle with an auxiliary model when useful, and assembles an alternation-safe head, handoff summary, and tail. It repairs orphaned tool pairs, reattaches an in-flight user task, removes historical media payloads, and strips stale reasoning replay. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:4578-4666` and `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:4521-4576`.

Hermes records estimated savings but does not use that estimate as proof of success. The next provider prompt count determines whether the resulting request fell below the threshold. Two ineffective or fallback outcomes can trip an anti-thrashing guard. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:2345-2395` and `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:2440-2467`.

Recommended Kasitek adaptation:

- Preserve instruction blocks, the active user task, unresolved approvals, tool-call/result integrity, active specialist-agent contracts, and a bounded recent tail.
- Replace large historical tool results with typed references to durable artifacts plus a short digest.
- Store the generated summary as a versioned context artifact with source event boundaries.
- Validate structural invariants before committing a compaction candidate.
- Reject a candidate that grows the provider request or loses the active task.

### Compression recovery and durability

Hermes distinguishes context overflow, output-cap errors, and HTTP 413 payload overflow. A provider-stated output allowance reduces only the output cap. A provider-stated context maximum updates and persists the context window. A generic overflow keeps the current window and compacts rather than guessing a lower tier. A 413 measures progress by serialized bytes because image payloads can dominate request size without dominating token estimates. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_overflow.py:218-310` and `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_overflow.py:314-416`.

Compression work runs under separate inactivity and total time budgets. Hermes uses a commit fence so a cancelled or timed-out worker cannot publish late state. A silent primary compression route can receive one bounded retry on a configured fallback route with a fresh fence. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_compression.py:676-731`, `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_compression.py:773-890`, and `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_compression.py:991-1017`.

Failure cooldowns, ineffective-compaction counts, and fallback streaks can be stored with the session. Transient lock contention and cooldowns cause a defer rather than consuming the same budget as proven incompressibility. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:1986-2128` and `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_compression.py:1305-1360`.

Each compression attempt emits content-free structured telemetry with an attempt ID, total duration, commit status, split status, failure class, chunking information, and fallback use. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_compression.py:1184-1215`.

Recommended Kasitek adaptation:

- Let Temporal own timeout, retry, cancellation, and child-workflow durability, but preserve Hermes's semantic distinctions.
- Use a monotonic compaction generation or fencing token on every context write. A late activity result must fail compare-and-swap.
- Persist the source event boundary, candidate artifact, validation result, and commit outcome separately.
- Keep payload-byte pressure separate from token pressure.
- Emit a typed terminal result when compaction cannot produce a safe request. Do not convert that state into a generic token-budget error.

### Model-call latency and throughput

Hermes timestamps each provider attempt immediately before the retry loop dispatch and computes duration after the response returns. It records every completed provider attempt, including attempts whose providers omit usage. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_loop.py:1358-1374`, `/home/enoch/aworkspace/agents/hermes-agent/agent/conversation_loop.py:1493-1493`, and `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_response_check.py:111-121`.

When usage exists, Hermes normalizes provider fields, appends latency and output-token count to aligned deques capped at ten calls, logs the call, updates cumulative session counters, estimates cost, and queues durable accounting deltas. Source: `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_usage.py:65-88` and `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_usage.py:90-183`.

The TUI reports mean latency across that window. Throughput is `sum(output tokens) / sum(latency)`, not the mean of per-call token rates. If no valid history exists, Hermes omits the values. Source: `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_status_bar_mixin.py:339-357`. The tests pin `2s + 4s` to `3.0s` mean latency and `300 / 6s` to `50 t/s`. Source: `/home/enoch/aworkspace/agents/hermes-agent/tests/cli/test_cli_status_bar.py:620-645`.

One limitation matters: Hermes's `t/s` uses full request duration as the denominator. It is end-to-end output throughput, not decoder-only generation speed and not time to first token.

Recommended Kasitek adaptation:

- Record queue delay, provider latency, time to first token when streaming exposes it, stream duration, and total attempt duration as separate fields.
- Define the initial Playground `latency` as provider attempt duration for parity with Hermes.
- Define throughput precisely as provider-reported output tokens divided by measured attempt duration until a provider offers a better generation-duration measurement.
- Keep attempt telemetry separate from logical model-call telemetry so retries remain visible without double-counting successful usage.

### Prompt and session timing

Hermes starts the prompt timer when the CLI submits the user turn. It stays live across model calls, tools, retries, and cleanup, then freezes when the agent thread settles. Source: `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_chat_turn_mixin.py:72-87` and `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_chat_turn_mixin.py:420-425`.

The status snapshot also calculates total session age and time since the last completed turn. The prompt label changes glyph while live and keeps the final duration after completion. Source: `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_status_bar_mixin.py:135-168` and `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_status_bar_mixin.py:188-213`.

Recommended Kasitek adaptation:

- Start turn timing when the runtime admits the user or gateway input, not when the browser sends it.
- Persist `admittedAt`, `startedAt`, `firstModelRequestAt`, `firstTokenAt`, `waitingForApprovalAt`, and `finishedAt` as lifecycle events.
- Derive live elapsed time from server time plus the durable start event. The browser should only repaint it.
- Pause or classify approval and external-wait time instead of hiding it inside model latency.

### TUI telemetry

Hermes builds one snapshot from agent and compressor state. The context meter reads current prompt occupancy and the resolved model window. It explicitly avoids cumulative session totals. The status bar computes the percentage, clamps it to 0 through 100, and shows compression count, rolling latency, throughput, session duration, prompt duration, and idle time when space and field configuration allow. Source: `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_status_bar_mixin.py:170-213`, `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_status_bar_mixin.py:271-357`, and `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/cli_status_bar_mixin.py:946-1053`.

The gateway exposes similar usage data and contains an explicit guard against substituting cumulative lifetime tokens for current-window occupancy. When current occupancy is unavailable, it omits the gauge instead of fabricating zero or 100 percent. Source: `/home/enoch/aworkspace/agents/hermes-agent/tui_gateway/server.py:1891-1942`.

Recommended Kasitek adaptation:

- Publish a canonical `RuntimeTelemetrySnapshot` from the backend and update it from immutable run events.
- Show these first: model, current context tokens and window, utilization, latest or rolling model latency, and live turn duration.
- Add a detail drawer for basis, reserved output, threshold, latest compaction, attempt history, cache use, and cost.
- Render unknown data as unknown. Never use cumulative run usage as a fallback for context occupancy.

## Comparison with the proposed Kasitek design

| Proposed Kasitek element | Hermes finding | Decision |
| --- | --- | --- |
| One canonical telemetry record | Hermes composes a snapshot from runtime counters and compressor state | Keep the canonical contract, but derive it from events rather than treating it as mutable UI state |
| Model-aware context windows | Hermes uses a provider-aware ordered resolver with cache, probes, corrections, and fallback warnings | Expand the proposal to include provenance, credential scope, cache invalidation, and provider-error correction |
| Pre-call fit check | Hermes checks at turn start and again after the real request is assembled | Require a final gate after all dynamic context and tool schemas are present |
| Automatic compaction | Hermes compacts at several pressure points and supports reactive overflow recovery | Keep it, with one durable attempt budget shared across proactive and reactive paths |
| Preserve instructions and recent turns | Hermes protects head, active task, recent token-bounded tail, and tool-call groups | Add unresolved approvals, specialist-agent contracts, and durable artifact references for Kasitek |
| Actual versus estimated usage | Hermes uses provider usage, anchored deltas, rough fallback, and an unknown post-compaction state | Replace the proposal's boolean `estimated` field with an explicit measurement basis and request identity |
| Latest and rolling latency | Hermes records the last ten completed attempts and renders the rolling mean | Store attempt-level data durably and derive both latest and rolling views |
| Turn duration | Hermes times the whole submitted prompt through agent-thread settlement | Preserve this meaning, but derive it from runtime lifecycle events so it survives worker replacement |
| Playground telemetry | Hermes's CLI and gateway both project runtime-owned state | The Playground should subscribe to backend telemetry and never calculate safety values itself |

## Recommended Kasitek runtime contract

```ts
type MeasurementBasis =
  | "provider_reported"
  | "anchored_estimate"
  | "full_estimate"
  | "unknown_after_compaction";

interface RuntimeTelemetrySnapshot {
  runId: string;
  turnId: string;
  attemptId?: string;
  observedAt: string;
  model: {
    provider: string;
    endpointId: string;
    modelId: string;
    contextWindowTokens: number;
    maxOutputTokens?: number;
    capabilitySource: string;
  };
  context: {
    tokens?: number;
    basis: MeasurementBasis;
    utilizationPercent?: number;
    reservedOutputTokens: number;
    softThresholdTokens: number;
    hardLimitTokens: number;
    compactionCount: number;
  };
  modelCall?: {
    status: "queued" | "running" | "streaming" | "completed" | "failed";
    startedAt: string;
    firstTokenAt?: string;
    completedAt?: string;
    latencyMs?: number;
    outputTokens?: number;
    throughputTokensPerSecond?: number;
  };
  turn: {
    status: string;
    admittedAt: string;
    finishedAt?: string;
    elapsedMs: number;
  };
}
```

This contract should be a read model. The source of truth should remain typed run events such as:

- `model_capability_resolved`
- `model_request_assembled`
- `context_pressure_measured`
- `compaction_started`
- `compaction_candidate_created`
- `compaction_committed`
- `compaction_deferred`
- `model_attempt_started`
- `model_first_token_received`
- `model_attempt_completed`
- `provider_usage_recorded`
- `turn_completed`

## Implementation order for Kasitek

- [ ] Define model capabilities and resolution provenance.
- [ ] Define the immutable assembled-request manifest and final pre-dispatch context gate.
- [ ] Separate current occupancy, cumulative usage, run limits, and output reservation in runtime types.
- [ ] Add provider usage anchoring with durable event IDs and hashes.
- [ ] Make compaction a fenced Temporal operation with bounded attempts and typed outcomes.
- [ ] Add context-structure validation and provider-confirmed post-compaction verification.
- [ ] Emit attempt, usage, compaction, and turn timing events.
- [ ] Build the backend telemetry projection.
- [ ] Connect the Playground bar and detail panel to that projection.
- [ ] Test long tool loops, missing usage, model switches, local context changes, worker loss, stale compaction completion, provider overflow, output-cap rejection, and 413 image payloads.

## Direct answer

Yes, the main shape proposed for Kasitek matches Hermes: discover the real window, measure the actual request, compact before overflow, replace estimates with provider usage, and expose the resulting state. The proposal was too simple around measurement state, request assembly, recovery, and durability. Those are the parts that prevented Hermes from turning context handling into a loop of token-limit failures, and they are the parts Kasitek should implement before treating the Playground telemetry as complete.
