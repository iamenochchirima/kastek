# Consumer retirement inventory

Surfaces the platform upgrade replaces or removes. Paths and callers are from the
[platform inventory](platform-inventory.md). The target is a fresh platform without legacy
compatibility requirements. This inventory does not authorize destructive changes to a serving
database; deployed consumers and data need separate cutover decisions.

| Surface | Replacement | Last known caller | Removal gate |
| --- | --- | --- | --- |
| `POST /internal/v1/products/growth/commands` | Platform run and tool operations | `products/growth/api/src/agents/client.ts` | Growth runs through the platform API in an integrated environment |
| `POST /internal/v1/products/growth/provision` | Platform agent create and publish | `products/growth/api/src/agents/provisioning-client.ts` | Growth creates agents through the platform contract |
| `/internal/v1/products/growth/channels`, `/usage` | Platform channel and usage operations | `products/growth/api/src/agents/channel-admin-client.ts`, `usage-feed.ts` | Growth channel admin and usage read from platform |
| `POST /internal/v1/products/agencies/commands`, `/model` | Platform run and model operations | `products/agency/api/src/capabilities/execution-client.ts` | Agency runs through the platform API |
| Inbound MCP management tools | Same platform operations as HTTP | MCP clients through OAuth | Management tools call platform operations with identical authority |
| `product-capabilities-v13` / `AgentsBusinessRunV23` | `product-capabilities-v15` / `AgentsBusinessRunV25` | Tasks admitted while v13 was current | No active task pins v13 |
| `product-capabilities-v11` / `AgentsBusinessRunV21` | Shared runtime v15 | Existing pinned tasks; `execution/lifecycle/dispatcher.ts` also uses v11 as its default route | Replace the dispatcher default and retire only with a decision on existing tasks. |
| `product-capabilities-v12` / `AgentsBusinessRunV22` | Shared runtime with equivalent handoff behavior | Existing pinned handoff tasks and `execution/lifecycle/authority.ts` handoff-feedback check | Preserve the supported handoff behavior in the shared runtime and remove v12 dependencies. |
| `product-capabilities-v14` / `AgentsBusinessRunV24` | Shared runtime v15 | Existing pinned adaptive tasks and `execution/business/business.ts` origin checks | Replace old-release checks and decide the fate of pinned tasks. |
| Legacy product execution adapters | Platform integration adapters | Growth and Agency execution clients | Both consumers use the shared run contract |

## Product-specific contracts and compatibility paths

These are source-tree candidates for replacement as the platform contract is completed. A row
identifies the current caller; it does not assert that the replacement already exists.

| Current surface | Last known caller | Intended replacement or review |
| --- | --- | --- |
| `packages/contracts/src/growth-agents.ts` extension command types | Growth `api/src/agents/client.ts` and Agents `product/integrations/growth-routes.ts`, `growth-execution.ts` | Growth-owned extensions only; core conversations and runs use the shared product gateway. |
| `packages/contracts/src/growth-agent-runtime.ts` runtime and activity types | Agents `product/integrations/growth-runtime-reporting.ts`, `growth-observation.ts` and `composition/app.ts`; Growth and Agency consumers | Product-neutral run activity and timing contract; preserve the information consumed by each UI. |
| `packages/contracts/src/growth-agent-provisioning.ts` | Growth `api/src/agents/provisioning-client.ts` and Agents `product/integrations/growth-provisioning.ts` | Generic platform agent configuration and publication. |
| `packages/contracts/src/agency-agents.ts` command, conversation and model shapes | Agency `api/src/capabilities/execution-client.ts` and Agents `product/integrations/agency-routes.ts`, `agency-execution.ts` | Shared platform agent, conversation, run and model operations. |
| Growth legacy delegation defaults in `product/integrations/growth-features.ts` | Growth execution | Generic agent delegation configuration and authority. |
| Agency legacy context defaults in `product/integrations/agency-execution.ts` | Agency execution and model configuration | Shared context policy configured on the agent. |
| `execution/context/legacy-control-prefix.ts` and its path in `recipient-text.ts` | Recipient text projection of older tool results | Shared current result projection and evidence policy; preserve disclosure protection when removing. |
| Legacy product evidence fence in `execution/models/runtime.ts` | Model dispatch for older protocol executions | Shared current evidence and product authority checks. |
| V1 budget branches in `execution/delegation/adaptive.ts` and `execution/lifecycle/work-continuation.ts` | Older execution policy revisions | Current shared model and work accounting. |
| Legacy pinned knowledge fallback in `execution/business/business.ts` | Older pinned agent versions | The selected knowledge mode and current retrieval policy. |
| Plain-body skill fallback in `execution/context/skills.ts` | Agent context assembly in `execution/business/business.ts` | Registered, versioned skill package resolution and receipts. |
| `composition/backfill-knowledge.ts` and `platform/knowledge/backfill-legacy-objects.ts` | Operator command `backfill:knowledge` | New knowledge storage; no legacy backfill prerequisite for the fresh platform. |
| `composition/backfill-support-contacts.ts` | Operator command `backfill:support-contacts` | Current customer-record projection at creation; old support-contact backfill is not a fresh-platform prerequisite. |
| Knowledge backfill startup check in `platform/knowledge/cutover.ts`, `backfill-sections.ts` and legacy storage fallback in `composition/source-object-reaper.ts` | API startup in `composition/server.ts` and the source-object reaper | Fresh knowledge schema, owned ingestion and storage without a legacy backfill prerequisite. |
| Legacy receipt-installation path in `product/channels/channel-delivery.ts` | Channel delivery | Identify and preserve the current channel delivery contract before removing the installation fallback. |

Product-owned operations such as Growth resource and channel contracts are not automatically
retired with product-specific agent orchestration DTOs. `execution/programs/publication.ts`
defaults fresh publication to v15, while the worker and lifecycle still recognize v11–v14.
The external caller inventory remains unresolved. Conversation archive and restore is a separate
functionality issue: the existing UI calls routes in `composition/app.ts`, but it is not identified
as a legacy compatibility requirement to preserve or remove by this inventory.

## Serving environment cutover

The fresh implementation may remove compatibility code on this branch. Before changing a serving
environment, separately account for its consumers, data and pending runs and record the release
and recovery decisions. These checks do not require keeping compatibility code in the target.

## Not established

External callers outside this repository and live deployment inventory. Archive and restore needs
its own functionality review.

## Growth cutover target

Growth keeps its signed backend authentication and its public API. Agents replaces the
Growth-specific command translation with a generic product gateway that carries the same
operations as the shared agent/run contract. Growth owns its product composition.

| Growth operation | Target |
| --- | --- |
| `provision` | Shared agent create, configure and publish; Growth owns the feature-to-configuration mapping |
| `conversations.create/list/get/context` | Shared conversation operations |
| `turns.submit` | Shared run start |
| `tasks.get/list/observe/events/export` | Shared run read, activity, list and export |
| `tasks.cancel/instructions/continue` | Shared run control |
| `reviews.list/decide` | Shared pending decisions |
| `artifacts.list/get` | Shared artifact operations |
| `models.list/select` | Shared model connections and agent configuration |
| `features.list/configure/profile/upgrade.*` | Growth extension until feature composition moves into Growth |
| `memory.list/mutate/configure` | Growth extension until a generic memory operation is justified |
| Growth resources | Growth extension |
| `channels`, `usage` | Product-owned; not part of this cutover |

Deletion boundary: Agency imports `GrowthAgentTask`, `GrowthAgentObservation` and
`GrowthAgentMessage`. Move those to a neutral contract module before deleting Growth-only
contracts. Keep shared product tables and v11-v14 registrations until the Agency cutover.

Status: the Growth core run path now uses the shared product gateway
(`/internal/v1/products/growth/agent-gateway`). Growth-owned extensions sign a
product-prefixed envelope and use `/internal/v1/products/growth/extensions`; the old
`/commands` path is retired. Shared lifecycle schemas and the extension envelope are defined
in `packages/contracts/src/product-agent-gateway.ts`. Growth provisioning sends
`agents.applyPublication` through `/internal/v1/products/:product/lifecycle`; Agents applies
the Growth-owned publication. The internal core adapter and feature-to-agent cleanup remain in
KAS-316.

## Consumer migration tracking

Independent platform proof is complete for the application HTTP API, MCP and the standalone
client (sections 8.1-8.5). Consumer migration remains follow-on work; no destructive deletion
has been authorized.

| Consumer | Current path | State | Next action |
| --- | --- | --- | --- |
| Standalone Agents UI | `/api/organizations/*` member routes | Serving; same API for application-run audit | None for this upgrade |
| Independent application client | `/v1` HTTP with application credentials | Proven end to end | Keep the documented contract stable |
| External MCP assistants | `/mcp` OAuth | Proven, including denied unassigned agents | Keep operation/scope table current |
| Growth | Core uses the signed product gateway; extensions use the namespaced envelope; provisioning uses the lifecycle publication | Core migrated, extensions remain | Finish the feature-mapping and extension cleanup in KAS-316 |
| Agency | Agency product runtime/client | Not migrated | Separate Agency change with the same verification |
| Website widgets and channels | Platform website/channel routes | Serving | No change required by this upgrade |
| Product tool bundles | Growth/Agency capability manifests | Tracked as follow-on | Migrate after each consumer cutover; keep pinned revisions for accepted work |

Migration order: Growth, then Agency, then external callers identified from the serving
inventory. Each cutover needs an owner-approved change, a normal journey, a denied-authority
journey, an outstanding-run decision and a rollback point. Tool bundles follow their consumer.
