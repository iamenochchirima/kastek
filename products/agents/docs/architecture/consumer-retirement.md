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
| Conversation archive and restore | None proposed | `products/agents/web/src/platform/assistant-launcher.tsx` | Owner decides between separate archive state and removing restore |
| Legacy product execution adapters | Platform integration adapters | Growth and Agency execution clients | Both consumers use the shared run contract |

## Conditions before deletion

- The replacement is verified in an environment where the consumer runs, not only in
  isolated tests.
- Pending runs and uncertain effects on the retired path are resolved.
- The retirement entry has no remaining caller in this repository.
- Affected service versions, migrations and rollback are recorded in the release record.

## Not established

External callers outside this repository and live deployment inventory. The archive and
restore entry is a decision, not a mechanical deletion.
