# Hermes and Waku approval investigation

**Status:** Read-only investigation; no implementation decision made

**Date:** 2026-09-11

**Scope:** How Hermes and Waku handle approval, especially when one model turn
produces several tool calls. This note compares those systems with the current
Kasitek approval path. It does not change the active plan or implementation.

## Findings

### Hermes

Hermes has a host-owned approval gate with explicit scopes:

- `once` approves one operation.
- `session` remembers the approval pattern for the current session.
- `always` writes the pattern to a persistent allowlist.
- `deny` blocks the operation.

The session and persistent caches are keyed by a policy or pattern key, not by
the latest provider call ID. The shared gate checks those caches before asking
again, then persists the selected scope after the human decision.

Sources:

- [`tools/approval.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/approval.py:291)
- [`tools/approval.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/approval.py:312)
- [`tools/approval.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/approval.py:783)
- [`tools/approval_prompt.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/approval_prompt.py:20)

Hermes also supports an explicit bulk command. `/approve all` resolves every
currently queued gateway approval for that session. `/approve all session` and
`/approve all always` apply the selected scope to each queued approval. A
specific request can still be resolved by `request_id`. This means bulk approval
does not remove request identity; it chooses several already-queued requests as
the target set.

Sources:

- [`tools/approval.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/approval.py:137)
- [`gateway/slash_commands.py`](/home/enoch/aworkspace/agents/hermes-agent/gateway/slash_commands.py:1128)
- [`locales/en.yaml`](/home/enoch/aworkspace/agents/hermes-agent/locales/en.yaml:76)

Hermes does not blindly approve every future external write by default. An
untrusted MCP server requires approval for every write-capable call, and the
MCP trust gate intentionally offers only per-call consent. Missing or malformed
read-only metadata fails closed.

Sources:

- [`mcp-config-reference.md`](/home/enoch/aworkspace/agents/hermes-agent/website/docs/reference/mcp-config-reference.md:70)
- [`mcp_tool_handlers.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/mcp_tool_handlers.py:38)
- [`approval_prompt.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/approval_prompt.py:288)

Hermes runs independent tool calls concurrently, but it does not let approval
prompts race across the user interface. `_ConcurrentToolAuthorizationGate`
serializes policy and approval prompts, while the tool batch keeps separate
operation results and enforces a bounded deadline. Tool-batch planning also
prevents conflicting file writes from running in parallel, and MCP servers must
opt into parallel tool calls.

Sources:

- [`tool_executor.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/tool_executor.py:450)
- [`tool_dispatch_helpers.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/tool_dispatch_helpers.py:182)
- [`mcp-config-reference.md`](/home/enoch/aworkspace/agents/hermes-agent/website/docs/reference/mcp-config-reference.md:65)

When several identical approval requests are waiting, Hermes can coalesce them.
A shared `session`, `always`, or `deny` decision is adopted by the followers. A
`once` decision applies only to the leader, so the followers still require their
own decision. Hermes also has a separate staged-write queue for memory and
skills, where an explicit `approve all` applies an already-reviewed batch. That
is a batch operation, not a blanket approval for future tools.

Sources:

- [`approval_gateway_wait.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/approval_gateway_wait.py:105)
- [`write_approval.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/write_approval.py:73)
- [`skill_manager_batch.py`](/home/enoch/aworkspace/agents/hermes-agent/tools/skill_manager_batch.py:103)

The important distinction is that Hermes has both a per-operation approval
record and a policy-level grant. The former identifies exactly what is waiting;
the latter prevents needless re-prompts when the user has deliberately widened
the scope.

### Waku

Waku's ordinary agent loop does not currently implement a general user approval
gate. It appends the assistant response, executes each requested tool through
the registry, appends the tool results, and asks the model to continue. The
registry turns tool exceptions into model-visible error text, but it does not
pause for approval.

Sources:

- [`waku/loop/agent.py`](/home/enoch/aworkspace/agents/waku-agent/waku/loop/agent.py:41)
- [`waku/tools/registry.py`](/home/enoch/aworkspace/agents/waku-agent/waku/tools/registry.py:47)

Waku's graph design mentions a future `human_node` for pauses and approval
gates, but the current graph package does not implement a general approval
policy. Its connector OAuth and operating-system permission prompts are
provider or host permissions, not approval of each model tool call.

Sources:

- [`agent-graphs-design.md`](/home/enoch/aworkspace/agents/waku-agent/docs/agent-graphs-design.md:103)
- [`google_calendar.py`](/home/enoch/aworkspace/agents/waku-agent/waku/tools/google_calendar.py:88)

Waku does have an explicit proposal boundary in the gather workflow. That
workflow gives the model no write tools and writes only a draft for a human to
review. This is a workflow-specific safety rule, not a reusable approval system.

Source:

- [`gather.py`](/home/enoch/aworkspace/agents/waku-agent/waku/graph/workflows/gather.py:25)

## Kasitek comparison

Kasitek already stores the right identity fields for exact approval: run ID,
provider tool call ID, runtime operation ID, argument hash, preview revision,
policy revision, resource snapshot, and effect key. It also creates one approval
record per runtime operation.

The current problem is cardinality and coordination:

1. The repository exposes only the newest approval for a run through
`getForRun()`.
2. The Temporal workflow waits for one `waitingCall` and matches the decision to
that exact operation and argument hash.
3. The Studio client stores one `approval` object and submits one call identity.
4. A parallel batch can therefore create many pending approvals while the UI
shows one. Approving the newest record can be compared against the oldest call
Temporal is waiting on, producing the stale or mismatched approval error.

Sources:

- [`approval-repository.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/db/repositories/approval-repository.ts:75)
- [`approval-repository.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/db/repositories/approval-repository.ts:105)
- [`workflows.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/agents/src/temporal/workflows.ts:593)
- [`agent-platform.ts`](/home/enoch/aworkspace/kasitek-labs/kasitek/client/apps/client/src/lib/agent-platform.ts:660)
- [`studio-page.tsx`](/home/enoch/aworkspace/kasitek-labs/kasitek/client/apps/client/src/components/dashboard/studio/studio-page.tsx:402)

## What this tells us

"Approve all" should not mean "disable approval forever." Hermes uses two
separate ideas:

- a bounded target set, such as all approvals currently queued for one session;
- a grant scope, such as once, this session, or persistent policy.

For Kasitek, the natural bounded target is the immutable tool batch or approval
group that Temporal has already planned. Each operation still needs its own
exact identity and effect receipt, but one human decision can authorize the
whole reviewed group when the policy allows it. A future session-level grant
would need an explicit capability/resource scope. It should not be inferred
from a single calendar delete or silently cover unrelated tools.

That is the approval design question still to settle. No code or active plan was
changed as part of this investigation.
