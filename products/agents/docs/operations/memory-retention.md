# Learned-memory retention

Owner: Agents engineering. Reviewed: 12 November 2026.

Accepted memory has no automatic expiry unless its record explicitly supplies one. Correction
starts a 30-day retention period for the superseded revision body. Forget immediately removes the
current learned-memory text from recall, advances the namespace fence and suppresses every retained
revision digest. Schema111 keeps revision fingerprints separately so pruning an old body cannot
make that forgotten content eligible for a later proposal.

The normal Agents worker runs memory maintenance by default. It checks at least once per minute
while idle, processes at most 100 revision bodies per batch and retries after failures. Forgotten
revision bodies are immediately eligible for cleanup, meeting the seven-day active learned-memory
store purge target when the worker and database are available. Superseded bodies become eligible
30 days after supersession, rather than 30 days after their original creation. Cleanup replaces
only revision content with an empty string and records `content_purged_at`; it retains revision,
digest, review classification, suppression and mutation identity. Current accepted records are not
pruned. `purged_at` on `memory_deletion_tombstones` reports this learned-memory-store cleanup only.

The maintenance loop also invokes the optional conversation-expiry policy. Both operations resume
from durable rows after restart; multiple workers use row locks and bounded batches. Shutdown waits
for the current maintenance operation. The standalone `start:memory-retention` command is available
for an operator-managed separate process. Running both is safe but unnecessary.

Forget does not delete independent conversation originals, immutable model request custody,
context/checkpoint copies, operation receipts, artifacts, Restate journals or already-transmitted
provider data. Those records remain fenced from future learned-memory use and follow their own
retention and deletion procedures. The seven-day statement applies to learned-memory store bodies;
it is not a promise that every independent record containing the same fact is physically erased.
An unavailable maintenance worker leaves due content retained but suppressed; investigate
`MEMORY_RETENTION_PENDING` without restoring recall or deleting effect receipts.

## Context injection

Memory is opt-in per internal agent. Behaviour → General exposes the toggle only when the agent has
no customer offering and uses a program that supports personal memory. Enabling it adds
`memory.search`, `memory.read` and `memory.propose` to the configuration and grants
`memory.read`/`memory.propose` for execution. Customer-facing agents cannot enable memory, and
website or channel deployments still reject it.

Before the first model call, an eligible human turn reads at most eight accepted memories relevant
to the current input, plus recent records when the query has no useful terms. It injects
1,200-byte excerpts with the memory id, revision, assertion context and update/expiry times.
A truncated record is marked as an excerpt, and `memory.read` returns the full accepted record.
Candidates are never injected. The turn records a `context.memory_retrieved` task event with the
scope generation, retrieved and kept counts, injected bytes and next page offset. No query
text or memory content is written to the event.

The pre-loop read applies to eligible internal human turns, not only channel-bound turns. Visitor
and customer principals never receive personal memory. The memory profile is currently off or
personal; team scopes, automatic post-turn consolidation and embedding-ranked recall remain
separate workstreams in the parked memory plan.

## Restore deletion fences

`export_memory_deletion_ledger()` returns tombstones, scope generation and all revision fingerprints.
The backup lifecycle must retain the current ledger independently of the snapshot being restored.
Before exposing a restored database, apply `replay_memory_deletion_ledger(jsonb)` in the offline
restore transaction, followed by the conversation-deletion ledger and memory cleanup. Replay checks
scope and digest identity, clears an older restored memory, restores all known suppressions and
advances its namespace generation to at least the exported fence. It is idempotent and preserves a
tombstone even when the old snapshot has no corresponding memory or namespace. A missing, malformed
or incomplete deletion ledger must keep the restored environment unavailable.

The runtime does not erase provider copies. Backup expiry, restore gating and private-provider
eligibility are separate operational controls. Do not advertise physical erasure from an ordinary
Forget acknowledgement or a successful memory-store cleanup count.

## Release and rollback

Memory context injection is configuration-driven and needs no migration. Rollback removes the
pre-loop read and the Behaviour toggle; stored memories, candidates, revisions and deletion fences
remain intact. Disabling memory on an agent removes its memory tools and stops injection on the
next published version.


Apply schema111 before starting the updated worker. It backfills fingerprints, existing forgotten
tombstones and historical supersession times without deleting bodies during migration. No task,
effect, source or model contract changes. Existing cleanup logs report counts and bounded error
codes without content; no additional analytics, dashboard or release identity is introduced.
Rollback stops the new maintenance process and restores the earlier worker code. Already-pruned
revision bodies are intentionally unrecoverable from the live store; never restore an old backup
without replaying deletion fences. Deployment scheduling and backup-host verification remain
operator responsibilities.
