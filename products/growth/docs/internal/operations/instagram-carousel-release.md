---
title: Instagram carousel release record
owner: engineering
last_reviewed: 2026-11-13
---

# Instagram carousel release record

```text
Change: Publish two to twenty attached images to Instagram as a carousel.
Owner: iamenochchirima
Risk: standard
Affected services and user surfaces: Growth API social publisher, Growth web content composer, Instagram publishing.
Platform release version or release ID: pending production deployment.
Tracker: KAS-302.
API/schema/migration changes: none.
Feature flag or rollout method: no new flag; deploy the Growth API and web together.
Analytics events and success metrics: existing social publish jobs and meter usage; success is a provider-confirmed carousel media id.
Logs, metrics, dashboards, and alerts: existing social publishing logs and provider failure codes.
User, API, internal, and operational documentation: this record, the feature map and the public social connections page.
Validation evidence: provider fixture tests, capability test, Growth API typecheck, Growth web typecheck/build and import boundaries.
Rollback or disable plan: redeploy the previous Growth API and web artifacts; single-image publishing remains compatible.
Post-release review date: 14 days after deployment.
```

## What changed

- Instagram publishing now accepts one image or an ordered list of two to twenty images.
- For a carousel, Growth creates one child media container per image with `is_carousel_item=true`,
  waits for each child container to finish, creates a `CAROUSEL` parent with the ordered children
  and caption, then publishes the parent.
- The single-image path is unchanged: it creates one image container with the caption and publishes
  it.
- Attached images take precedence. The legacy Instagram image URL field is used only when no image
  is attached.
- Instagram media capability is 20 images in both the API and web. The general post media cap
  moves from 10 to 20 so the composer and durable delivery snapshot can carry the full carousel.
- Facebook, Threads and LinkedIn remain single-image. X and Bluesky remain four images.

## Provider behavior

Instagram's content publishing API limits a carousel to 20 images, videos or a mix. Growth's
adapter supports images only. Each image must be a public HTTPS URL. The parent caption is applied
once; child containers do not receive the caption.

## Validation

- Provider fixture covers two child containers, two child status checks, the carousel parent and
  the final publish call. It asserts `is_carousel_item=true`, ordered `children`, `media_type=CAROUSEL`
  and the caption on the parent. It also rejects a 21-image request before any provider call.
- Capability test asserts `platformCapabilities("INSTAGRAM").media.images.maxCount === 20`.
- Growth API full suite: 187 passed, 98 skipped, 0 failed. Focused social files: 5 passed, 3 skipped.
- Growth API typecheck, Growth web typecheck and production build passed.
- `pnpm verify:boundaries` passed for 2,785 source and script files.
- Live provider acceptance is owner-run with an owned Instagram account; no test post is published
  from fixtures.

## Rollout

1. Deploy the Growth API and web from the same reviewed commit.
2. Confirm existing single-image Instagram drafts still publish.
3. With an owned Instagram account, publish a two-image carousel and confirm the provider returns a
   published media id and the post appears with both images.
4. Confirm a post with more than 20 images is rejected before the provider call.

## Rollback

Redeploy the previous Growth API and web artifacts. Existing drafts and published posts remain.
No schema change or data migration is required. The previous adapter ignores additional attached
images, so roll back the composer and API together to avoid showing a carousel option the API
cannot publish.

## Limits and follow-up

- Growth does not yet publish Instagram video carousels or mix images and videos.
- Caption length is not separately validated by the adapter; the provider rejects captions beyond
  its own limit.
- Alt text on attached images is not yet forwarded to Instagram.
- Facebook and Threads carousels remain a separate follow-up.
