# KasiAi media persistence repair

**Status:** Complete

**Owner:** platform-ops

**Last updated:** 2026-08-31

## Change

Persist Core content media across deployments and prevent source-key deduplication from returning
an asset whose storage object is missing. Restore the affected Instagram draft attachment from
its Telegram source and reattach it to the existing draft.

## Release record

| Field | Decision |
| --- | --- |
| Affected services and user surfaces | kasitek-core, Core media storage, KasiAi Instagram draft publishing |
| Platform release version or release ID | Core deployment `166ade2b-cee7-46dd-83d9-9bc09f893307`; persistent volume `core-volume` (`431bfc8d-c522-4862-bff1-aff335e15960`) mounted at `/data`; configuration `KASITEK_MEDIA_STORAGE_PATH=/data/media`. |
| API/schema/migration changes | No API or database schema change. |
| Feature flag or rollout method | Not applicable; persistent Railway volume attached to Core. |
| Analytics events and success metrics | No new events; existing media upload, publish, and delivery telemetry applies. |
| Logs, metrics, dashboards, and alerts | Core media read and storage errors remain in existing service logs. |
| Documentation | This release record; no public documentation change required. |
| Validation evidence | Core health returned OK; restored signed media endpoint returned HTTP 200 with `image/jpeg` and 81,554 bytes; Core media tests passed. |
| Rollback or disable plan | Redeploy the prior Core artifact and retain the volume; do not remove the volume while media rows reference it. |
| Post-release review date | 2026-09-01 |

## Verification checklist

- [x] Attach persistent storage and configure Core media writes to `/data/media`.
- [x] Restore and reattach the affected Telegram-sourced image.
- [x] Deploy Core and verify health and media retrieval.
- [x] Add a guard against reusing missing source-key assets.
