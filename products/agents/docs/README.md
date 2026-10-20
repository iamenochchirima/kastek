# Agents documentation

Owner: Agents engineering. Last reviewed: 2026-10-20.

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
- [Platform login](architecture/platform-login.md): identity, sessions, and product authorization.
- [Integration boundaries](mcp-integration.md): outbound read adapters, provider acceptance gates and future product connections.
- [Threat model](THREAT_MODEL.md): enforced controls and release limits.

Use the [product setup](../README.md) to run the application and the
[runtime reference](../../../infra/agents-runtime/README.md) for Restate diagnostics.
Settled requirements and implementation checklists remain in the linked Linear
specifications in the architecture document. Deleted operational notes remain in
Git history.
