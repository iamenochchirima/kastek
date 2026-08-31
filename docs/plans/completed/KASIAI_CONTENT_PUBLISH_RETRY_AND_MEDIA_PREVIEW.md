# KasiAi publish retry and media preview

**Status:** Complete — production deployed; provider retry remains user-triggered

**Owner:** platform-ops

**Last updated:** 2026-08-31

## Objective

Allow an approved content publish to recover from a transient media-read failure, allow a new
explicit retry after a failed publish, and show attached images in Telegram and WhatsApp replies
when the user asks to confirm them.

## Root cause

The Instagram publish attempt used a signed Core media URL. Core's public media endpoint briefly
failed its database lookup with HTTP 500, so Instagram received a non-media response and returned
`Only photo or video can be accepted as media type.` The failed Core job retained its first
idempotency marker, so the next user retry was rejected with HTTP 409 before it could try again.

## Scope

- Retry transient public-media metadata reads in Core.
- Permit a fresh idempotency key only when the existing publish job is `FAILED`.
- Return short-lived signed media preview URLs in the private Agent content projection.
- Deliver Markdown image previews as native Telegram photos and WhatsApp images with captions.

## Release record

| Field | Decision |
| --- | --- |
| Change | Recover failed media-backed publishing and render requested content previews on external agent channels. |
| Owner | platform-ops |
| Risk | standard; Core publishing/media delivery and Agent channel delivery |
| Affected services and user surfaces | kasitek-core, Agents API/Worker, KasiAi, Telegram, WhatsApp, Instagram publishing |
| Platform release version or release ID | Commit `aab50d65`; Core deployment `8dd449e2-54c4-4d60-ab58-599d9be5588e`; Agents API deployment `9840c24f-acf5-4d8e-94e6-3fdd48957b36`; Agents Worker deployment `fd162fdf-d3f0-4350-a15c-7df9d1b49ba4`; KasiAi version `548` / release `e2872f90-96d7-44da-9e58-4a1d61dac1b1`. |
| API/schema/migration changes | No database migration. Private Agent content responses gain `media[].previewUrl`; no public API contract change. |
| Feature flag or rollout method | Not applicable; deploy the tested Core and Agents artifacts. |
| Analytics events and success metrics | No new event. Existing publish status, delivery status, provider calls, and run completion telemetry measure success. |
| Logs, metrics, dashboards, and alerts | Existing provider/database error signals; Core logs retry attempts without media URLs or credentials. |
| User, API, internal, and operational documentation | This release record; no public documentation change required beyond existing content/media behavior. |
| Validation evidence | `cargo check -p kasitek-core`; 217 Core library tests (214 passed, 3 ignored); 31 targeted Agent tests; Agents production build; Core and Agent health endpoints returned OK. A real provider retry was not initiated automatically because it requires the user's approval to publish externally. |
| Rollback or disable plan | Redeploy the prior Core and Agents artifacts; failed jobs remain auditable and can be left in `FAILED` until the rollback is complete. |
| Post-release review date | 2026-09-01 |

## Verification checklist

- [x] Deploy Core and verify health. A media-backed publish retry remains user-triggered to preserve approval boundaries.
- [x] Deploy Agents API and Worker and roll out the updated KasiAi instructions.
- [x] Verify Telegram/WhatsApp preview handling with automated channel tests; production delivery remains user-triggered.
- [x] Record deployment and rollout IDs, then move this plan to `docs/plans/completed/`.
