# Shared runtime rollout

A shared runtime release includes publishing current system contracts to existing active agents.
Deploying the API and worker alone does not update immutable published configurations.

Run the operator command from the repository root using the release's Node 24 environment and
Agents database/service configuration. It does not call a model or execute business tools.

```sh
pnpm --filter @kasitek/agents control:runtime preview
pnpm --filter @kasitek/agents control:runtime apply <preview-digest>
```

The compiled release, inventory, exclusions, affected task IDs and planned immutable version IDs
are returned as JSON. Review and retain this report with the release evidence. Apply recomputes
the plan under organization and publication locks; a stale digest requires another preview.
An identical repeated apply is a no-op.

## Coverage

The inventory includes the latest published version of every undeleted agent, active website
and connected-channel deployments, enabled product features in non-revoked product tenants,
active automations and the specialist versions reachable from those roots. Paused, revoked,
disabled and evaluation publications are excluded and counted in the report.

The command compiles the same business configuration against the installed platform contracts.
It preserves instructions, sources, model selections, connected bindings, product adapter
references, business tool assignments, effect permissions and deployment IDs. Missing installed
adapter or binding dependencies block the preview rather than selecting another business tool.
It creates new immutable versions, pins parents to their corresponding updated specialists and
moves only active publication pointers. Source and connected-tool references are copied exactly.

Unsaved draft content remains unchanged. A pristine draft follows only its updated published
specialist references. Draft revision stamps advance to reserve immutable
snapshot revisions and invalidate concurrent editors. Product feature revisions also advance
above those reserved stamps so normal later saves cannot collide. Managed configuration digests
advance only when the prior digest described the published configuration; customization markers
remain unchanged. Managed specialist baselines remap only updated version references.

Older pinned specialist snapshots are refreshed before the definition's latest publication. If
an older snapshot needs a new version, the current definition receives a final snapshot even when
its platform contracts are already current. Its newer business configuration remains the latest.

Automation changes create a new immutable revision with the same schedule/configuration and
model-route snapshot, then enqueue its timer revision. Existing occurrences retain their accepted
revision and routes. Existing grants, tasks, conversations and historical snapshots are untouched.
Website and channel ingress already create a fresh grant for each new turn; existing sessions
therefore adopt the updated publication on their next message. Staff and product turns use their
existing current-configuration admission paths.

## Delivery order and failure handling

1. Deploy compatible API/worker code and complete required schema setup. Register the worker's
   current Restate manifest before publishing new workflow references. When reusing an existing
   worker URI, refresh its registration and verify that the current and retained workflows are
   listed; a successful response for an already registered URI alone is insufficient.
2. Close new admissions using the existing platform admission control.
3. Preview the rollout. Allow affected accepted tasks to drain without cancelling them.
4. Apply the reviewed digest. Apply refuses while affected tasks remain nonterminal.
5. Record the applied report and serving release identities, then reopen admissions.
6. Verify one normal new conversation uses the current runtime and bindings.

Failures roll back the entire database transaction. Do not edit immutable versions or accepted
grants to recover a rollout. If the running release must be rolled back after publication, pause
admissions first and deploy code that supports the newly published contracts, or prepare an
explicit reviewed forward publication using compatible installed contracts. Repointing a public
deployment to an older version without considering accepted tasks is not a safe rollback.

## Release record

- Owner: Agents platform release operator.
- Risk: standard; active publication pointers and immutable snapshots change together.
- Affected surfaces: staff/product agents, website widgets, connected channels and automations.
- Release identity: command revision plus shared harness/workflow in the JSON report; record API,
  worker and UI release identities alongside it.
- API/schema migration: no new HTTP endpoint or schema migration; existing tables are used.
- Rollout: explicit environment-scoped preview/apply with digest checking and drain refusal.
- Analytics: not applicable; this is an operator action with no new user event.
- Observability: bounded JSON reports contain IDs, versions, exclusions and error codes; private
  instructions, message bodies, credentials and tool payloads are not logged.
- Documentation: this runbook.
- Validation: focused native PostgreSQL rollout fixture; API build and changed-file lint.
- Rollback: transaction rollback before commit; admission pause and compatible release after commit.
- Post-release review: record the one new-conversation verification with the deployment evidence.
