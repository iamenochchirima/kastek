# KasiAi publish retry and media preview

**Status:** In progress

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
| Platform release version or release ID | Pending deployment; record commit and deployment IDs here. |
| API/schema/migration changes | No database migration. Private Agent content responses gain `media[].previewUrl`; no public API contract change. |
| Feature flag or rollout method | Not applicable; deploy the tested Core and Agents artifacts. |
| Analytics events and success metrics | No new event. Existing publish status, delivery status, provider calls, and run completion telemetry measure success. |
| Logs, metrics, dashboards, and alerts | Existing provider/database error signals; Core logs retry attempts without media URLs or credentials. |
| User, API, internal, and operational documentation | This release record; no public documentation change required beyond existing content/media behavior. |
| Validation evidence | Core format/check and build; Core WhatsApp unit tests; Agents targeted tests and TypeScript build. |
| Rollback or disable plan | Redeploy the prior Core and Agents artifacts; failed jobs remain auditable and can be left in `FAILED` until the rollback is complete. |
| Post-release review date | 2026-09-01 |

## Verification checklist

- [ ] Deploy Core and verify health plus a media-backed publish retry.
- [ ] Deploy Agents API and Worker and roll out the updated KasiAi instructions.
- [ ] Confirm Telegram image preview and WhatsApp image preview delivery.
- [ ] Record deployment and rollout IDs, then move this plan to `docs/plans/completed/`.
