# Integration boundaries

Agents uses two execution kinds: `business` and `workspace`. Connections do not
create another agent category. Business execution uses Restate; the Lina workspace
adapter remains unavailable.

| Connection | Contract | Current boundary |
| --- | --- | --- |
| External agents to Growth or Agencies | Product-owned MCP with OAuth or scoped API keys. | Separate product work; no Agents gateway. |
| Product backends to Agents execution | Authenticated service with initiating identity and bounded authority. | Future integration. |
| Business agents to external reads | Immutable selected native HTTP or MCP bindings, current connection/resource authority and durable receipts. | GitHub public-repository profile implemented; authenticated GitHub acceptance is pending. |
| Business agents to report delivery | Exact report bytes, one human approval, one dispatch claim, status-only recovery. | ReportDeliveryHTTP with a verified persistent local receiver. |

## Outbound GitHub reads

A connection belongs to an organization and account. The owner supplies an expiring
read-only PAT and explicit public repositories/revisions. AES-256-GCM protects the
credential with an external keyring. The server chooses endpoints and headers;
model arguments cannot supply credentials, paths, refs, URLs or arbitrary queries.

Native REST supports metadata, releases, immutable commit resolution, bounded tree
listing and text-file reads. Issued revision/file/release handles bind the task's
root, connection policy and approved resource. Related content reads use the same
resolved commit SHA. Observations carry acquisition time and response digests.

The isolated outbound adapter uses `@modelcontextprotocol/client@2.3.1`. It requests
MCP 2026-07-28 and explicitly supports the 2025-11-25 HTTP negotiation path. Only
selected trusted GitHub read operations are available. Provider read-only headers
and tool filters supplement local validation. Sampling, roots, elicitation, stdio,
subscriptions, arbitrary remote writes and resource-link traversal are denied.

Discovery creates an immutable candidate catalog. Selecting operations and
publishing a new AgentVersion are separate owner actions. Remote hints do not
grant permission. Catalog/schema changes never expand an existing version.
MCP tree/file tools require explicitly selected native tools that issue their
immutable handles. Missing dependencies fail publication.

Every HTTP send waits for durable physical-attempt admission. Native reads allow
three physical requests; MCP allows up to four setup messages and three read
attempts, with seven total wire messages and one 30-second logical deadline.
A separate public metadata check consumes one read allowance when needed.
Responses are bounded to 2 MiB native, 256 KiB MCP and 8 KiB model observations.
Larger permitted response bodies remain private. Completed receipts replay before
adapter lookup; an abandoned started send stays uncertain and is not repeated.

Executable digests bind the actual adapter files. API and worker must use the same
execution mode and artifacts: both compiled for acceptance and production, or both
TypeScript during development. Publishing in one mode and running in another fails
closed until a compatible binding is selected and published.

Local HTTP/SDK fixtures verify these contracts. They do not prove an account can
use GitHub's hosted MCP endpoint. Live acceptance requires an approved expiring
read-only token and records the actual protocol, tool names and schema hashes.
OAuth, private repository access, generic search and arbitrary provider writes
remain unavailable.

See the [platform architecture](architecture/agent-platform-architecture.md),
[implementation boundary](source-boundary.md) and [setup](../README.md).
