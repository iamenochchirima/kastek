# Agents documentation

Model provider setup is available at `/app/settings` under **Model providers**.
Owners can save multiple encrypted API-key accounts, add manual models with sourced
metadata, inspect affected agents and schedules, refresh models, run an explicit
paid generation or tool test, and choose an organization default. OpenRouter,
OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Groq, Together, Fireworks,
Moonshot/Kimi and Z.ai have installed adapters with controlled HTTP coverage.
The chat model picker and Configure select that default or an explicit account and model.
Chat selection saves immediately through the same confirmation flow. Unsaved Configure edits
must be saved or discarded first. Environment keys do not populate workspace connections. Saving
creates configuration snapshots in the background. Admission pins the selected
account, model metadata, use grant, and effective policy before the shared Restate
worker runs chat or tool rounds. Existing accepted work retains its selection when
the default changes; credential revocation still blocks later physical requests.
Model limits shows effective allowances and reviewed model-specific generation controls.
Scheduled work also retains its authorized route until an explicit schedule edit.

Provider-native continuation stays in private worker records. Context packing,
compaction, delegated allocation, and root usage settlement use accepted model
bindings. Reconnecting requires explicit restoration of revoked agent access. Native
input counting is available on reviewed OpenAI, Anthropic and Google routes. Other
routes label estimates explicitly; unenforceable strict spending caps are rejected.
Evaluation trials pin the exact model route and policy; the external
Harbor adapter verifies those pins in retained evidence. Independent purpose-suite
acceptance covers grounded FAQ, Inbox handoff and configured booking on reviewed native routes.
Campaign publishing remains unsupported. An approved live OpenRouter chat/tool browser path
passed with MiniMax M3.1 Flash on21 October2026. Other provider accounts were not live-tested. Installed adapters do not establish live
account compatibility. See [implementation boundaries](source-boundary.md) for
operator limits, verification scope, and remaining work.

Owner: Agents engineering. Last reviewed: 2026-10-21.

The standalone product targets customer-service, FAQ, booking, and intake agents across customer
channels, with a shared inbox for staff support. Research and campaign experiences belong in
Growth or Agencies. The [product boundary and inbox contract](architecture/agent-platform-architecture.md#standalone-agents-product)
define that scope. Website Inbox, assignment, human replies, takeover and explicit return to automation
are implemented. Google Calendar booking is implemented through explicit owner policy and exact customer confirmation.
The separate Booking creation offering and additional channel providers remain unavailable.
A live Google OAuth application has not been accepted.

The current business harness supports contextual conversations, reviewed personal
memory, pinned skills, bounded tool rounds, and recorded compaction. Optional
delegation, isolated analysis, approved Python package scripts, reviewed report delivery, durable automation, approved knowledge revisions and connected read tools are opt-in. These documents describe the maintained
implementation and boundaries:

- [Platform interface](../README.md#platform-interface): landing, chat, history, task review and management navigation.

- [Platform architecture](architecture/agent-platform-architecture.md): target contracts and execution categories.
- [Implementation boundary](source-boundary.md): current modules, verification, and remaining work.
- [Agents verification skill](../../../.agents/skills/verify-agents/SKILL.md): owned browser and purpose-specific API checks.
- [Platform login](architecture/platform-login.md): identity, sessions, and product authorization.
- [Integration boundaries](mcp-integration.md): outbound read adapters, provider acceptance gates and future product connections.
- [Threat model](THREAT_MODEL.md): enforced controls and release limits.

Use the [product setup](../README.md) to run the application and the
[runtime reference](../../../infra/agents-runtime/README.md) for Restate diagnostics.
Settled requirements and implementation checklists remain in the linked Linear
specifications in the architecture document. Deleted operational notes remain in
Git history.
