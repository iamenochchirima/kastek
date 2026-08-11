# ADR 0008: Temporal Cloud Initial Deployment

- Status: Accepted for the initial production proof of concept
- Date: 2026-08-11

## Decision

Use Temporal Cloud for the first production Agent Platform deployment. The API and worker
connect with the namespace endpoint, namespace, task queue, API key, and TLS configuration from
environment variables. The worker remains a separate private process and can be scaled
independently from the API.

## Local development

The default local stack also connects the Agent API and Worker to a dedicated Temporal Cloud
development namespace. This keeps local workflow testing close to the first production topology.
Set `TEMPORAL_MODE=local` to run against a local Temporal Server at `localhost:7233` instead.

## Operational controls

- Keep the Temporal Cloud trial expiry and billing owner in the deployment runbook.
- Configure spend alerts before enabling production traffic.
- Use a separate namespace and credentials for staging and production.
- Keep workflow IDs stable (`agent-run-<runId>`) so API retries do not create duplicates.
- Before the trial expires, provision self-hosted Temporal on Railway or move to another managed
  namespace; the Agent Platform contracts must not depend on Cloud-only APIs.
- Cut over by draining new run starts, allowing active workflows to finish or exporting their
  IDs, deploying the self-hosted worker/API pair, and resuming the same database-backed runs.

## Not proven locally

The repository contains the connection and worker configuration, but live retry, signal,
worker-restart, and multi-replica recovery must be exercised against the real namespace before
production approval.
