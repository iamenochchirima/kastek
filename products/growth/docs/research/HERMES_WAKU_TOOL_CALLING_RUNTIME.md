# Hermes and Waku tool-calling runtime investigation

**Status:** Investigation complete; implementation decision pending

**Scope:** The repeated Calendar invocation and context-budget failure observed in
KasiTek Studio. The same failure can affect Gmail, Drive, MCP, skills, and every
other model-facing capability.

## Finding

This is a context-projection bug, not a Calendar integration bug and not primarily
a model-quality problem.

KasiTek correctly appends the assistant tool call and the tool result to the live
runtime transcript. The context planner then removes both from the next model
request because it resolves the current message to the latest user message and
skips every message after that index. The model receives the original question
again without the result it just obtained, so it requests the same tool again.

The latest failing run (`d1179301-8cd5-415c-8090-65c2c9a0f08c`) demonstrated this
directly: the selected model was the requested `openrouter/openai/gpt-5.6-luna`,
Calendar was invoked three times, and the context plans after tool completion
reported zero selected tool results. The fourth context plan stopped the run with
`CONTEXT_RUN_BUDGET_EXCEEDED`.

The relevant code path is:

- The loop appends the model response before executing tools and appends each tool
  result afterward: [`runtime/loop.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/runtime/loop.ts:1093)
  and [`runtime/loop.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/runtime/loop.ts:1280).
- The planner deliberately groups an assistant tool-call message with its following
  tool messages as a protected unit: [`context-planning.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/runtime/context-planning.ts:672).
- The planner nevertheless skips all units after the resolved current user index:
  [`context-planning.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/runtime/context-planning.ts:718)
  and resolves that index by searching for the latest user message:
  [`context-planning.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/runtime/context-planning.ts:764).

The protection exists, but the selection boundary makes it unreachable for the
normal tool-loop shape:

```text
user question
assistant tool call
tool result
         ^ latest user index is above these rows, so both are skipped
```

The existing test covers a tool pair before a later user message, but not the
actual active-turn shape where the pair is after the current user message:
[`context-planning.test.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/test/context-planning.test.ts:167).

## Provider contract

This is not an optional framework convention. The model providers require the
exchange to remain intact:

- Anthropic requires `tool_result` blocks to immediately follow their corresponding
  `tool_use` blocks and says the model continues from that result on the next
  request. [Anthropic tool-call handling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- OpenAI’s Responses example runs the function, sends a
  `function_call_output` back using the matching `call_id`, and preserves replayable
  output items in order. [OpenAI function tools](https://github.com/openai/openai-node/blob/main/docs/tools.md)
- OpenAI Chat Completions represents the result as a `tool` message with the matching
  `tool_call_id`. [OpenAI Chat API reference](https://developers.openai.com/api/reference/cli/resources/chat)

Therefore, a context planner may compact or truncate a completed result, but it
cannot omit the active assistant-call/result unit and still claim to continue the
same tool turn.

## What Hermes does

Hermes uses one canonical working transcript for the model loop. It does not infer
the next request from a user-message cutoff.

1. It stages the assistant tool-call message and appends it to the transcript.
2. It flushes that message to the session database before executing any tool side
   effect.
3. Each completed tool result is appended with its `tool_call_id` and flushed before
   the next model iteration.
4. The next request is assembled from the transcript in order, with API-only copies
   made for sanitization and context policy.

The implementation makes the durability boundary explicit:

- [`turn_tool_round.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/turn_tool_round.py:96)
  appends and persists the assistant tool-call row before execution.
- [`tool_executor.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/tool_executor.py:942)
  appends and flushes each tool result before projecting completion.
- [`turn_context.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context.py:917)
  builds the provider request by walking the current transcript in order rather than
  reconstructing it from a guessed intent or a latest-user cutoff.
- Hermes restores the durable rows, including `tool_calls`, `tool_call_id`, and tool
  names, in insertion order: [`hermes_state_messages.py`](/home/enoch/aworkspace/agents/hermes-agent/hermes_state_messages.py:774).

Hermes also treats pair integrity as a correctness invariant during compaction. It
removes orphaned results, keeps in-flight calls, aligns compression boundaries so a
tool group is not split, and preserves the active user/assistant/tool tail:

- [`context_compressor.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:3816)
- [`context_compressor.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:4166)
- [`context_compressor.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:4183)

This is backed by tests rather than being only a convention. Hermes tests require
the assistant call to be durable before tool execution and each result to be
durable before the next dispatch:
[`test_tool_call_incremental_persistence.py`](/home/enoch/aworkspace/agents/hermes-agent/tests/run_agent/test_tool_call_incremental_persistence.py:1).

Hermes also has a recovery path for an interrupted call: the model-facing copy gets
a typed unavailable-result placeholder while the canonical durable transcript is
not fabricated or duplicated. That is the right failure behavior for a crashed or
cancelled tool, and it is different from silently dropping a successful result.

## What Waku does

Waku is deliberately smaller, but its core loop has the same essential invariant:

```text
model(messages, tools)
append assistant response
execute every requested tool
append tool results
model(the same messages list, tools)
```

The loop mutates one working-memory list in place. It appends the assistant response,
executes every tool use, appends the result block carrying the matching tool-use ID,
and passes that same list to the next model call:
[`waku/loop/agent.py`](/home/enoch/aworkspace/agents/waku-agent/waku/loop/agent.py:41).

Waku encountered a duplicate-action problem in live testing and encoded the result
into the next-turn working memory as a compact `[tools used: ...]` record. Its
session code explicitly documents that this prevents the model from forgetting it
already acted and repeating the same tool:
[`waku/runtime/session.py`](/home/enoch/aworkspace/agents/waku-agent/waku/runtime/session.py:90).
The regression test pins the behavior for calendar creation:
[`test_tool_trigger.py`](/home/enoch/aworkspace/agents/waku-agent/evals/deterministic/test_tool_trigger.py:51).

Waku’s graph is a separate concern. The graph engine owns static topology, routing,
bounded visits, and observer events. A graph node can contain the ordinary agent
loop; the graph does not replace the loop’s transcript:

- [`agent-graphs-design.md`](/home/enoch/aworkspace/agents/waku-agent/docs/agent-graphs-design.md:22)
- [`graph/engine.py`](/home/enoch/aworkspace/agents/waku-agent/waku/graph/engine.py:37)
- [`graph/nodes.py`](/home/enoch/aworkspace/agents/waku-agent/waku/graph/nodes.py:45)

That separation is important for KasiTek: execution visualization can consume
runtime events, but it must never become the source of model context or tool-call
semantics.

## Comparison

| Boundary | Hermes | Waku | KasiTek today |
| --- | --- | --- | --- |
| Model transcript | Canonical, durable, ordered | One mutable per-run list | Live list exists, but planner projects it incorrectly |
| Tool pairing | `tool_call_id` plus durable rows and repair | Tool-use ID in the result block | Pair units are recognized, then skipped by the current-user cutoff |
| Context reduction | Pair-aware compaction and tail alignment | Bounded turn window plus compact tool summary | Token-aware planner with a broken active-turn boundary |
| Tool execution | Central executor, persistence before/after effects | Registry dispatch returns model-visible errors | Central registry and durable receipts exist, but the next model call loses results |
| Duplicate protection | Durable session/replay and tool-call identity | Per-turn iteration guard and next-turn tool summary | Budgets stop runaway loops, but only after wasting calls and tokens |
| Visualization | Runtime callbacks and durable trajectory | Observer receives loop and graph events | Journal/SSE/graph exist, but UI cannot show truth if the model request is wrong |

The strongest common pattern is not a particular graph library. It is that the
runtime owns an ordered, append-only tool transcript and the context layer is
allowed to reduce it only at valid protocol boundaries.

## Correct KasiTek architecture

The fix belongs at the transcript/context seam, not in Calendar, grounding keyword
lists, the Studio graph, or a tool-specific deduplication table.

### 1. Define an active model turn

The active turn begins at the current user message and includes every subsequent
assistant tool-call message and its tool results until the model emits a final
assistant response or the run pauses/fails.

`latest user index` may classify a user message for accounting, but it must not be a
hard upper bound on selecting messages. The planner must select from the newest
transcript tail and include the active turn after that user message.

### 2. Make protocol units atomic

The context planner should operate on units such as:

```text
ordinary message
assistant tool-call batch + all matching tool results
provider-specific continuation group
```

It may omit or summarize older completed units. It must never send a tool result
without its call, send a call without its result once that call has completed, or
split a parallel batch. Anthropic and OpenAI adapters may serialize the unit
differently, but the runtime identity and pairing remain the same.

### 3. Keep three projections separate

```text
canonical transcript       complete ordered model/tool exchange for replay
model request projection   bounded pair-safe subset for this provider call
execution journal          lifecycle evidence for UI, audit, and recovery
```

The model request projection may redact, truncate, or reference an old tool result.
It may not silently drop the active result. The execution journal may describe an
operation, but it cannot substitute for the model-facing result.

### 4. Preserve durable invocation identity

Every tool call needs a stable run/turn/call identity, tool name, arguments hash,
result, status, and causal ordering. On retry or worker recovery, the runtime should
replay a durable completed outcome when the identity and arguments match instead of
executing an external effect again. This is complementary to, not a substitute for,
keeping the result in the next model context.

### 5. Add a generic repetition safety net

After the transcript fix, add a provider-neutral guard for repeated identical
`tool + normalized arguments` calls in one active turn. The guard should surface a
model-visible diagnostic and terminate or ask for clarification after a small bound.
It must be a last-resort safety net, not the mechanism that makes Calendar work.

### 6. Make observability assert the invariant

Before every model request, emit or record:

- source transcript cursor/digest;
- selected transcript cursor/digest;
- active tool-call IDs;
- selected tool-result IDs;
- omitted/truncated pair count;
- provider/model and operation identity.

If an active completed tool call has no selected matching result, the planner should
reject the request as an internal context-projection error before spending another
model call. This would have stopped the observed run at the first bad projection,
with the exact cause, instead of allowing three repeated Calendar calls.

## Implementation boundary

The first implementation slice should be:

1. Correct the active-turn selection in `context-planning.ts`.
2. Add a regression test for `user → assistant tool call → tool result` with no later
   user message, plus multi-call and parallel-call variants.
3. Add a loop-level test proving the second model request receives the first tool
   result and therefore does not repeat the scripted call.
4. Add a planner invariant test that refuses to send an active call without its
   matching result.
5. Verify the same contract through the provider adapters and the visualization
   event stream.

Only after that should we add repetition dampening or further context compaction.
Those are safety and scaling improvements; they do not repair the current broken
transcript projection.

## What this investigation rules out

- Calendar-specific OAuth or API behavior as the primary cause.
- The selected model as the primary cause; the corrected model was used in the
  failing run.
- The Studio graph as the source of repeated tool calls.
- A generic `what`/`calendar` keyword list as a durable tool-calling architecture.
- Fixing the problem by hiding duplicate tool nodes or changing the UI.

The architecture must make every capability—Calendar, Gmail, Drive, MCP, skills,
and future connectors—pass through the same transcript, pairing, context, replay,
and budget contracts.
