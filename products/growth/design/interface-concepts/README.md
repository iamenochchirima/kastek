# Growth interface concepts

Light-theme design proposals generated with the built-in image tool on 27 October 2026.
They follow the shared Geist, neutral surface, fine-border and outline-icon direction.
These images precede feature-page implementation and are not approved implementation specifications.

- [Inbox overview](inbox-overview-light-v1.png): full channel tabs, conversation list and unselected reading pane. SMS stays unavailable as in the current interface.
- [Inbox conversation](inbox-light-v1.png): selected conversation, reply pane and customer details. Keep the overview's channel tabs when opening a conversation.
- [Connections](connections-light-v1.png): connected accounts and compact platform catalogue.
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
