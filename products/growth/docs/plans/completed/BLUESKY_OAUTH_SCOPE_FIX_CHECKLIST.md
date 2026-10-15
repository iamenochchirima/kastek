# Bluesky OAuth Scope Fix Checklist

**Status:** Complete

## Diagnosis

- [x] Confirm the invalid scope is produced by the Bluesky access request path.
- [x] Confirm `transition:chat.bsky` is absent from the deployed Bluesky client metadata.

## Implementation

- [x] Mark Bluesky messaging unsupported until its metadata and adapter support it.
- [x] Remove Bluesky messaging from the selectable access list.
- [x] Keep publishing and deletion requestable through `repo:app.bsky.feed.post`.
- [x] Add regression coverage.

## Release and verification

- [x] Update documentation and release record.
- [x] Run targeted tests, full Core tests, frontend checks, and diff checks.
- [x] Commit and push the implementation.
- [x] Record final evidence and move the plan to `docs/plans/completed/`.
