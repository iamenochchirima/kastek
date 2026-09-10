# Hermes and Waku capability awareness

This note compares the local Hermes and Waku implementations of capability
awareness: tool schemas, skills, providers, connections/credentials, and
permissions. The evidence is limited to source code in these two checkouts; it
does not infer behavior from README or product documentation.

The source snapshots examined were:

- Hermes: `9a84bee265daad14340a80d7585928cd8ea1f9eb`
- Waku: `21486b39ca2b59cf3a616159139712f4bef0914c`

Line references use the absolute checkout paths so that they remain
unambiguous from this repository:

- Hermes: `/home/enoch/aworkspace/agents/hermes-agent`
- Waku: `/home/enoch/aworkspace/agents/waku-agent`

## Summary

| Concern | Hermes | Waku |
| --- | --- | --- |
| Tool registry | Process registry with built-in discovery, profile-scoped overlays, toolset membership, availability probes, dynamic schema overrides, and generation-aware snapshots. | Per-agent in-memory registry. A `Tool` is name, description, JSON input schema, and callable; the registry serializes schemas and dispatches by name. |
| Tool projection | Select toolsets, subtract disabled toolsets, remove tools whose availability checks fail, rewrite dependent schemas, then optionally defer MCP/plugin schemas behind a search/describe/call bridge. | `build_registry()` registers a fixed core set and conditionally registers adapters from settings. Every registered tool is sent in every normal loop request. |
| Skill discovery/loading | Prompt receives a metadata index. Full `SKILL.md` and linked files are loaded later through `skill_view`; visibility considers platform, environment, tool/toolset conditions, disabled names, project precedence, and profile scope. | Loader scans frontmatter and bodies, scores name/description keyword overlap, and injects up to two matching bodies directly into the per-turn system prompt. Referenced files are not a separate runtime capability. |
| Connections and credentials | Provider and tool registries support profile-scoped overlays. Secret reads are context-scoped and fail closed when multiplexing has no active profile scope. MCP can register cached schemas lazily, then connect on first use. | One `Settings` object selects provider and env-backed adapters. `integrations.py` is a declarative connection catalog with required/secret fields, optional dependency checks, status/probe state, and reload mode. MCP uses `auth_env` or browser OAuth, never an inline token. |
| Permissions | Tool availability and profile scope constrain the callable catalog; MCP captures trust/read-only metadata and gates untrusted write tools before transport. | Settings opt-in adapters; channel gateways enforce user/channel/mention policies. Tool registration itself is capability gating, but there is no general per-tool permission object. |
| Prompt contract | System prompt has ordered cache tiers and tool-aware guidance. The skills index explicitly tells the model to load relevant skill bodies with `skill_view`. | `Session.build_system()` composes `SOUL.md`, clock/provider identity, gated memory, and matching skill bodies. `run_loop()` passes `tools.schemas()` separately to the model. |

## Hermes

### Tool registry, schema projection, and progressive disclosure

Hermes makes registration the source of truth. The registry module states that
tool modules self-register their schema, handler, toolset, and availability
check, while `model_tools.py` queries that registry instead of maintaining
parallel lists (`tools/registry.py:1-6`). Built-ins are discovered by scanning
tool modules for `registry.register()` calls and importing only those modules
(`tools/registry.py:86-124`). Each entry retains the model schema, handler,
toolset, optional `check_fn`, required environment names, and a dynamic schema
override (`tools/registry.py:164-180`).

The registry is profile-aware. It stores process-global entries and per-profile
plugin overlays, merges an active profile over globals, and takes a coherent
entry/check snapshot under a lock (`tools/registry.py:368-425`). This is an
important boundary: profile-specific registrations can be visible to one agent
without becoming globally callable. The registry also prevents unapproved
plugin shadowing and requires explicit override policy for a plugin replacing a
built-in (`tools/registry.py:596-646`).

The model-facing projection is a pipeline rather than a raw registry dump:

1. `get_tool_definitions()` accepts enabled and disabled toolsets and documents
   that disabled sets are subtracted after enabled sets
   (`model_tools.py:212-220`).
2. `_select_tool_names()` resolves enabled sets and subtracts disabled sets last,
   so a composite toolset cannot accidentally re-enable a disabled capability
   (`model_tools.py:313-334`).
3. `_compute_tool_definitions()` asks the registry for definitions, which keeps
   only entries whose `check_fn` passes, then applies dynamic schema rewrites
   (`model_tools.py:444-451`; `tools/registry.py:758-788`).
4. After schema sanitization, MCP/plugin tools may be replaced by a
   `tool_search`/`tool_describe`/`tool_call` bridge when the deferred surface is
   too large; the bridge reconstructs a session-scoped uncollapsed catalog and
   rejects names outside it (`model_tools.py:464-476`, `model_tools.py:642-681`).

This gives Hermes two kinds of awareness: the model gets only callable schemas
for this toolset/profile, while a larger optional surface can remain discoverable
without occupying the initial context window.

MCP follows the same registry contract. A connected or schema-cached server is
converted into candidate schemas and handlers, filtered by configured include /
exclude rules, assigned the `mcp-<server>` toolset, and registered with a server
availability check (`tools/mcp_tool_registration.py:112-127`, `tools/mcp_tool_registration.py:153-166`, `tools/mcp_tool_registration.py:223-249`). A lazy server can register its cached schemas before the process has spawned it; first use performs the connection and removes phantom cached tools that the live server no longer exposes (`tools/mcp_tool_discovery.py:135-177`).

### Skills: metadata first, body on demand

Hermes has an explicit progressive skills contract. The tool module describes
`skills_list` as returning name/description only and `skill_view` as returning
the full `SKILL.md` plus linked files (`tools/skills_tool.py:1-5`). The
`skill_view` response includes content, path/provenance, linked files, and
readiness metadata (`tools/skills_tool.py:519-595`). The model-facing schema
also says to use `skill_view` for the full body and to request linked files
separately (`tools/skills_tool.py:600-631`).

The system prompt therefore contains a compact index, not every skill body.
Hermes renders categories and descriptions and instructs the model to load a
skill with `skill_view(name)` whenever it is even partially relevant
(`agent/prompt_builder.py:1275-1325`). The index build cache is keyed by the
skills roots, available tools, available toolsets, platform, disabled names,
and compact-category mode (`agent/prompt_builder.py:1328-1353`). This means
skill visibility is projected from the same runtime capability information that
projects tools.

Compatibility gates are applied before rendering. `_parse_skill_file()` checks
platform and environment compatibility, while `_skill_should_show()` hides a
skill when its required tool/toolset is absent or its fallback tool/toolset is
present (`agent/prompt_builder.py:1145-1176`). Project skills have precedence,
external directories are read-only additions, and name collisions are surfaced
instead of silently choosing an ambiguous personal/org skill
(`agent/prompt_builder.py:1372-1397`, `agent/prompt_builder.py:1258-1272`).
Project skill files are scanned for dangerous content and quarantined before
they enter the index/list/view path (`agent/skill_utils.py:508-558`).

Finally, the full system prompt is split into stable, context, and volatile
tiers. The skill index is deliberately placed in the volatile tier because it
can change while the stable identity and guidance remain reusable
(`agent/system_prompt.py:588-635`). The skills block is only built when a
skills tool is actually present, and its available-tool/toolset sets come from
the agent's valid tool names (`agent/system_prompt.py:298-311`).

### Providers, connections, and credentials

Hermes uses the same scoped-overlay pattern for pluggable providers. The generic
`ProviderRegistry` supports global and per-profile maps, scoped-first lookup,
list/snapshot operations, generation fingerprints, and plugin restore
(`agent/provider_registry.py:27-35`, `agent/provider_registry.py:69-148`). Provider
selection is explicit and ordered: requested/configured provider, scoped API
keys, credential pools, provider environment keys, OAuth state, and then cloud
credential chains; no provider produces an explicit error
(`hermes_cli/auth.py:1397-1467`). OAuth flows are represented as named provider
records with resolver and status functions (`hermes_cli/auth.py:1680-1723`).

The key security contract is the secret scope, not prompt text. In multiplex
mode, `get_secret()` reads a task-local profile mapping and raises if a caller
tries to read a profile credential with no active scope, rather than falling
back to another profile's process environment (`agent/secret_scope.py:1-10`,
`agent/secret_scope.py:110-137`). The scope is built from the profile's `.env`
and external secret sources while excluding process-global variables
(`agent/secret_scope.py:188-199`). Thus the agent can be told that a provider or
tool is ready without placing its credential in the model-visible contract.

For MCP, Hermes records server trust and each tool's read-only hint at discovery;
the call-time gate uses this controlled metadata rather than trusting fresh
server-supplied state (`tools/mcp_tool_registration.py:31-56`). On an
`untrusted` server, a write-capable tool requires approval before any transport
work, including a lazy spawn; approval failures block the call
(`tools/mcp_tool_handlers.py:38-60`, `tools/mcp_tool_handlers.py:424-425`).

### Hermes prompt/system contract

Hermes makes tool awareness explicit in prompt guidance. It gates tool-specific
instructions by the agent's valid tool names, and only adds skills guidance when
the skills tools exist (`agent/system_prompt.py:280-311`). The system prompt
builder combines identity, tool-aware guidance, context, skill index, memory,
plugin sections, and timestamp in ordered cache tiers; caller-provided system
messages are kept in the context tier (`agent/system_prompt.py:588-647`). The
resulting contract is therefore:

- schemas in the API `tools` field are the authoritative callable surface;
- the system prompt explains how to use only the projected tools;
- skill metadata is in the prompt, while skill instructions are fetched through
  a tool call;
- credentials and account state stay outside the model-visible prompt.

## Waku

### Tool registry and conditional registration

Waku's registry is intentionally small. Its `Tool` dataclass contains exactly a
name, description, input schema, callable, and an optional internal notification
flag; `to_api()` is the model schema projection (`waku/tools/registry.py:15-35`).
`ToolRegistry.register()` overwrites by name, `schemas()` returns every entry,
and `execute()` dispatches safely by name, returning an error string instead of
raising into the loop (`waku/tools/registry.py:37-58`). There is no registry
availability probe or per-entry permission field.

Capability projection happens at construction time in `build_registry()`. Core
calendar, notes, messages, and search tools are always registered; memory
self-management tools appear only when memory exists; experimental, Apple,
GitHub, and MCP tools are registered only when their settings/configuration
allows them (`waku/tools/__init__.py:14-81`). The comments around GitHub make
the boundary explicit: a library workflow may use GitHub without giving the
model the GitHub tool, because the switch controls model reachability
(`waku/config.py:104-125`).

Unlike Hermes, the normal loop sends all currently registered schemas on every
model call. Both streaming and non-streaming paths pass `tools.schemas()` to
the provider, and the same registry executes requested calls
(`waku/loop/agent.py:63-110`). Waku's progressive disclosure is therefore at
agent construction (optional adapters omitted), not at tool-call discovery
inside a large runtime catalog.

MCP registration is eager at startup. `MCPBridge.start()` connects configured
servers and translates each discovered tool into a model-safe name, description,
input schema, and closure that calls the original server name
(`waku/tools/mcp_client.py:95-141`). A failed server is skipped while the agent
continues. Waku refuses ambiguous transport/auth configuration, uses an
environment variable named by `auth_env` rather than an inline credential, and
supports a separate browser OAuth path (`waku/tools/mcp_client.py:143-203`).

### Skills: scan frontmatter, load matching bodies

Waku's procedural loader also implements progressive disclosure, but it does so
automatically rather than through a model-callable skill viewer. The loader
scans every `SKILL.md` frontmatter cheaply, stores the parsed body, and reloads
when the file signature changes (`waku/memory/procedural/loader.py:47-75`). A
message is tokenized and compared with each skill's name and description; only
skills with at least two overlapping words are returned, capped at two
(`waku/memory/procedural/loader.py:77-91`). `Memory.matching_skills()` then
concatenates the matched bodies, and `Session.build_system()` injects them as
   "Relevant skill instructions" (`waku/memory/__init__.py:103-106`,
`waku/runtime/session.py:77-88`).

The loader searches bundled and per-home skill directories, and `create_skill`
validates a new frontmatter/body file, refuses to overwrite an existing name,
and refreshes the in-memory loader immediately (`waku/memory/__init__.py:26-56`,
`waku/tools/memory_admin.py:118-133`). Waku does not expose linked-file loading
or tool/toolset/platform compatibility conditions in this path; relevance is
message keyword overlap.

### Providers, connections, and credentials

Waku's provider contract is a frozen table. Each `Provider` declares wire kind,
key environment variable, endpoint, default model pair, optional regional
endpoints, and catalog URL (`waku/loop/models.py:28-79`). `get_client()` resolves
the selected provider, reads either an explicit setting or the provider's key
environment variable, rejects missing/non-ASCII keys, and builds the provider
client (`waku/loop/models.py:239-257`). Provider identity is also visible to the
model through the session prompt (`waku/runtime/session.py:69-75`).

Connections are declared separately in one typed catalog. `Integration` records
group/name/description, environment fields, secret flags, optional dependency,
reload mode, enable predicate, and probe (`waku/integrations.py:59-94`). The
catalog includes provider integrations derived from the provider table and
non-provider channels, calendars, memory stores, search, and tracing
(`waku/integrations.py:157-277`). Status distinguishes missing configuration,
missing optional packages, configured-but-unprobed, connected, and error; secret
fields are represented in views as configured plus last four characters, while
probes receive the actual values (`waku/integrations.py:362-401`).

Remote MCP credentials are bound at transport construction. `auth_env` is
looked up only by name and sent as a Bearer header; OAuth stores tokens and
client registration one file per server under `WAKU_HOME/mcp-auth`, writes with
mode `0600`, and never logs the bearer file (`waku/tools/mcp_client.py:19-31`,
`waku/tools/mcp_client.py:166-203`, `waku/tools/mcp_oauth.py:39-110`).

### Permissions and prompt/system contract

Waku gates capability mostly through settings and gateway policy. Apple writes,
Google synchronization, Apple automation tools, GitHub model tools, and
experimental delegation are opt-in settings (`waku/config.py:90-125`). Telegram
uses an optional user allowlist (`waku/gateway/telegram.py:30-69`). Discord's
pure access policy denies non-allowlisted users, requires allowlisted channels
for non-DM traffic, and optionally requires a mention; an empty channel list
means no server channel, not every channel (`waku/gateway/discord.py:84-106`).
These policies protect gateway reachability, while tool registration protects
model reachability.

The prompt contract is direct and per-turn. `Session.build_system()` loads
`SOUL.md`, appends local time and provider/model identity, gates durable memory
retrieval, and injects matched skill bodies (`waku/runtime/session.py:44-88`).
The loop then sends that string as `system` and the registry schemas separately
as `tools` (`waku/loop/agent.py:66-86`). There is no prompt section enumerating
all connected integrations or readiness reasons; the model discovers a
capability by seeing its schema and learns backend truth from tool output.

## Comparison and implications for KasiTek

The two systems solve different halves of capability awareness:

1. Hermes has the stronger runtime projection boundary. Its registry can answer
   "what is callable for this exact profile?" using scope, toolset selection,
   availability checks, and dynamic schemas. Its skill index is projected from
   that same answer and defers bodies and linked files until needed.
2. Waku has the simpler connection UX boundary. Its `Integration` records make
   provider/connection setup, secret fields, optional packages, health, and
   reload behavior one inspectable catalog. Its MCP connector keeps auth
   material out of config and supports a user-driven OAuth path.
3. Hermes defers large tool catalogs while Waku omits optional tools at agent
   construction. Hermes defers skill bodies through an explicit model tool;
   Waku automatically injects only top keyword matches. Neither pattern alone
   establishes a durable per-agent authorization snapshot.

For KasiTek's capability-aware runtime, the most transferable contract is:

- resolve one per-agent/per-run capability snapshot before prompt assembly;
- derive the callable tool schemas, readiness/unavailability reasons, and
  skill visibility from that same snapshot;
- preserve connection/provider identity and credential binding in trusted
  runtime state, never in model-visible text;
- expose a compact skill/tool index first and load full skill content only on
  demand (Hermes's `skill_view` pattern is the closest match);
- retain Waku's typed connection metadata (`secret`, required fields,
  dependency, probe, reload mode) as the operator-facing source of readiness;
- treat account/channel/approval constraints as projection inputs, not merely
  prose guidance, and re-check them at dispatch time;
- keep a tool absent from the model schema when its permission or connection
  cannot be proven, while making the reason available to the runtime and
  diagnostics.

The main caution is that Hermes's keyword/tool-condition skill hiding and
Waku's message-overlap loading are heuristics. A KasiTek effective snapshot
should preserve explicit skill compatibility dimensions (channel, audience,
tool requirements, and readiness) rather than reconstructing them from names or
phrases after the fact.
