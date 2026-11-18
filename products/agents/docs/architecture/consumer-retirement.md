# Consumer retirement inventory

Surfaces the platform upgrade replaces or removes. Paths and callers are from the
[platform inventory](platform-inventory.md). Nothing here is deleted until the
replacement is serving and the last caller is migrated.

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
| Conversation archive and restore | None proposed | `products/agents/web/src/platform/assistant-launcher.tsx` | Owner decides between separate archive state and removing restore |
| Legacy product execution adapters | Platform integration adapters | Growth and Agency execution clients | Both consumers use the shared run contract |

## Product-specific contracts and compatibility paths

These are source-tree candidates for replacement as the platform contract is completed. A row
identifies the current caller; it does not assert that the replacement already exists.

| Current surface | Last known caller | Intended replacement or review |
| --- | --- | --- |
| `packages/contracts/src/growth-agents.ts` command, conversation, task and result types | Growth `api/src/agents/client.ts` and Agents `product/integrations/growth-routes.ts`, `growth-execution.ts` | Shared platform agent, conversation and run operations at consumer cutover. |
| `packages/contracts/src/growth-agent-provisioning.ts` | Growth `api/src/agents/provisioning-client.ts` and Agents `product/integrations/growth-provisioning.ts` | Generic platform agent configuration and publication. |
| `packages/contracts/src/agency-agents.ts` command, conversation and model shapes | Agency `api/src/capabilities/execution-client.ts` and Agents `product/integrations/agency-routes.ts`, `agency-execution.ts` | Shared platform agent, conversation, run and model operations. |
| Growth legacy delegation defaults in `product/integrations/growth-features.ts` | Growth execution | Generic agent delegation configuration and authority. |
| Agency legacy context defaults in `product/integrations/agency-execution.ts` | Agency execution and model configuration | Shared context policy configured on the agent. |
| `execution/context/legacy-control-prefix.ts` and its path in `recipient-text.ts` | Recipient text projection of older tool results | Shared current result projection and evidence policy; preserve disclosure protection when removing. |
| Legacy product evidence fence in `execution/models/runtime.ts` | Model dispatch for older protocol executions | Shared current evidence and product authority checks. |
| V1 budget branches in `execution/delegation/adaptive.ts` and `execution/lifecycle/work-continuation.ts` | Older execution policy revisions | Current shared model and work accounting. |
| Legacy pinned knowledge fallback in `execution/business/business.ts` | Older pinned agent versions | The selected knowledge mode and current retrieval policy. |
| `composition/backfill-knowledge.ts` and `platform/knowledge/backfill-legacy-objects.ts` | Operator command `backfill:knowledge` | New knowledge storage; no legacy backfill prerequisite for the fresh platform. |

Product-owned operations such as Growth resource and channel contracts are not automatically
retired with product-specific agent orchestration DTOs. `execution/programs/publication.ts`
defaults fresh publication to v15, while the worker and lifecycle still recognize v11–v14.
The external caller inventory and archive/restore destination remain unresolved.

## Conditions before deletion

- The replacement is verified in an environment where the consumer runs, not only in
  isolated tests.
- Pending runs and uncertain effects on the retired path are resolved.
- The retirement entry has no remaining caller in this repository.
- Affected service versions, migrations and rollback are recorded in the release record.

## Not established

External callers outside this repository and live deployment inventory. The archive and
restore entry is a decision, not a mechanical deletion.
