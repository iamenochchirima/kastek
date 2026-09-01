# KasiAi Dynamic UI Research

**Status:** Research only. No application, package, or deployment files were modified.

**Research date:** 2026-09-01

**Question:** How do xAI/Grok, ChatGPT/OpenAI, Claude, and the Avalanche Builder Hub produce interactive content in or alongside chat, and what should KasiAi adopt?

## Executive conclusion

The capability the screenshots describe is not one feature called “dynamic UI.” It is a stack of separate capabilities:

1. **Structured model output:** The model returns JSON that conforms to a schema instead of only prose.
2. **Tool/function calling:** The model requests data or an action through a typed tool; application code executes it and returns the result.
3. **UI rendering:** The host application maps structured data or a registered UI resource to a real component such as a table, form, card, stepper, chart, or artifact pane.
4. **Interaction loop:** A click or form submission sends a structured event back to the host/server, which rechecks authorization and either runs a tool or starts a follow-up agent turn.
5. **State and presentation:** The host keeps the conversation, component state, loading/error state, responsive layout, and sometimes a larger side/fullscreen presentation in sync.

The model does not automatically “draw a safe app.” The product supplies the tool contracts, UI runtime, action bridge, security boundary, and fallback behavior. The model chooses or fills those approved capabilities.

For KasiAi, the recommended direction is a **KasiAi-owned, declarative, allowlisted UI protocol** rendered by React components that already belong to the product. It should support inline actions, tables, statistics, structured inputs, previews, approvals, progress, and named workflows. It should not initially accept arbitrary model-generated HTML, CSS, JavaScript, or an iframe URL.

## Terminology

### Structured output

Structured output is a response format contract. The developer supplies a JSON Schema and asks the model to return data matching it. It is useful for a response such as:

```json
{
  "title": "Weekly performance",
  "columns": ["Channel", "Reach", "Engagement"],
  "rows": []
}
```

This JSON is not a UI by itself. KasiAi would still need to validate it and choose a component that renders it.

### Function/tool calling

Tool calling is the action/data contract. The model selects a registered tool and supplies typed arguments. Server code validates and executes the tool, then returns a result to the model. The tool result can be rendered as text, a typed component, or a richer registered UI resource.

### Generative UI

“Generative UI” is an umbrella product term. It can mean a model selecting from a fixed component registry, a tool returning data plus a widget hint, or a model generating a complete application. These have very different security and maintenance profiles.

### Artifact/app UI

An artifact is a larger, self-contained experience—such as a document, dashboard, HTML page, or interactive React app—that deserves a separate pane or workspace. It is not the same thing as an inline button row or a small form inside a message.

## xAI/Grok: documented capabilities

### Structured outputs

xAI documents a `response_format` mechanism with `json_schema`, `json_object`, and `text` modes. Its documentation says that supported schemas are guaranteed to match the supplied schema. It also documents tool calling as a second route to structured arguments; the tool-call arguments strictly conform to the tool input JSON Schema, with `strict` implicitly true.

Source: [xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).

xAI documents a practical JSON Schema subset, including objects, arrays, enums, unions, references, and selected formats. It also documents limits and keywords that are only best-effort. This means a KasiAi protocol would still need its own server-side validation even if the model provider claims schema conformance.

Source: [xAI Structured Outputs — JSON Schema support](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).

### Function/tool calling

xAI’s documented loop is:

1. Define a tool with a name, description, and JSON Schema parameters.
2. Include the tool in the model request.
3. Receive a `tool_call` when the model needs external data or an action.
4. Execute the function in application code.
5. Return the tool result so the model can continue and produce the user-facing response.

Source: [xAI Function Calling](https://docs.x.ai/developers/tools/function-calling).

xAI distinguishes server-side built-in tools from custom tools. Built-in tools execute on xAI’s servers; custom tools pause the loop and return control to the developer for execution. xAI also documents automatic parallel function calling by default, with an option to disable it. This matters for KasiAi because a UI button must not be treated as permission to run an arbitrary tool: the server still owns tool selection, authorization, approval, idempotency, and execution.

Source: [xAI Function Calling — built-in tools, custom tools, and parallel calls](https://docs.x.ai/developers/tools/function-calling).

xAI states that, when streaming, a function call is returned as a whole in one chunk rather than streamed across chunks. A future KasiAi renderer can stream prose, but it should wait for a complete validated UI block or action payload before making a component interactive.

Source: [xAI Function Calling — streaming behavior](https://docs.x.ai/developers/tools/function-calling).

### Is there a public xAI/Grok chat-widget protocol?

**Documented fact:** The public xAI API documentation reviewed here documents structured output and tool/function calling. It does not document a general-purpose API contract equivalent to OpenAI’s MCP Apps UI resources, where a tool associates a resource URI with an iframe component and a standard UI bridge.

**Documented fact:** xAI separately documents Grok Build as an interactive coding agent. Its product announcement says Grok can write code and build a working preview live in the conversation, including websites, apps, games, and interactive dashboards. It says those experiences can be published to a `grok.me` link or a custom domain.

Sources: [Grok Build overview](https://docs.x.ai/build/overview) and [Introducing Build Mode](https://x.ai/news/grok-build-mode).

**Inference:** Grok Build is a hosted product workflow for generating and running larger applications. It should not be treated as evidence that the xAI model API exposes a portable “render this arbitrary widget inside my chat” protocol. For KasiAi, xAI’s structured output and tool loop are reusable concepts; Grok Build’s generated-app runtime is a separate, higher-risk product category.

## OpenAI/ChatGPT: documented UI mechanism

OpenAI’s current public documentation describes the Apps SDK as a way to define both an app’s chat logic and interface inside ChatGPT. It is built on MCP, an open standard for connecting clients to external tools and data, and is open source.

Source: [Build with the Apps SDK](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk).

### The documented rendering path

OpenAI’s UI documentation describes this flow:

1. An MCP server exposes tools with input/output contracts.
2. A selected tool returns structured content and an optional UI resource.
3. The server associates the tool with a UI resource through `_meta.ui.resourceUri`.
4. The host loads the component in an iframe.
5. The component communicates with the host over the MCP Apps JSON-RPC bridge using `postMessage`.
6. The UI can receive tool input/results, call tools, send follow-up messages, and maintain widget state.

Source: [OpenAI: Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui).

OpenAI’s examples repository describes the same architecture as MCP tools plus structured results plus embedded UI resources. Its examples include list views, carousels, maps, checkout flows, state synchronization, tool calls from widgets, and follow-up messages.

Source: [OpenAI Apps SDK examples](https://github.com/openai/openai-apps-sdk-examples).

### Presentation levels

OpenAI recommends choosing the smallest presentation that supports the task:

- **Inline card:** focused result, confirmation, or a small action set.
- **Inline carousel:** scan and choose among similar visual options.
- **Fullscreen:** maps, editing canvases, or detailed browsing.
- **Picture-in-picture:** an ongoing activity that should remain visible while chat continues.

Source: [OpenAI UI presentation guidance](https://developers.openai.com/plugins/build/chatgpt-ui).

This is directly relevant to the supplied examples. The Avalanche “Create New L1” surface is larger than a message but still a bounded workflow. A KasiAi version should begin as a registered workflow panel or expandable card, with a larger pane only when the task genuinely requires it.

### Data tools versus render tools

OpenAI explicitly documents a decoupled pattern: data tools fetch, compute, or mutate data, while render tools receive final data and return the widget template. The documented reason is to avoid remounting UI for every intermediate tool call and to let the model reason over the data before choosing the final presentation.

Source: [OpenAI decoupled data/render tool pattern](https://developers.openai.com/plugins/build/chatgpt-ui).

**Inference for KasiAi:** The same separation should be used even without adopting MCP Apps. Existing KasiAi domain tools should remain the source of truth. A renderer should receive validated data or stable resource IDs, not invent business data while constructing a visual.

### Security and fallback

OpenAI documents that custom UI is optional and tools should remain useful without UI for clients that cannot render components. It also documents iframe isolation, Content Security Policy, server-side input validation, human confirmation for irreversible operations, least privilege, explicit consent, per-call scope enforcement, and keeping secrets/tokens out of component props.

Sources: [OpenAI UI overview and fallback guidance](https://developers.openai.com/plugins/build/chatgpt-ui) and [OpenAI Security & Privacy](https://developers.openai.com/plugins/guides/security-privacy).

**Inference for KasiAi:** The portable part worth adopting is the separation of tool/data contracts from presentation and the idea of a capability bridge. KasiAi does not need to become an MCP app to use those design principles. A same-origin React component registry is simpler for the first release; an iframe/bridge should be reserved for a later sandboxed artifact system.

## Anthropic/Claude: documented interactive content and artifacts

### Interactive inputs and visual responses

Anthropic documents that Claude can respond with custom visual content such as diagrams and interactive charts. It also documents interactive inputs including multiple choice, multi-select, and ranking interfaces. These inputs appear at the bottom of the chat, while the user can still type a normal response instead.

Source: [Anthropic: Visual and interactive content](https://support.claude.com/en/articles/13641943-visual-and-interactive-content).

Anthropic also documents limitations: some visual widgets are web/desktop-only, certain data is text-only, availability depends on the question and available information, and visual data displays need an active internet connection.

Source: [Anthropic: Visual and interactive content — limitations](https://support.claude.com/en/articles/13641943-visual-and-interactive-content).

**Inference for KasiAi:** Interactive inputs are the closest reference for short forms and choice chips. The fallback to typing is important: every KasiAi structured input should degrade to a normal text prompt if the component is unavailable, invalid, stale, or not appropriate for the current viewport.

### Artifacts

Anthropic defines artifacts as substantial, self-contained content that is likely to be edited, reused, or referenced later. Documented examples include documents, code, HTML websites, SVGs, diagrams, and interactive React components. Claude displays artifacts in a dedicated window to the right of the conversation, with editing, version selection, copying, and downloading capabilities.

Sources: [Anthropic: What are artifacts?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) and [Anthropic artifact work area](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them).

Anthropic documents that artifacts can integrate with external services through MCP, can prompt users to approve access on first interaction, and can support personal or shared persistent storage for published artifacts.

Source: [Anthropic artifact MCP and storage integration](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them).

**Inference for KasiAi:** A KasiAi artifact should be a separate product surface with an explicit lifecycle, ownership, authorization, versioning, and storage model. It should not be introduced as “let the model return arbitrary React” inside ordinary chat messages.

## Avalanche Builder Hub reference

### What is officially observable

The official Avalanche Console identifies **Create L1** as a console tool for launching a Layer 1 with custom validators, tokenomics, and governance. The Toolbox describes it as a “guided wizard.” The same console lists other bounded tools for validators, bridges, monitoring, node setup, and related operations.

Sources: [Avalanche Console](https://build.avax.network/console) and [Avalanche Console Toolbox](https://build.avax.network/console/toolbox).

The official Create L1 route is a separate console page and publicly exposes a “Checking requirements...” loading state in the initial HTML response. Its full wizard is client-rendered and was not available as text through the research fetch.

Source: [Avalanche Create L1](https://build.avax.network/console/create-l1).

### What the supplied screenshots show

The screenshots show a bounded, multi-step surface with:

- a title and step count;
- a stepper with numbered stages and an explicit branch (`OR`) for different setup paths;
- inputs and buttons;
- a CLI command card with copy affordance;
- a scrollable content area inside the chat/panel boundary;
- progression to later configuration and conversion steps.

**Inference:** The screenshot is best understood as a prebuilt guided console/wizard rendered in a chat-adjacent or chat-integrated surface. It is not evidence that the model is freely generating arbitrary HTML for every answer. The likely product pattern is a domain-specific flow registry plus trusted backend operations, with the assistant choosing or initiating the flow.

**Boundary of certainty:** The public text pages establish that Avalanche has a guided Create L1 wizard and a toolbox of domain tools. They do not disclose the private implementation of the `/chat` experience or prove whether that page uses an iframe, a custom React pane, or another internal mechanism. That implementation detail should not be assumed.

## KasiAi repository fit

This is a read-only inspection of the current repository; no product code was changed.

### Already present

- [`client/apps/client/src/components/dashboard/kasiai/kasiai-chat.tsx`](../../../client/apps/client/src/components/dashboard/kasiai/kasiai-chat.tsx) already renders outbound assistant Markdown with GitHub-flavored Markdown, including tables and code blocks.
- The same chat surface already has specialized rendering for media, authorization remediation, approval prompts, approval previews, activity/progress indicators, and model/audio controls.
- [`client/apps/client/src/lib/agent-platform.ts`](../../../client/apps/client/src/lib/agent-platform.ts) already has a durable `AgentMessage` shape. Its content type currently exposes `text`, `authorizationRequired`, and an open-ended unknown-field escape hatch, but it has no named, validated UI-block contract.
- [`agents/src/media/contracts.ts`](../../../agents/src/media/contracts.ts) defines a strict durable response contract with `version`, `text`, `media`, and `authorizationRequired`. It does not currently include a general UI or workflow field.
- [`agents/src/temporal/activities.ts`](../../../agents/src/temporal/activities.ts) registers `kasitek.agent.respond` as the final response control and validates its current text/media response shape.
- [`agents/src/runtime/loop.ts`](../../../agents/src/runtime/loop.ts) already runs the fundamental tool loop: tool proposal, authorization/approval handling, tool invocation, safe output projection, and final response construction.
- [`agents/src/db/repositories/run-repository.ts`](../../../agents/src/db/repositories/run-repository.ts) persists the parsed response JSON into the outbound message and currently classifies it as text unless it contains media.
- [`agents/src/system/kasiai.ts`](../../../agents/src/system/kasiai.ts) already directs the agent to use trusted tools, avoid leaking identifiers/credentials, and handle authorization as a UI/Connections flow.

### Missing capability

The missing layer is not Markdown. It is a general contract connecting:

```text
trusted tool/data result
        -> validated response/UI descriptor
        -> durable message/run state
        -> registered client component
        -> structured interaction event
        -> existing authorization/approval/tool loop
```

The current open-ended `AgentMessage.content` type is not sufficient as a contract. It lets unknown fields pass through, but it does not tell the server which UI shapes are valid, which actions are allowed, how state is versioned, or how non-platform channels should degrade.

## Recommended KasiAi architecture

### 1. Use a host-owned declarative UI protocol

Define a versioned `KasiAiUi` response extension containing a bounded list of typed blocks. The first block families should be:

- `actions`: one to five buttons/chips with stable action IDs;
- `table`: typed columns and rows for read-only data;
- `stats`: KPI/value cards with optional trend and status;
- `choice`: single-select, multi-select, or ranking input;
- `form`: a small set of typed fields such as text, number, date, select, or file reference;
- `preview`: a trusted resource/content preview;
- `approval`: a presentation of the existing approval boundary;
- `progress`: named steps with pending, active, complete, or error states;
- `workflow`: a reference to a registered product flow, not arbitrary component code.

Each block should have a stable ID, schema version, accessibility labels, and explicit limits. Unknown block types should be ignored with the text response preserved.

### 2. Separate data from presentation

Keep domain tools responsible for fetching, calculating, validating, and mutating data. Let the response layer choose whether the result needs text, a table, a card, or a registered workflow. Do not let the model manufacture authoritative metrics, permission state, or external resource IDs inside a visual block.

For large or expensive surfaces, prefer a stable resource reference such as `reportId`, `contentId`, or `workflowId` and have the renderer load authorized data through the application boundary. Do not put credentials, provider tokens, signed URLs with long lifetimes, or raw provider scopes into UI props.

### 3. Make actions capability-based, not tool-name-based

An action should carry a stable UI action ID and typed values, for example:

```json
{
  "blockId": "content-preview-1",
  "actionId": "schedule-content",
  "values": { "publishAt": "2026-09-03T09:00:00+02:00" },
  "uiVersion": "1"
}
```

The server maps `schedule-content` to an allowlisted capability. It must recheck organization, installation, user, connection, approval, resource ownership, freshness, and idempotency before invoking an existing tool or creating a follow-up agent run. The client must never be able to choose an arbitrary backend function by sending a tool name.

### 4. Treat forms as agent turns, not privileged shortcuts

A choice or form submission should normally create a structured user message/follow-up run. If the interaction invokes a side-effecting operation directly, it must enter the existing approval system first. The visual is an input surface, not an authorization boundary.

### 5. Use progressive presentation

Recommended presentation hierarchy:

1. Inline action row or small card.
2. Expandable card with table, form, preview, or stepper.
3. Resizable side panel for a longer workflow.
4. Separate artifact/workspace surface for persistent dashboards, planners, and editors.

This matches the user’s screenshots while keeping ordinary chat readable. The compact widget should not be forced to contain a full application when the task needs a larger surface.

### 6. Preserve channel fallback

Platform web chat can render the full block protocol. External channels should receive the best supported representation:

- tables become concise Markdown/text;
- actions become channel-native buttons when available, otherwise numbered reply choices or links;
- forms become a guided sequence of questions;
- progress becomes text status;
- artifacts become an authorized link or an exportable file.

The durable message should remain understandable without the web renderer.

## Suggested first product slice

This is a planning recommendation, not an implementation request.

### Slice A: useful inline UI

- action chips/cards for common next steps;
- read-only tables and KPI/stat cards from trusted tool output;
- rich content/resource previews using existing authorization and media rules;
- loading, stale, error, and empty states;
- mobile and non-platform fallback.

### Slice B: structured task completion

- choice and multi-select blocks;
- small forms with inline validation;
- approval-aware confirmation previews;
- progress blocks for multi-step tasks.

### Slice C: Avalanche-style registered workflows

Create a reusable `workflow`/`wizard` host component. A workflow definition should own its steps, fields, validation, safe data sources, action mappings, and completion states. The model should select a registered flow ID and provide context; it should not generate the flow’s component code.

Potential KasiTek workflows include:

- content planning and draft creation;
- content preview, approval, scheduling, and publish;
- connection/permission setup and remediation;
- campaign/report exploration;
- workspace onboarding and setup checklists.

The Create L1 screenshot maps to this category: stepper, branching path, command card, input, validation, and next-step actions all belong to one authored workflow.

### Slice D: artifacts later

Add a separate artifact record and workspace only after inline blocks and workflows have stable contracts. If custom code is ever allowed, use a sandboxed origin/iframe, a narrow CSP, a versioned resource URI, a capability bridge, explicit user authorization, and server-side data access. Never execute model-generated JavaScript in the main KasiTek origin.

## Security and reliability requirements

These should be requirements in any future implementation plan:

- Validate every UI response server-side and client-side.
- Use an allowlist of component types and field types.
- Bound block count, nesting depth, row count, string lengths, and total payload size.
- Render text safely; do not introduce arbitrary HTML injection.
- Sanitize and allowlist links and image/resource origins.
- Keep server-side authorization authoritative; never trust disabled buttons or hidden fields.
- Use stable action IDs, idempotency keys, expiry/freshness checks, and audit events.
- Require explicit approval for irreversible or external-effect operations.
- Keep secrets, OAuth tokens, raw provider scopes, and long-lived signed URLs out of response/UI state.
- Treat tool results and retrieved content as untrusted input because prompt injection can reach them.
- Provide accessible labels, keyboard navigation, focus management, and responsive layouts.
- Preserve a text fallback for unsupported clients and failed component rendering.
- Version both the protocol and durable workflow/resource definitions so old conversations continue to render.

These requirements are consistent with the security concerns in [OpenAI’s plugin security guidance](https://developers.openai.com/plugins/guides/security-privacy), but they are recommendations for KasiAi, not claims that KasiAi already implements all of them.

## Decisions and non-decisions

### Recommended decisions

- Adopt the concepts of typed output, registered components, structured events, host-owned state, and tool/data/render separation.
- Keep the first UI runtime same-origin and React-native inside the existing chat/panel product.
- Start with inline blocks and registered workflows.
- Reuse the existing approval, authorization, media, run, and durable-message boundaries.
- Make every block optional and preserve normal text output.

### Defer

- Do not adopt OpenAI’s Apps SDK wholesale unless KasiAi is being exposed as an MCP app inside ChatGPT.
- Do not make xAI/Grok Build the runtime for KasiAi UI.
- Do not let the model emit arbitrary HTML, CSS, or JavaScript into the main application.
- Do not build a generic “render anything” UI DSL before concrete KasiAi workflows prove the need.
- Do not create a separate action execution path that bypasses current approvals and authorization checks.

## Source inventory

Primary/first-party sources reviewed:

- [xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [xAI Function Calling](https://docs.x.ai/developers/tools/function-calling)
- [xAI Grok Build overview](https://docs.x.ai/build/overview)
- [xAI Introducing Build Mode](https://x.ai/news/grok-build-mode)
- [OpenAI: Build with the Apps SDK](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk)
- [OpenAI: Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI: Security & Privacy](https://developers.openai.com/plugins/guides/security-privacy)
- [OpenAI Apps SDK examples](https://github.com/openai/openai-apps-sdk-examples)
- [Anthropic: Visual and interactive content](https://support.claude.com/en/articles/13641943-visual-and-interactive-content)
- [Anthropic: What are artifacts?](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-I-use-them)
- [Avalanche Console](https://build.avax.network/console)
- [Avalanche Console Toolbox](https://build.avax.network/console/toolbox)
- [Avalanche Create L1](https://build.avax.network/console/create-l1)
