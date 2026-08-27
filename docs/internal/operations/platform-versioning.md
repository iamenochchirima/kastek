---
id: platform-versioning
title: Platform Versioning
sidebar_position: 3
owner: platform-ops
last_reviewed: 2026-08-25
---

# Platform Versioning

KasiTek uses one coordinated platform release version for a tested set of services, with the Git
commit and service artifact identifying the exact deployed code.

## Canonical release identity

The repository root `VERSION` file is the source of truth for the current platform release
version. Release tags use this format:

```text
platform-v<MAJOR>.<MINOR>.<PATCH>
```

Examples:

```text
VERSION                 0.1.0
release tag             platform-v0.1.0
service artifact        agents:platform-v0.1.0+abc1234
```

The version validator is intentionally read-only:

```bash
node scripts/release-version.mjs check
node scripts/release-version.mjs tag
node scripts/release-version.mjs metadata
```

It does not create tags or deploy services. A release tag is created only after the candidate
commit has passed the staging release gates.

## What each version means

| Identifier | Meaning |
| --- | --- |
| Git commit SHA | Exact source snapshot. |
| Platform release | Coordinated, tested KasiTek deployment. |
| Service artifact | A deployable client, Core, Tenants, Agents, or Analytics artifact. |
| API version | External compatibility contract such as `/api/v1`; it changes only for contract-breaking changes. |
| Migration version | Database schema history identifier. |
| Event schema version | Analytics or integration event compatibility identifier. |
| Agent version | Customer or system agent lifecycle version, independent of the platform release. |

Package versions in `package.json` and `Cargo.toml` remain package metadata. They are not the
platform release identity.

## Release rules

- Patch releases contain compatible fixes.
- Minor releases contain compatible product features.
- Major releases contain breaking platform contracts.
- Every deployed service must retain the platform version and Git SHA in its build metadata or
  runtime health response.
- Production must promote the exact artifact tested in staging.
- Release notes must identify the tag, commit, affected services, migrations, and rollback target.
- Database, API, event, and agent versions must not be changed merely because the platform version
  changed.

## Release sequence

1. Merge the reviewed change to protected `main`.
2. Build immutable candidate artifacts from the merge commit.
3. Deploy the candidate artifacts to staging.
4. Run migrations, health checks, smoke tests, and release-specific validation.
5. Create `platform-vX.Y.Z` on the exact tested commit.
6. Promote the same artifact digests to production.
7. Record the deployment and monitor the release.
8. Roll back to the previous release manifest and artifact set when rollback criteria are met.

The current implementation provides the canonical version file and CI tag validation. Artifact
manifests, runtime version endpoints, staging promotion, and rollback automation remain separate
implementation work.
