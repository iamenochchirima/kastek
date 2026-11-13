# Agents documentation

Model provider setup is available at `/app/settings` under **Model providers**.
Owners can save multiple encrypted API-key accounts, add manual models with sourced
metadata, inspect affected agents and schedules, refresh models, run an explicit
paid generation or tool test, and choose an organization default. OpenRouter,
OpenCode, OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Groq, Together,
Fireworks, Moonshot/Kimi and Z.ai have installed adapters with controlled HTTP coverage.
The chat model picker and Behaviour select that default or an explicit account and model.
Chat selection saves immediately through the same confirmation flow and requires unsaved Behaviour
or Knowledge edits to be saved or discarded first. Behaviour model and reasoning changes publish
immediately without including unrelated unsaved edits. Environment keys do not populate workspace connections. Saving
creates configuration snapshots in the background. Admission pins the selected
account, model metadata, use grant, and effective policy before the shared Restate
worker runs chat or tool rounds. Existing accepted work retains its selection when
the default changes; credential revocation still blocks later physical requests.
Model limits shows effective allowances. Reasoning levels appear under the model when the route
publishes them; choosing a level or returning to Provider default publishes immediately without a
separate page save.
Scheduled work also retains its authorized route until an explicit schedule edit.

Provider-native continuation stays in private worker records. Context packing,
compaction, delegated allocation, and root usage settlement use accepted model
bindings. Reconnecting requires explicit restoration of revoked agent access. Native
input counting is available on reviewed OpenAI, Anthropic and Google routes. Other
routes label estimates explicitly; unenforceable strict spending caps are rejected.
Evaluation trials pin the exact model route and policy; the external
Harbor adapter verifies those pins in retained evidence. Independent purpose-suite
acceptance covers grounded FAQ, Inbox handoff and configured booking on reviewed native routes.
Standalone Agents has no campaign-publishing offering. Growth owns its configured publishing
operations. An approved live OpenRouter chat/tool browser path
passed with MiniMax M3.1 Flash on21 October2026. Other provider accounts were not live-tested. Installed adapters do not establish live
account compatibility. See [implementation boundaries](source-boundary.md) for
operator limits, verification scope, and remaining work.

Owner: Agents engineering. Last reviewed: 2026-11-12.

The standalone product offers a customer-service agent with selectable question answering, support,
booking and enquiry responsibilities across customer channels, with a shared inbox for staff
support. Research and campaign experiences belong in Growth or Agencies. The [product boundary and inbox contract](architecture/agent-platform-architecture.md#standalone-agents-product)
define that scope. Website Inbox, assignment, human replies, takeover and explicit return to automation
are implemented. Google Calendar booking is implemented through explicit owner policy and exact customer confirmation.
An opt-in Agents MCP server lets authorized external assistants create and configure agents, add
website knowledge, preview privately, customize a widget, and request signed-in review before
activation. It uses Agents organization grants; Growth's operation catalogue and permissions remain
separate.
Deploy on an Agent starts and manages that Agent's social channel connections. The global
Connections page reflects connected provider accounts. Website installation and appearance are
managed under Chat widget.
All customer channels share Inbox ownership and durable messaging receipts. Meta setup requires a
configured provider app and reachable webhook; Telegram requires an owner-created bot and reachable
webhook. Installed adapters and controlled checks do not establish live account acceptance. The
separate Booking creation offering remains unavailable.
A live Google OAuth application has not been accepted.

The current business harness supports contextual conversations, reviewed personal
memory injected before the first model call, pinned skills, configured tool rounds, and recoverable compaction. New configurations use
Automatic model-aware context; explicit older limits remain binding. Optional
delegation, isolated analysis, approved Python package scripts, reviewed report delivery, durable automation, approved knowledge revisions and connected read tools are opt-in. These documents describe the maintained
implementation and boundaries:

- [Platform interface](../README.md#platform-interface): landing, chat, history, task review and management navigation.

- [Platform architecture](architecture/agent-platform-architecture.md): target contracts and execution categories.
- [Adaptive orchestration](operations/adaptive-orchestration.md): specialist discovery, background work, follow-up, progress and release controls.
- [Context management](operations/context-management.md): retained originals, request manifests, background compaction and exact recovery.
- [Shared runtime operations](operations/shared-runtime.md): current retained copies, failure investigation, disable and restore boundaries.
- [Product capabilities](product-capabilities.md): product-owned tools, presets, current authority and release routing.
- [Growth integration](growth-integration.md): service keys, managed models, operator controls and product execution.
- [Implementation boundary](source-boundary.md): current modules, verification, and remaining work.
- [Agents verification skill](../../../.agents/skills/verify-agents/SKILL.md): owned browser and purpose-specific API checks.
- [Platform login](architecture/platform-login.md): identity, sessions, and product authorization.
- [Workspace members](operations/workspace-members.md): owner/admin/member roles, permissions, invitations, email configuration and member management.
- [Enquiry outcomes](operations/enquiry-outcomes.md): website visitor confirmation, customer-record projection and outcome references.
- [Sandbox workspace bootstrap](operations/sandbox-bootstrap.md): product-owned owner/workspace bootstrap for a fresh evaluation sandbox.
- [Integration boundaries](mcp-integration.md): outbound read adapters, provider acceptance gates and future product connections.
- [Threat model](THREAT_MODEL.md): enforced controls and release limits.

Use the [product setup](../README.md) to run the application and the
[runtime reference](../../../infra/agents-runtime/README.md) for Restate diagnostics.
Settled requirements and implementation checklists remain in the linked Linear
specifications in the architecture document. Deleted operational notes remain in
Git history.
