---
title: Media and content templates
owner: engineering
last_reviewed: 2026-11-03
---

# Media and content templates

Open **Posts → Media** to find images and videos uploaded through Growth content workflows.
Search by file/display name, filter by type or tags, and select an asset to inspect its details and
usage. The library includes retained uploads from drafts and previous posts. It does not import
all the media on a connected social account.

Choose **Media library** in the post composer to attach an existing asset. Order and alt text belong
to the new post. Renaming a file or changing its default alt text does not rewrite published content.
Archive hides an asset from normal selection while retaining existing post references and bytes.
Workspace administrators can restore archived assets.

Open **Posts → Templates** to save recurring captions and platform versions. Declare fields such as
`{{offer}}`, enter their values, preview the rendered copy, then choose **Create draft**. This creates
a separate unscheduled draft for normal editing and publication checks. Fields replace caption text;
they do not edit text embedded in an image. WhatsApp message templates remain under **Templates**.

Use **Save as template** on an existing post to retain reusable copy and media. Use **Duplicate** to
create a new draft directly. Both preserve the original publication history. Neither publishes the
new content automatically. Replace or remove unavailable template media before creating a draft.

## Agent access

MCP, REST and internal Growth agents use the same operations:

| Purpose | Operations |
| --- | --- |
| Browse and inspect media | `content.media.list`, `content.media.get`, `content.media.preview`, `content.media.usage` |
| Upload and organize media | `content.media.transfer.prepare`, `content.media.upload`, `content.media.update`, `content.media.archive`, `content.media.restore` |
| Browse templates | `content.templates.list`, `content.templates.get` |
| Save and edit templates | `content.templates.create`, `content.templates.update`, `content.templates.archive`, `content.templates.restore` |
| Preview and reuse | `content.templates.render`, `content.templates.instantiate`, `content.posts.duplicate` |

Reads require `growth:read`; saves, draft creation and metadata changes require `growth:draft`.
Archive/restore require `growth:manage` and workspace administration. Supply the current
`expectedRevision` when changing a media/template record or rendering/materializing a template.
Use a stable `_requestId` for every write and retain it if the response is uncertain.

For example, POST to `/v1/operations/content.templates.instantiate` with an authorized credential:

```json
{
  "templateId": "saved-template-id",
  "expectedRevision": 1,
  "values": { "offer": "This week's offer" },
  "_requestId": "offer-draft-001"
}
```

Rendering never publishes or creates a draft. Creating a draft still requires the normal selected
account and provider format checks before publication. See [MCP integration](../api/mcp-integration.md)
and [REST](../api/agent-rest.md) for authentication, response continuations and receipt recovery.

Revision conflicts require reloading the record before a new edit. Archived or missing template
media requires explicit replacement, removal or restoration. `template_render_invalid` reports
resolved platform text/media incompatibility; render returns the corresponding validation errors.
`delivery_media_invalid` blocks a stale or foreign per-platform media selection before publication.
An uncertain write requires receipt reconciliation with its original request identity.
