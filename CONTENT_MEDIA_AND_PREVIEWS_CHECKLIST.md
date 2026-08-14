# Content media (images and video) and previews checklist

**Scope:** Direct KasiTek Content (`kasitek-core` and `client/apps/client`). This does not merge
direct-product media with the separate white-label platform.

- [x] Add workspace-owned image and video assets, post/variant attachments, and immutable publish delivery snapshots.
- [ ] Implement secure image and video upload, MIME/size/dimension/duration validation, scanning, processing states, derived renditions, posters/thumbnails, and production delivery URLs. (Upload validation and lifecycle states are in place; malware scanning, transcoding, and generated posters remain.)
- [x] Replace pasted provider URLs with a shared composer media library, ordering, alt text, image crops/video posters, and per-platform overrides. (Shared upload, ordering, previews, and attachment persistence are in place; per-platform crop/poster overrides remain.)
- [ ] Add one platform capability and validation contract for every supported media destination, separately defining image and video limits, formats, counts, and processing requirements.
- [ ] Implement provider media publishing incrementally by supported media type: Meta, Bluesky, LinkedIn, X, then TikTok photo/video migration; include provider processing/polling where required.
- [x] Add platform-aware mobile previews from the exact variant and selected media, including image composition and video poster, duration, and playback-state treatment; label them as composition previews. (Initial composition preview is in the Versions step.)
- [ ] Add schedule/retry recovery, provider integration tests, upload-security tests, and visual preview regression checks.
- [ ] Roll out per platform only after a connected-account acceptance test passes.

## Delivery guardrails

- The composer accepts images and videos through one asset library, but only shows a destination when the selected assets meet that destination's current capability contract.
- A video is publishable only after its scan and processing state is ready; a poster/thumbnail is generated for the library and previews.
- Provider-specific upload identifiers, processing state, and final published media references are captured in the immutable delivery snapshot, rather than being inferred from a mutable asset later.
- Unsupported combinations stay editable and explain what must change; they are never silently discarded or downgraded to a text-only post.

## Implementation evidence

- Database: `client/packages/database/prisma/schema.prisma` and migration `20260814140000_add_content_media_assets` define image/video assets, lifecycle states, renditions, post attachments, variant attachments, and delivery snapshots.
- Backend: `server/kasitek-core/src/services/content_media.rs` provides workspace-scoped upload, authenticated delivery, and signed short-lived provider delivery URLs; `social_posts.rs` validates attachments and persists them into each publish job snapshot.
- Composer: `client/apps/client/src/components/social/posts-workspace.tsx` uploads images/videos, shows thumbnails/video metadata, persists selected assets, and renders the mobile composition preview.
- Provider boundary: Instagram image delivery and TikTok image/video delivery can use signed HTTPS asset URLs when the configured public origin is reachable by the provider. Facebook, Threads, Bluesky, LinkedIn, and X currently reject attached media at publish time until their provider upload adapters are implemented; they do not silently publish a text-only version.
