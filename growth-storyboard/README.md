# Growth visual sequence

Open http://localhost:3010/growth-storyboard/ to review the three image mockups together. The preview crossfades still images; it does not simulate the detailed app operations yet. Full-size images remain below the preview and can be opened individually.

## Direction

A ceramic shop packing table gives Growth a different setting from Agents. Warm natural photography, ivory UI, brown and terracotta accents, Helvetica Neue style typography and Georgia italics preserve the Labs direction. The same background and app shell anchor all three views.

The illustrative workflow moves through product areas documented in Growth's feature map: Inbox, Campaigns and Content calendar. These are marketing design concepts, not captures of the shipping application. They do not establish that inbox-to-campaign transfer or cross-channel scheduling currently works as drawn.

## Proposed motion

| View | Time in preview | Detailed motion to build later |
| --- | --- | --- |
| Conversation | 6.5 seconds | App enters 18px upward over 900ms; customer message fades in; reply follows; glass card arrives last. |
| Campaign | 7.5 seconds | Retain shell and background; crossfade app content over 650ms; audience and preview arrive; cursor approaches Review campaign, then press feedback. |
| Schedule | 8.5 seconds | Calendar replaces editor; cards arrive 160ms apart; confirmation follows; hold the completed view before looping. |

The image preview transitions over 950ms. It supports pause, manual view selection and static reduced-motion review. A future implementation should animate interface layers while keeping the shop photograph stable, rather than replacing full-screen images.

## Generated assets

Generated with the built-in image generation tool on 2026-10-14. The second and third images use the first image as an edit target for visual continuity. No image editing scripts were used.

- [Conversation](assets/conversation.png), [exact prompt](prompt-1.txt)
- [Campaign](assets/campaign.png), [exact prompt](prompt-2.txt)
- [Schedule](assets/schedule.png), [exact prompt](prompt-3.txt)

Original tool output names: `exec-ae7bde6d-acb2-4ca9-9ec1-1ae4da0f5e6b.png`, `exec-c281315d-1b3d-4389-a159-0972776a39f6.png`, `exec-a71cb04f-a0e9-4a19-8a26-aaeb545886ec.png`.
