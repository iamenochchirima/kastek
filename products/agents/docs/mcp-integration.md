# Integration boundaries

Owner: Agents engineering. Last reviewed: 2026-10-18.

The shared execution service uses two technical execution kinds: `business` and `workspace`. Connections do not
create another agent category. Business execution uses Restate; the Lina workspace
adapter remains unavailable.

| Connection | Contract | Current boundary |
| --- | --- | --- |
| External agents to Growth or Agencies | Product-owned MCP with OAuth or scoped API keys. | Separate product work; no Agents gateway. |
| Product backends to Agents execution | Authenticated service with initiating identity and bounded authority. | Signed delegated-identity contract fixtures exist; production product integration and richer private resource contracts remain unavailable. |
| Customer channels to Agents | Verified channel binding, customer event identity, conversation ownership, and authorized automated or human replies. | Website/widget execution and shared Inbox controls are implemented. WhatsApp, Facebook and Instagram remain unavailable. |
| Business agents to external reads | Immutable selected native HTTP or MCP bindings, current connection/resource authority and durable receipts. | Public repository and Stash profiles implemented; see acceptance status below. |
| Business agents to report delivery | Exact report bytes, one human approval, one dispatch claim, status-only recovery. | ReportDeliveryHTTP with a verified persistent local receiver. |

Customer channels are separate from external-agent MCP access and outbound tool connections.
The standalone client targets support, FAQ, booking, and intake. Research and campaign experiences
belong in Growth or Agencies. The read/report adapters below are shared runtime capabilities;
they do not define the Agents client catalogue. Provider OAuth and generic MCP-server onboarding
are not implemented by the current bearer-key profiles.

## Public repository reads

The `public-repository-read-v1` profile requires no external credential. It combines
anonymous GitHub REST reads with DeepWiki MCP at `https://mcp.deepwiki.com/mcp`.
The owner selects exact public repositories and refs. A connection retains local
ownership, policy generation and a finite authorization window; its credential
revision has a SQL NULL envelope. No Authorization header is sent to either service.
Key replacement is unavailable for this profile.

Native reads use the same commit/file handles as the keyed GitHub profile. DeepWiki
permits only `read_wiki_structure` and `read_wiki_contents` for an approved repository.
The model cannot send a question, URL or private context to DeepWiki. A native
public-repository check consumes one physical read before each MCP invocation.
DeepWiki documentation is a timestamped provider observation, not a snapshot of the
Git commit. Missing indexes, oversized responses and tool errors remain explicit;
the adapter does not request indexing or follow returned links.

## Private Stash reads

The `stash-read-v1` profile connects to `https://api.stash.kasitek.co.za/mcp` using
an encrypted Stash agent key. The owner selects exact note or idea IDs. Stash keys
have account-wide authority, so Agents independently limits each binding and
specialist to selected items. Only `get_item` and `read_project_document` are allowed;
there are no search, write, summary-generation or original-file tools in this profile.
The second tool requires a project document.

A finite connection expiry is an Agents authorization window. It does not assert
that a manual Stash key has a provider expiry. Key replacement and revocation use
the existing connection controls. Outgoing arguments contain only the approved
item ID and bounded offset. Private item identifiers use the
`approved_resource_identifiers` disclosure policy.

The executor reads Stash's inline JSON text envelope, verifies the item ID, kind,
revision and document chunk metadata, and records a bounded text passage and
citation. It excludes unrelated item metadata from model context. A changed item
revision within one root yields an explicit conflict; a fresh task can read the new
revision. UTF-16 offsets cannot turn split surrogate pairs into replacement text
in stored evidence. Stash REST cookies and the chat connector's credentials are
not reused by the worker.

## MCP compatibility

The isolated SDK supports MCP 2026-07-28 and the explicit 2025-11-25 negotiation
path. Schemas retain their original digests. The restricted schema subset accepts
2020-12 and compatible draft-07 schemas, UUID format and the boolean-true
`x-fastmcp-wrap-result` annotation used by DeepWiki. Arbitrary patterns, other
formats, nested dialect changes and unknown extensions remain denied.
Local fixtures and public-service probes have separate evidence. Stash worker
acceptance requires an explicitly supplied read key; using Stash in the chat does
not establish acceptance through Agents. GitHub's authenticated MCP endpoint is an
optional integration check, not a prerequisite for public MCP execution.

## Outbound GitHub reads

A connection belongs to an organization and account. The owner supplies an expiring
read-only PAT and explicit public repositories/revisions. AES-256-GCM protects the
credential with an external keyring. The server chooses endpoints and headers;
model arguments cannot supply credentials, paths, refs, URLs or arbitrary queries.

Native REST supports metadata, releases, immutable commit resolution, bounded tree
listing and text-file reads. Issued revision/file/release handles bind the task's
root, connection policy and approved resource. Related content reads use the same
resolved commit SHA. Observations carry acquisition time and response digests.
Native `list_tree` accepts an optional exact `filePath` filter over the validated
tree. Native `read_file` accepts `maxBytes` from 128 to 4,096, defaulting to 4,096.
Both controls apply locally after the bounded provider read; neither changes the
remote URL, authorization or immutable file verification. Smaller visible spans
retain exact citation hashes and valid UTF-8 boundaries.

The isolated outbound adapter uses `@modelcontextprotocol/client@2.3.1`. It requests
MCP 2026-07-28 and explicitly supports the 2025-11-25 HTTP negotiation path. Only
selected trusted GitHub read operations are available. Provider read-only headers
and tool filters supplement local validation. Sampling, roots, elicitation, stdio,
subscriptions, arbitrary remote writes and resource-link traversal are denied.
For `get_file_contents`, the executor reads the returned inline text resource.
It requires the accepted repository, commit and file path in the resource URI,
then verifies the UTF-8 byte count and Git blob digest against the issued file
handle. Status messages do not count as file evidence. Binary, linked, missing
or mismatched bodies fail explicitly; the executor does not fetch resource URIs.

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
An immutable native claim bounds a live read by its original operation, binding and task
deadline. Concurrent callers receive `CONNECTED_READ_IN_PROGRESS` without adopting the claim.
Expired or orphaned claims become uncertain and never authorize another provider request.
Physical-attempt admission and final publication check the exact token and database deadline.
The executor holds no database transaction or session-lock connection during provider waits.
The model receives exact source text, citations, acquisition time and provenance.
Its view omits internal receipt IDs and digests, and omits duplicate structured
handles only when the same named IDs occur in that text. Complete durable receipts
and their byte limits remain unchanged.

Anonymous access still has provider quotas. HTTP 429 and quota-confirmed 403
responses yield `RATE_LIMIT`; 401 and other 403 responses yield `AUTHENTICATION`.
Retries respect both declared reset and Retry-After times within the original
attempt and deadline limits. An exhausted quota without safe retry timing fails
immediately. The public profile retains its GitHub publicness check even when
that shared anonymous quota prevents a DeepWiki read.

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
