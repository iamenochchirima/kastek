# Retention defaults

Owner: Agents engineering. Reviewed: 2026-11-03.

The shared worker applies these defaults to every agent. Product authorization, source withdrawal,
memory generation fences and effect reconciliation remain independent checks.

| Records | Default |
| --- | --- |
| Conversation originals, linked artifacts and checkpoints | No automatic age expiry. User deletion withdraws retrieval and cancels affected work; it is not a claim that every stored original was physically erased. |
| Optional conversation inactivity policy | 90 days since the latest task activity, scoped to one organization. Off unless explicitly configured. |
| Accepted memory | Retained until correction, Forget or explicit expiry. |
| Superseded learned-memory revision bodies | Purged after 30 days since supersession. |
| Forgotten learned-memory revision bodies | Immediately eligible for worker cleanup, within the seven-day removal target. Recall is suppressed in the Forget transaction. |
| Effect receipts | Preserve minimal reconciliation, identity and accounting metadata for at least 365 days after reconciliation and the supported retry window. Unresolved effects never age out. The runtime retains these identities; this change installs no automatic receipt deletion. |
| Operational logs | 30 days in the supplied Agents-only journald configuration. Source task events are conversation records, not disposable diagnostic logs. |
| Backups | Nightly encrypted snapshots, seven-day database PITR and a hard 35-day snapshot expiry. Monthly isolated restore check. |

Memory cleanup preserves digest fingerprints, suppression identities and deletion tombstones so
pruning a body cannot make forgotten content eligible again. Independent source conversations,
context copies, artifacts, effect receipts and already-transmitted provider data follow their own
custody rules. Forget is not an assertion of complete physical erasure across those stores.
See [memory retention](memory-retention.md) for exact cleanup and recovery behavior.

## Optional conversation expiry

Apply schemas111–113 before deploying the worker. The default maintenance loop performs bounded
memory cleanup and conversation expiry. The policy excludes retention-held conversations and all
customer Inbox-bound conversations. Active/uncertain work or operations anywhere in the relevant
root protect it from expiry. The locked recheck serializes against admission, so a new turn prevents
an old candidate from expiring. Expiry uses the existing logical deletion and cancellation boundary,
forgets source-linked personal/product memories, and records a permanent conversation tombstone.
It does not remove business records in Growth or Agency.

An installation operator can opt an organization in or out using the private database service:

```sh
pnpm --filter @kasitek/agents retention:ledger set-policy --organization ORGANIZATION_UUID --days 90 --operator OPERATOR_ID --database-service agents-maintenance
pnpm --filter @kasitek/agents retention:ledger set-policy --organization ORGANIZATION_UUID --days never --operator OPERATOR_ID --database-service agents-maintenance
```

The maintenance account is deployment-owned. Do not expose this CLI or its database credentials to
the model or browser. No organization is opted in by this source change. A hold is stored as
`conversations.retention_hold`; deployment maintenance may set it for a scoped conversation before
enabling expiry. Expiry does not hard-delete transcript rows or files; an archive/physical-erasure
lifecycle requires a separate explicit data-custody operation.

## Restore deletion fences

`retention:ledger export --output PRIVATE_FILE --database-service agents-maintenance` exports an
untruncated repeatable-read snapshot of conversation tombstones and memory deletion fingerprints.
The file is created atomically with mode0600. The backup exporter signs it and stores the encrypted
current copy independently from nightly snapshots. Restrict this ledger to backup/restore operators.

`retention:ledger replay --ledger PRIVATE_FILE --database-service agents-restore` requires a private
regular file with a complete version1 ledger exported within 15 minutes. The authenticated backup
restore command verifies exporter provenance before invoking it. Replay applies conversation deletion,
normal cancellation intent, memory suppression and generation fences in one transaction. Deleted
conversation identities cannot be recreated.
The CLI alone does not establish that a supplied ledger came from the authoritative exporter.

The [backup runbook](backups.md) describes signed ledger custody, schedules, encrypted storage,
isolation, restore gates and deployment requirements.

## Release and rollback

Changes: schemas111–114, default worker maintenance, optional operator policy and ledger commands,
and installable backup/logging configuration. Schema114 removes the manual provider attestation
feature at the owner’s direction. Deploy the schema before the API/worker at an idle boundary.
Hosted schedules, credentials, paths,
retention at external log destinations and recovery targets require installation evidence.

No new analytics event, browser telemetry, Collector/exporter or platform release tag is introduced.
Existing bounded maintenance/failure logs identify cleanup and denial without content. No production
cleanup or hosted deployment is performed by the local implementation checks. Rollback disables
maintenance/schedules and restores compatible code after draining; retain suppression identities and
deletion ledgers. Dropped memory bodies cannot be restored as a rollback shortcut.
