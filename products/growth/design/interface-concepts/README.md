# Growth interface concepts

Light-theme design proposals generated with the built-in image tool on 27 October 2026.
They follow the shared Geist, neutral surface, fine-border and outline-icon direction.
The owner approved implementation of the Growth image-matched redesign on 27 October 2026. The [Linear specification](https://linear.app/kasitek/document/growth-dashboard-redesign-image-matched-implementation-plan-and-ui-1ebf2b277493) defines the checklist and acceptance rules. The owner chose existing real fields and metrics where illustrative image data is unavailable.

- [Inbox overview](inbox-overview-light-v1.png): full channel tabs, conversation list and unselected reading pane. SMS stays unavailable as in the current interface.
- [Inbox conversation](inbox-light-v1.png): selected conversation, reply pane and customer details. Keep the overview's channel tabs when opening a conversation.
- [Connections](connections-light-v1.png): connected accounts and compact platform catalogue.
- [Connections revision](connections-light-v2.png): Growth-specific account table, compact platform rows and messaging/publishing/email filters. Selected visual reference for the account table and catalogue.
- [Agents](agents-light-v1.png): four Growth defaults, conversation history and the existing general assistant drawer.

Sample contacts, messages, counts and connection states are illustrative. Provider actions
remain subject to actual integration capabilities and permissions. In particular, an Inbox
conversation's channel is record information, not an editable transport selector. The images
do not authorize changing those contracts. Growth presets remain Growth-owned; the general
assistant drawer and full conversation view must use the same conversation.

Keep supported actions, preference behavior, loading/error states and responsive layouts
when translating these concepts into code. Keep provider logos distinct from UI line icons.
Dark variants should preserve the composition using the shared neutral charcoal palette.

The [prompt set](prompts.json) records the generation instructions. The existing Agents
[Connections reference](../../../agents/design/interface-concepts/connections-light.png)
was supplied for visual style, not for Growth navigation or available tools.

## Additional Growth concepts

- [Overview](overview-light-v2.png): compact business metrics, conversation activity and attention items.
- [Agents revision](agents-light-v2.png): four Growth presets, recent conversations and the general assistant drawer.
- [Contacts](contacts-light-v1.png): contact table, filters and a contact detail panel.
- [Posts](content-light-v1.png): publishing list with platform/status filters and a post preview.

The [additional prompt set](growth-expansion-prompts.json) records the built-in generation instructions. These are the visual references for the approved redesign, not assertions of available data. Counts, dates, records, actions and metrics require validation against existing contracts before implementation.

## Campaigns

- [Campaigns board](campaigns-board-v1.png): list, creation review, campaign detail and neutral dark treatment. Generated on 30 October 2026 against the approved Posts reference. The owner approved this Campaigns board on 30 October 2026 before styling began.

The [Campaigns specification](https://linear.app/kasitek/document/growth-campaigns-redesign-implementation-plan-and-acceptance-afb194879acb) records the implementation and acceptance scope. The board is a composition reference, not a data contract: campaign thumbnails, author attribution and illustrative ratios must not be invented. Use actual connection/template/audience data. Status labels and counts must agree with records. No inert checkbox or menu affordances should be copied from the generated image. Draft creation is separate from explicit queueing; scheduled delivery must show the resolved time zone and instant.
