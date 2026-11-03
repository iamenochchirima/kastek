# Backup and restore

Owner: platform operations. Reviewed: 3 November 2026.

`infra/agents-runtime/backup-control.py` supplies encrypted snapshot, WAL archive/recovery, expiry,
deletion-ledger export and gated restore commands. The accompanying systemd units schedule a
nightly snapshot, a deletion export every five minutes, hourly expiry and a monthly isolated restore
check. Units are installation templates; no hosted schedule or storage destination is installed by
the source change.

## Defaults

| Data or operation | Default |
| --- | --- |
| Whole-platform snapshot | Nightly at 02:00 host time; encrypted with age before persistence |
| Database point-in-time recovery | Seven days; eight days of encrypted WAL allow the preceding daily base |
| Snapshot copies | Delete at 35 days; no indefinite monthly or yearly tier |
| Current deletion ledger | Export every five minutes to independently retained encrypted storage |
| Restore check | Monthly, isolated from production network and credentials |
| Recovery targets | At most 15 minutes lost and four hours to recover; targets require measured deployment evidence |
| Operational diagnostics | Agents-only journald namespace expires entries after 30 days |

Each nightly snapshot contains an independent PostgreSQL base backup (including its streamed WAL),
private object bytes/keys, a cleanly stopped Restate data directory, deletion ledger and versioned
manifest. PostgreSQL must be a dedicated Agents cluster without external tablespaces. The command
refuses a cluster containing another product's database. Object export must finish while all
application writers are stopped. A plain filesystem source is supported as `object_root` instead
of `object_export_command`; it must be the authoritative private object store or a complete export.
Symlinks and special files in copied object/Restate roots are rejected.

The snapshot hook must stop admission and all API/worker/automation/object writers, drain physical
operations, then stop Restate cleanly. Its independent stopped-writer check must fail unless these
conditions hold. The resume hook runs even when snapshot creation fails. Deployment service names,
S3 export and stop/check/resume commands are installation-owned; the example deliberately fails
until those commands and real paths exist. Never substitute a no-op stopped-writer check.

## Install

Install Python 3.12+, PostgreSQL client tools matching the cluster major, and the official `age`
binary. Object export may additionally require the deployment's S3 client. Create a private backup
directory (0700) on a dedicated backup volume with an independent failure domain. Keep configuration
root-owned and unwritable to application identities. Copy `backup.example.json` to a private
installation configuration and replace every placeholder. PostgreSQL connection secrets belong in
libpq's private service/password files, never command arguments. Backup commands use `PGSERVICE`.
The configured account needs replication/base-backup and catalog-read privileges; it does not need
normal product write access.
`pg_verifybackup` matching the server major validates each base before encryption and again after
restore extraction. Put that version's PostgreSQL client `bin` directory on the service PATH.

`staging_root` contains private plaintext while a backup/restore command runs. Mount it on tmpfs
with sufficient capacity and disabled/encrypted swap, or a private encrypted ephemeral volume.
Temporary directories are removed on ordinary success/failure; the deployment must remove abandoned
staging directories after a killed process. Never use an unencrypted persistent `/tmp` or copy this
directory into the backup repository. The script enforces private permissions; encryption of that
deployment-owned volume and swap must be verified during installation.

Generate the age identity on the isolated restore host. Put only its public recipient on the backup
host. The private identity must be outside every backup/source directory and must never be uploaded
with a snapshot. A restore-only configuration adds `age_identity` pointing to that private 0600 file.
Install OpenSSL 3 for Ed25519 artifact signatures. The primary host keeps separate private 0600
`snapshot_signing_key` and `ledger_signing_key` files outside all source, staging and backup roots.
Generate each using `openssl genpkey -algorithm ED25519`; export its verification key with
`openssl pkey -pubout`. Pin the resulting `snapshot_verify_key` and `ledger_verify_key` independently
on the restore host. Application identities and the backup repository cannot replace those pinned
keys. Snapshots and WAL ciphertext have detached `.age.sig` signatures that recovery verifies before
decryption. The independently refreshed ledger is a signed canonical JSON envelope encrypted with
age. Public-recipient encryption alone does not authenticate its exporter: a fabricated fresh empty
ledger must fail its exporter signature even if its age ciphertext decrypts successfully.
Keep application credential-vault keys and required deployment signing keys in a separately backed
up secret manager, preserving every key version referenced by retained data. A database snapshot
does not recover those keys. Do not place them in the same source directories or backup bundle;
restore them through the isolated host's approved secret procedure before checking credential or
workflow readiness.

Backups remain content-bearing sensitive data, even though ordinary operation logs contain only
bounded status identifiers. The storage account may write encrypted backups and apply the approved
expiry; the application account cannot read or delete that repository. Disable provider bucket
versioning/object-lock copies or configure their expiry to the same hard 35-day maximum; a local
file deletion does not establish deletion of hidden remote versions.

After verifying the installation commands manually, install the units from `backup-systemd/` and
enable the five timers. The fifth runs the snapshot/ledger/monthly-check freshness check every five
minutes. Adjust the source path and configuration path in their `ExecStart` if the
checkout is installed elsewhere. These root-owned operations can stop services and delete expired
backups. Inspect `prune` without `--apply` before enabling its timer. Do not enable timers against a
live environment as part of a local implementation check.

PostgreSQL WAL configuration uses `archive_mode=on`, `archive_timeout=300s` and an `archive_command`
that calls `backup-control.py --config ... archive-wal --source %p --name %f`, with installation paths
quoted for the PostgreSQL shell. The archive destination must be durable outside the database host.
Monitor PostgreSQL archiver failures and oldest unarchived WAL. The backup account stores only age
ciphertext plus a content hash used to reject a duplicate-name mismatch. Missing WAL prevents PITR;
the script never fabricates a segment or skips a failed archive.

The PostgreSQL `restore_command` invokes `restore-wal --name %f --target %p` using the restore-only
configuration. PostgreSQL owns recovery-target selection and timeline validation. Stop at a target
inside the retained window and verify recovery completed. A database-only PITR target later than
the nightly snapshot is not automatically a valid whole-platform recovery point: object custody
and Restate journal/operation receipts must be checked together. A missing object stays unavailable;
restoring an old journal must not repeat an uncertain external effect.

## Restore gate

1. Isolate a dedicated restore host, database, object store and Restate instance. Do not route any
   product traffic or channel delivery to it.
2. Run `restore-stage --snapshot PATH --target NEW_DIRECTORY`. It refuses an existing target,
   validates archive paths, decrypts the bundle and writes `RESTORE_BLOCKED.json`. It starts no
   services and admits no work. A failed or interrupted stage remains blocked.
3. Start only isolated PostgreSQL recovery from the staged base. Restore private object bytes and
   Restate to their matched staged locations. Complete any explicit PostgreSQL PITR before replay.
4. Obtain the latest independently retained `current-deletions.age`. It must have been exported
   after the snapshot and within 15 minutes of this verification; a stale, unavailable or incomplete
   ledger blocks the release. The ledger carried inside an old snapshot is insufficient.
5. Run `restore-release --target DIRECTORY --ledger CURRENT_LEDGER`. The command decrypts and checks
   the current ledger, invokes the actual retention replay CLI, then the installation's cross-store
   recovery check. The latter must verify database schema/recovery completion, object custody,
   Restate version/journals, disabled external delivery and the task/operation replay boundaries.
6. Only success removes the block marker and writes `RESTORE_VERIFIED.json`. That marker is evidence,
   not automatic promotion. An operator separately authorizes routing/access and starts application
   writers. Never bypass the check by manually deleting the blocked marker.

Deletion replay requires the ledger envelope `exportedAt`, `complete: true`, `conversations` and
`memory`. The retention ledger CLI exports every current deletion tombstone and fingerprint, and
replays it against the isolated database through `--ledger PATH --database-service NAME`. Replay
must fence deleted conversations and forgotten-memory namespaces before any data becomes available.
Keep this current ledger independently of expired snapshots; do not expire deletion identities
while an older snapshot, supported replay or unresolved effect can still reference them.

The monthly restore-check command must perform this stage/replay/check sequence on disposable
resources. It must return nonzero on failed custody, deleted-content resurrection or failed replay
checks and remove only its own fixture resources. The CLI records completion time and duration only
after it returns successfully. A hook exit code does not establish a measured hosted RPO; record
the latest recoverable transaction time and end-to-end service recovery time in the deployment
release evidence. Current repository validation does not claim a hosted restore passed.

## Monitoring and rollback

Send the bounded `agents.backup.*` and `agents.restore.*` JSON events to the existing operations
destination. Alert on a failed job, snapshot age over 26 hours, WAL archive lag over 15 minutes,
deletion export lag over 15 minutes or restore-check age over 32 days. These alert rules and the
destination are deployment configuration; the source does not provision a monitoring service.
No prompt, memory, credential or raw command error is logged by this CLI.

Install `journald-kasitek-agents.conf` at
`/etc/systemd/journald@kasitek-agents.conf.d/retention.conf`. Install
`agents-log-namespace.conf` as a drop-in only for the Agents API, worker, automation and reaper units.
The supplied backup units use that namespace already. Restart affected units at an approved idle
boundary. This does not change host-wide journald policy or retention at an external log exporter.
Configure that destination to the same 30-day maximum without content bodies.

To roll back scheduling, disable the five timers and restore the previous service configuration.
Do not delete recoverable backups or deletion ledgers as a rollback shortcut. Recovery tools can be
reverted without modifying product data; application rollback still follows its schema and effect
receipt compatibility rules.

Release impact: new operational commands and installable schedules; no product API or database
migration. Analytics events, browser UI and platform version change are not applicable. Bounded
operation events reuse the existing stdout collection path; no Collector/exporter configuration is
changed. Private storage, key custody, actual hooks, hosted scheduling, alert destinations and
measured restore evidence remain installation requirements. Promote no hosted completion claim
until these are configured and verified in that environment.
