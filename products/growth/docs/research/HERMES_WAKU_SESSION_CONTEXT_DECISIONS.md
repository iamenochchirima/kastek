# Hermes and Waku Session Context Decisions

Research record — 2026-09-10

## Scope

This record answers the ten open session-context and compaction decisions using the
local Hermes and Waku source trees and their tests as primary evidence:

- Hermes: `/home/enoch/aworkspace/agents/hermes-agent`
- Waku: `/home/enoch/aworkspace/agents/waku-agent`

The findings concern session identity, transcript persistence, model context
growth, compaction, tool results, concurrency, failures, legacy records,
retention, and reset/deployment behavior. This is a research record. It does not
modify an active plan and does not prescribe an implementation by itself.

Evidence labels used below:

- **Observed** — behavior directly visible in the cited source or test.
- **Inference** — a conclusion drawn from observed behavior.
- **Recommendation** — a proposed decision for a future implementation, not a
  claim about what Hermes or Waku already do.

## Executive findings

Hermes has a durable transcript architecture. SQLite is the canonical store;
the in-memory conversation is a projection of the durable message rows. It keeps
session lineage, distinguishes a user-visible reset from a real session end,
persists assistant tool calls before executing the tool, and uses leases and
watermark-fenced commits for compression. Compaction archives the old active
rows and inserts a compacted summary atomically, while concurrent new messages
are preserved in the child/tail being committed.

Waku uses a smaller, deliberately bounded session model. A gateway owns one
in-memory session, each turn rebuilds a bounded model prompt from recent history,
and older exchanges remain in SQLite and are periodically consolidated into
facts and episodes. Waku's consolidation is long-term-memory extraction, not a
Hermes-style replacement of a growing model transcript. In the inspected Waku
sources, there is no equivalent durable compression lineage, compaction lease, or
media-specific transcript projection.

The most important architectural distinction is therefore:

| Concern | Hermes | Waku |
|---|---|---|
| Canonical transcript | Durable SQLite message rows | SQLite `chat_log` plus in-memory session history |
| Model prompt | Active durable transcript projection | Recent bounded history plus current turn |
| Older context | Archived/compacted lineage remains recoverable | Older chat remains in the log; facts/episodes are extracted |
| Compaction | LLM summary plus atomic archive/replace | No transcript compaction found; periodic memory consolidation |
| Concurrency | Durable session and compression leases | One worker thread per gateway; SQLite busy timeout |
| Tool-call durability | Assistant tool call persisted before side effect | Tool messages live in the current in-memory loop; persisted exchange is summarized |
| Media | Provider cache, durable text projection, image retirement | No media-specific compaction path found |

## Exact Hermes compaction behavior

Hermes does not wait until the provider rejects an oversized request. The
compressor computes a threshold from the model context window and reserves room
for output:

1. The effective input budget is the model context length minus the configured
   output reservation when one exists.
2. The base threshold is 50% of that effective input budget for larger context
   windows.
3. For context windows below 512,000 tokens, the threshold percentage is raised
   to at least 75%.
4. A minimum context floor can force the threshold upward, but the threshold is
   capped at 85% when that floor is binding or the calculated threshold is
   otherwise unreachable.
5. The compressor protects the first three messages and the last twenty by
   default. Its default summary target ratio is 20% of the selected budget.
6. In the default lean-tail mode, the retained tail is constrained to a small
   percentage of the context window; the summary itself is capped at 5% of the
   context window and at 10,000 tokens.

These rules are implemented in
`/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:1780-1797`,
`:2211-2253`, and `:2255-2300`. The source also documents that the compressor
prunes oversized tool results, retains the protected head and tail, and
summarizes the middle (`context_compressor.py:1636-1638`).

Compaction is not merely a new prompt assembled in memory. Hermes writes the
summary back into the durable session store. Active historical rows are marked
inactive/compacted and the compacted summary rows are inserted atomically;
concurrent tail rows are retained and remain recoverable
(`hermes_state_messages.py:508-568`). The watermark tests verify that appends
during a slow summary are not lost and that a failed or lease-lost commit leaves
the original transcript intact (`tests/test_compression_watermark_commit.py:44-170`,
`:200-340`).

The summarizer normally makes an auxiliary compression model call. If a distinct
summary model fails, Hermes retries once with the main model. Terminal failures
such as timeout, access, quota, network, empty, or truncated output preserve the
unchanged transcript rather than replacing it with an untrusted summary
(`context_compressor.py:3158-3247`, `:3439-3505`, `:4382-4448`).

## Decision 1 — Session identity and lifecycle/reset semantics

### Hermes — observed

Hermes separates a user-visible reset from an actual session end. Reset reasons
include `session_reset`, `session_switch`, `idle`, `daily`, `suspended`, and
`resume_pending_expired`; recoverable operational endings include
`agent_close`, `ws_orphan_reap`, `superseded_by_resume`, and
`startup_orphan_reap` (`hermes_state_common.py:119-164`). A reset creates a new
user-visible conversation while retaining parent lineage through a reset marker
or a legacy same-key fallback.

Session identity is more than a display key. Hermes keeps monotonic conversation
generations for `(source, session_key)` and deliberately does not garbage
collect them, preventing an old prompt-cache identity from being reused after
session rows are deleted (`hermes_state_common.py:409-435`). A session row
stores the durable identity and routing metadata: source, model/configuration,
system-prompt hash, user, chat/thread, parent, cwd, profile, origin, and display
fields (`hermes_state_sessions.py:271-360`).

For resume, Hermes follows compression/reset lineage to the live tip and then
selects the deepest message-bearing child (`hermes_state_sessions.py:687-726`).
`/new` or `/reset` is therefore not equivalent to process shutdown or gateway
expiry; the agent explicitly clears per-session compaction state on reset
(`agent/turn_context.py:1644-1649`).

### Waku — observed

Waku creates one `Session` per gateway connection. The session has a session ID,
in-memory history, and persistent memory behind the gateway
(`waku/runtime/session.py:53-61`). `start_new()` assigns a new ID and clears
history; `switch()` clears history and reloads recent pairs
(`waku/runtime/session.py:109-127`). The database stores a session ID label in
`chat_log`, but the inspected source does not show Hermes-style parent/child
compression lineage (`waku/db.py:64-75`).

The gateway is process-local and owns one Waku instance per async message
gateway (`waku/gateway/runner.py:1-7`).

### Inference and recommendation

Waku demonstrates the minimum useful reset contract; Hermes demonstrates the
durable version needed when sessions can resume across restarts or concurrent
workers. A future implementation should define separately:

- a stable routing identity for the logical conversation;
- a physical session/generation identity for each reset or lineage segment;
- an explicit reset event and reason;
- a resume rule that follows the latest live message-bearing lineage;
- a real end state for shutdown/expiry that is not silently treated as reset.

The generation must not be recycled merely because old rows were deleted.

## Decision 2 — Canonical transcript storage seam

### Hermes — observed

Hermes' durable SQLite message rows are canonical. `get_messages()` reads
messages in insertion order, while `get_messages_as_conversation()` restores
the model-facing projection (`hermes_state_messages.py:628-655`, `:687-750`).
The durable rows preserve tool calls, tool-call IDs, tool names, reasoning, and
provider content with byte fidelity (`hermes_state_messages.py:774-836`).

Hermes intentionally exposes two projections after compaction: `model_history`
contains the active compressed working context, while `display_history` includes
the full lineage and compacted rows. Including compacted rows in the model
history would regrow the context (`hermes_state_messages.py:838-858`).

Persistence is append-only for ordinary messages and batch writes are atomic
(`hermes_state_messages.py:265-315`). The optional JSON export is a snapshot;
`state.db` remains canonical (`agent/session_persistence.py:426-458`).

### Waku — observed

Waku stores raw chat rows in SQLite with session ID, role, content, consolidated
state, source, and metadata (`waku/db.py:64-75`). `log_chat()` persists a user
and assistant pair; tool calls are folded into a textual assistant line such as
`[tools used: ...]` (`waku/memory/__init__.py:109-139`,
`waku/runtime/session.py:90-107`). The in-memory loop holds richer intermediate
tool messages only for the current turn (`waku/loop/agent.py:41-110`).

### Inference and recommendation

The canonical seam should be a durable, structured transcript store, not a
frontend timeline and not a provider request array. It should expose at least:

- an append-only message/event record with stable turn and tool-call identity;
- an active model-history projection;
- a complete display/audit projection;
- lineage and compaction metadata;
- an explicit artifact reference for large content.

Following Hermes is the safer choice when tool calls must survive a restart or
be retried without re-executing a side effect. Waku's compact pair logging is
adequate for a small local assistant but is not sufficient as the only durable
representation of a multi-step tool turn.

## Decision 3 — Model switching and context-size changes

### Hermes — observed

Hermes treats the model and its context window as mutable session configuration.
After a model switch or fallback, it updates model/provider/base URL/context,
recomputes the threshold, and resets real-usage calibration, ineffective
compaction strikes, and fallback streak state (`agent/context_compressor.py:2138-2170`).

The model switch is scoped to the target session. The tests verify that it does
not mutate process-wide environment variables or a sibling session
(`tests/tui_gateway/test_make_agent_provider.py:76-142`). Per-model threshold
initialization and context-switch behavior are covered by
`tests/run_agent/test_per_model_threshold_init_ordering.py` and
`tests/run_agent/test_switch_model_context.py`.

### Waku — observed

Waku keeps model/provider settings at the Waku configuration level. Its model
loader removes an inherited model when it belongs to a different provider and
then supplies a default model (`waku/loop/models.py:260-281`). The settings API
reports a global model/provider configuration (`waku/ops/settings_api.py:38-87`).
The inspected source does not show per-session context-threshold recalculation
after a model switch.

### Inference and recommendation

Switching models must preserve the logical transcript but recalculate the
available input budget before the next model call. If the new model has a
smaller window, compaction must run before the call; if compaction cannot safely
produce a smaller projection, the call must fail without damaging the transcript.
Model selection must be session-scoped and persisted with the turn/configuration
that used it; it must not be read from mutable process-global state during a
running turn.

## Decision 4 — Compaction summarizer path

### Hermes — observed

Hermes protects the beginning and recent tail, prunes oversized tool results,
and summarizes the middle. The summary prompt treats transcript data as data,
asks for a structured continuity summary, and forbids credentials and secrets
(`agent/context_compressor.py:1636-1638`, `:3306-3335`). The previous summary is
fed into later compactions so summaries can be updated incrementally rather than
starting from an empty description every time (`context_compressor.py:3249-3304`).

The compression call is an auxiliary LLM call with a `compression` task label.
Hermes may use a distinct configured summary model, but retries once with the
main model if the distinct model fails (`context_compressor.py:3158-3247`).
Empty output and a length-truncated output are rejected, not accepted as a
summary.

### Waku — observed

Waku has a separate long-term-memory consolidation path. Every configured number
of exchanges it asks a small model to extract facts and an episode, with a
4,096-token output limit in the inspected implementation
(`waku/memory/consolidation.py:37-81`). Successful consolidation marks the raw
rows consolidated. If consolidation fails, it returns zero and leaves the raw
log unconsolidated; it does not replace the transcript.

Waku's retrieval gate decides whether to retrieve long-term memory for a turn and
fails open when that cheap decision call fails (`waku/memory/retrieval_gate.py:1-13`,
`:36-54`). This is retrieval policy, not transcript compaction.

### Inference and recommendation

The summarizer should be a named, durable sub-operation of the same session
runtime, with a configured auxiliary model and a main-model fallback. It must
produce a validated summary before any destructive/archive step. The prior
summary should be an input to the next compaction. Long-term-memory extraction
can coexist with compaction, but it must not be mistaken for the model-history
projection.

## Decision 5 — Large tool results and media

### Hermes — observed

Hermes creates a durable text projection for multimodal tool results. Image
parts can be represented as a screenshot marker in the persisted form
(`agent/session_persistence.py:92-103`). The compressor estimates image cost,
replaces image parts with placeholders where needed, retains only recent tool
images, and strips historical media after compaction; URLs remain handles while
data URLs become `[image]` (`agent/context_compressor.py:954-1006`,
`:1194-1225`, `:1363-1370`, `:2733-2736`, `:4530-4538`).

Provider media is materialized into a bounded cache under the Hermes home
directory. URL downloads are size-capped, partial files are removed on failure,
and the provider can fall back to the original URL
(`agent/provider_media.py:1-7`, `:19-42`, `:45-89`). Tests cover downgrading tool
image content when a provider cannot accept it while preserving user images
(`tests/run_agent/test_multimodal_tool_content_recovery.py:1-21`, `:82-168`).

Hermes also bounds tool-output text and forces redaction for text entering
compaction because summaries re-enter future prompts
(`context_compressor.py:1002-1006`).

### Waku — observed

The inspected Waku session and memory paths do not contain an equivalent
media-specific transcript projection, provider media cache, or compaction policy.
Its persisted exchange is a text pair and its current-turn loop contains the
provider messages and tool results in memory (`waku/runtime/session.py:90-107`,
`waku/loop/agent.py:63-110`).

### Inference and recommendation

Large tool results should be split into a durable artifact and a bounded model
projection. The transcript should retain a stable artifact ID, MIME/type and
size metadata, a short textual preview, and a retrieval handle. Media should be
referenced or downgraded before compaction, not silently dropped from the audit
record. The model-facing projection must be bounded independently from the
artifact's retention policy.

## Decision 6 — Concurrent turns, leases, and queueing

### Hermes — observed

Hermes acquires a durable session turn lease before processing. A second turn
waits for the lease, emits waiting status, and after acquisition resolves the
latest compression child and reloads the latest conversation
(`agent/turn_facade_lease.py:232-301`). If the wait expires, Hermes fails closed
with a clear timeout response and does not process the message
(`turn_facade_lease.py:304-340`).

Compression has its own lock/lease and commit fencing. Appends can continue
during a slow compression, but the commit is accepted only from the valid holder;
the watermark tests verify that racing appends survive and that a lost lease
cannot overwrite the original transcript (`tests/test_compression_watermark_commit.py:44-170`,
`:200-340`; `tests/test_hermes_state_compression_busy_retry.py:1-14`).

Before executing a tool side effect, Hermes persists the assistant tool-call
message and flushes it. If persistence fails, it does not execute the tool
(`agent/turn_tool_round.py:1-4`, `:45-55`, `:96-159`).

### Waku — observed

Waku serializes turns by using one worker thread per async gateway and one Waku
instance/session in that executor (`waku/gateway/runner.py:34-85`). SQLite is
configured with a three-second busy timeout (`waku/db.py:98-106`). The inspected
source does not show a cross-process session lease or a queue/rejection contract
for multiple workers.

### Inference and recommendation

For durable execution, the Hermes pattern is the relevant one: one ordered turn
lease per logical session, explicit waiting/timeout behavior, and a separate
compaction lease with watermark fencing. Do not let two turns build from the
same stale transcript. If parallel work is allowed inside one turn, the parent
turn should own the lease and each tool operation should have its own durable
identity; completion must be joined before the assistant response is committed.

## Decision 7 — Compaction failure semantics

### Hermes — observed

Hermes classifies summary failures. Terminal failures — including timeout,
access, quota, network, empty output, and truncation — preserve the session and
the unchanged transcript. Generic failures can use a deterministic fallback when
configured; otherwise the compressor aborts according to its failure policy
(`agent/context_compressor.py:592-646`, `:3439-3505`, `:4382-4448`).

The default constructor sets `abort_on_summary_failure=False`, but the source
still preserves the original transcript for terminal failures and validates
fallback output before assembling the compressed context
(`context_compressor.py:2255-2300`, `:4428-4448`, `:4649-4705`). A failed or
fenced-out durable commit does not partially replace the active transcript
(`tests/test_compression_watermark_commit.py:125-170`).

### Waku — observed

Waku's memory consolidation failure returns zero and leaves the source rows
unconsolidated (`waku/memory/consolidation.py:45-81`). It does not treat a failed
extraction as permission to delete or replace raw chat.

### Inference and recommendation

Compaction must be transactional from the transcript's perspective: no valid
summary, no replacement. A deterministic fallback can be useful, but it must be
explicitly marked as fallback, bounded, and validated; it must never hide a
terminal provider or quota failure. The user-facing run should report that
compaction was deferred or failed rather than pretending the context was safely
reduced.

## Decision 8 — Legacy and incomplete sessions

### Hermes — observed

Hermes restores older records into the current conversation shape, preserving
tool-call IDs, tool names, reasoning, provider content, and persisted markers
(`hermes_state_messages.py:774-836`). It can repair alternation in the loaded
model projection without rewriting the durable transcript. Resume resolution
follows compression lineage and has a bounded depth (`hermes_state_messages.py:687-726`).

The persistence path removes ephemeral scaffolding and dangling tool-result or
assistant-tool-call pairs produced by failed empty-response recovery before the
next durable flush (`agent/session_persistence.py:332-353`). The repository has
focused tests for alternation repair, resume resolution, compacted-message
loading, archive siblings, and multimodal tool-content recovery:
`tests/hermes_state/test_restore_alternation_repair.py`,
`test_resolve_resume_session_id.py`, `test_get_messages_include_compacted.py`,
`test_replace_messages_archive_siblings.py`, and
`tests/run_agent/test_multimodal_tool_content_recovery.py`.

### Waku — observed

Waku's current session can reload recent paired rows, but the inspected source
does not show a durable repair pass for incomplete structured tool calls. Its
memory log is intentionally a simpler user/assistant pair representation
(`waku/memory/__init__.py:109-139`).

### Inference and recommendation

Legacy/incomplete records should be readable without being silently presented as
complete. The loader should distinguish:

- a valid completed turn;
- a turn with a persisted tool call awaiting a result;
- a turn with an incomplete or malformed message;
- a compacted lineage whose child must be resumed.

Repair should be a model-projection operation by default. Durable deletion or
rewriting should require an explicit migration rule and evidence that the
record is unrecoverable.

## Decision 9 — Retention and redaction

### Hermes — observed

Hermes supports non-destructive archive. Auto-archive defaults to idle sessions
after three days, with a 24-hour minimum interval and pinned-session exemption
(`hermes_state_sessions.py:1571-1605`). Archive keeps messages. Explicit delete
removes session/messages and delegate children, while branches and compression
children can become orphaned (`hermes_state_sessions.py:831-880`, `:1433-1473`).

Compacted rows remain available for display/recovery while inactive model rows
are excluded from the active model projection (`hermes_state_messages.py:508-568`).
Redaction is applied to persisted exports and content; compaction forces
redaction because summaries are later reintroduced into prompts
(`agent/session_persistence.py:426-433`, `agent/context_compressor.py:1002-1006`).
The summary prompt also explicitly forbids API keys, tokens, passwords, secrets,
and credentials (`context_compressor.py:3315-3322`).

### Waku — observed

Waku's inspected chat path keeps raw chat rows in `state.db`. Facts and episodes
are derived from that database and `MEMORY.md` is a generated view, not the
source of truth (`waku/memory/__init__.py:166-190`). The inspected sources do
not show a chat retention schedule or secret-redaction policy. Consolidation
marks rows but does not delete them (`waku/memory/consolidation.py:37-81`).

### Inference and recommendation

Retention should distinguish active model context, archived transcript, and
external artifacts. Redaction should happen at every boundary where content can
be persisted or reintroduced into a prompt: raw message projection, tool-result
projection, summaries, logs, exports, and artifact previews. Soft archive should
be the default lifecycle operation; explicit deletion should define how lineage,
artifacts, and derived memories are handled.

## Decision 10 — Reset semantics, version, and deployment

### Hermes — observed

Hermes records reset/end reasons and lineage rather than treating reset as an
in-memory clear. It keeps a monotonic conversation-generation counter even when
rows are removed (`hermes_state_common.py:119-164`, `:409-435`). Compression
creates a new live child/tip and the parent can be closed with a compression end
reason (`hermes_state_sessions.py:687-726`; `tests/test_compression_watermark_commit.py:231-340`).
The source also contains legacy compatibility paths for older reset records
(`hermes_state_common.py:152-164`).

The inspected Hermes sources establish durable schema and compatibility behavior,
but do not, by themselves, establish a complete deployment/version policy for
rolling upgrades. That part remains an open operational question in this local
source comparison.

### Waku — observed

Waku uses one local SQLite database and describes `state.db` as the source of
truth while `MEMORY.md` is generated (`waku/db.py:1-5`,
`waku/memory/__init__.py:166-182`). Its migration helper is additive: it adds
missing columns when opening the database (`waku/db.py:79-95`). The inspected
sources do not show a durable schema-version/rollback framework or a deployment
protocol for coordinated session migration.

### Inference and recommendation

Reset should be an explicit durable event that creates a new generation while
retaining lineage metadata. Deployment must not silently reset active sessions.
Schema and event-contract changes should be versioned and backward-readable;
older records should be migrated or projected through a compatibility adapter
before they enter a new compaction cycle. A deployment should be able to roll
back without losing the canonical transcript, and a compaction already in flight
must be lease-fenced across worker versions.

## Direct answers to the ten decisions

These are recommendations derived from the evidence above, not additional
observations about Hermes or Waku:

1. **Session identity:** use stable routing identity plus monotonic physical
   session generations; reset and real end are different lifecycle events.
2. **Canonical transcript:** make a durable structured message store canonical;
   derive separate active-model and full-display projections.
3. **Model changes:** keep the transcript, scope model selection to the session,
   and recompute the context budget before every call or model switch.
4. **Summarizer:** use a named auxiliary compression call with validated output,
   prior-summary input, and a main-model fallback.
5. **Large results/media:** store bounded model projections plus durable artifact
   references; do not let raw media or unbounded tool output consume the prompt.
6. **Concurrency:** serialize turns with a durable lease/queue; allow only
   explicitly owned parallel operations inside a turn and join them durably.
7. **Failure:** preserve the original transcript unless a validated summary is
   committed atomically; surface deferred/failed compaction clearly.
8. **Legacy:** repair the model projection conservatively and retain durable
   evidence of incomplete work.
9. **Retention/redaction:** soft-archive by default, delete explicitly, and
   redact both persisted content and all prompt-facing projections.
10. **Reset/deployment:** version the transcript/event contract, preserve lineage,
    and fence in-flight compaction across deployments.

## Limits of the evidence

This comparison is grounded in the local source snapshots requested. Waku is a
small local assistant and therefore does not implement every durable-execution
concern that Hermes implements. Absence claims above mean “not found in the
inspected source paths,” not proof that no related behavior exists elsewhere in
those repositories. The recommendations are architectural conclusions from the
observed behavior and should be validated against the target runtime's actual
storage and worker model before implementation.

## Source index

### Hermes

- `/home/enoch/aworkspace/agents/hermes-agent/hermes_state_common.py:119-164,409-435`
- `/home/enoch/aworkspace/agents/hermes-agent/hermes_state_sessions.py:271-360,383-413,429-461,687-726,831-880,1433-1473,1571-1605`
- `/home/enoch/aworkspace/agents/hermes-agent/hermes_state_messages.py:265-315,508-568,628-655,687-750,774-858`
- `/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py:592-646,954-1006,1194-1225,1363-1370,1636-1638,1780-1797,2138-2170,2211-2300,2733-2736,3158-3335,3439-3505,4382-4705`
- `/home/enoch/aworkspace/agents/hermes-agent/agent/session_persistence.py:92-103,179-215,291-395,332-353,426-458`
- `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_context.py:1644-1649`
- `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_facade_lease.py:232-340`
- `/home/enoch/aworkspace/agents/hermes-agent/agent/turn_tool_round.py:1-4,45-55,96-159,188-214`
- `/home/enoch/aworkspace/agents/hermes-agent/agent/provider_media.py:1-7,19-42,45-89`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/test_compression_watermark_commit.py:44-340`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/test_hermes_state_compression_busy_retry.py:1-14`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/tui_gateway/test_make_agent_provider.py:76-142`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/hermes_state/test_restore_alternation_repair.py`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/hermes_state/test_resolve_resume_session_id.py`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/hermes_state/test_get_messages_include_compacted.py`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/hermes_state/test_replace_messages_archive_siblings.py`
- `/home/enoch/aworkspace/agents/hermes-agent/tests/run_agent/test_multimodal_tool_content_recovery.py:1-21,82-168`

### Waku

- `/home/enoch/aworkspace/agents/waku-agent/waku/runtime/session.py:1-10,53-61,90-127`
- `/home/enoch/aworkspace/agents/waku-agent/waku/app.py:42-136`
- `/home/enoch/aworkspace/agents/waku-agent/waku/loop/agent.py:41-114`
- `/home/enoch/aworkspace/agents/waku-agent/waku/loop/models.py:260-281`
- `/home/enoch/aworkspace/agents/waku-agent/waku/config.py:67-83`
- `/home/enoch/aworkspace/agents/waku-agent/waku/db.py:1-5,64-106`
- `/home/enoch/aworkspace/agents/waku-agent/waku/memory/__init__.py:109-139,166-190`
- `/home/enoch/aworkspace/agents/waku-agent/waku/memory/consolidation.py:37-81`
- `/home/enoch/aworkspace/agents/waku-agent/waku/memory/retrieval_gate.py:1-13,36-54`
- `/home/enoch/aworkspace/agents/waku-agent/waku/gateway/runner.py:1-7,34-85`
- `/home/enoch/aworkspace/agents/waku-agent/waku/ops/settings_api.py:38-87`
