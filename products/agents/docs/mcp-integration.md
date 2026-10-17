# Integration boundaries

The platform distinguishes three connections:

| Connection | Target contract | Current status |
| --- | --- | --- |
| External agents to Growth or Agencies | Product-owned MCP with OAuth or deliberately scoped API keys. | Outside this standalone Agents implementation. |
| Product backends to shared execution | Authenticated service plus bounded execution authority and initiating identity. | Future product integration. |
| Executing agents to product operations | Typed product APIs with destination-specific delegated authority. | Business-action tools are disabled in the initial FAQ. |

These connections do not create new execution categories. Agents use `business`
or `workspace`. External clients do not require synthetic agent definitions or
installations in the shared platform.

No standalone Agents MCP gateway, stdio bridge, outbound MCP adapter, or connection
catalog is implemented. The initial FAQ uses approved knowledge and one bounded
model call. Growth's external MCP contract belongs to Growth and does not replace
the future backend-to-execution integration.

The [platform architecture](architecture/agent-platform-architecture.md) defines
future adapter responsibilities. The [implementation boundary](source-boundary.md)
records what can run now.
