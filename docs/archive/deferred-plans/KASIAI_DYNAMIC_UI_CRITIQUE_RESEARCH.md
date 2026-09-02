# KasiAi Dynamic UI — Critique Research

**Status:** Research and plan critique only
**Date:** 2026-09-01
**Scope:** `docs/archive/deferred-plans/KASIAI_DYNAMIC_UI_PLAN.md`, relevant KasiAi capability,
response, run, and client seams, and first-party guidance. No application, package, or
deployment files were changed.

## Executive summary

The current plan has the right goal and safety concerns, but it is too broad in its proposed
contract and not specific enough about interaction quality. Its main risk is creating a second,
model-authored UI language: an agent response containing arbitrary `ui.blocks`, generic workflows,
client action wiring, and capability metadata that tries to describe both execution and display.
That would make the experience look dynamic while making correctness, accessibility, authorization,
state restoration, and mobile behavior fragile.

The recommended direction is narrower:

> Keep the existing capability registry as the execution authority. Add a server-owned presentation
> projection that turns an authorized, current tool result into a small host-rendered view model.
> Use inline cards for one decision, an expanded view for real workflows, and durable domain state
> for user work. The model may select intent and provide narration, but it must not invent data,
> permissions, action wiring, or arbitrary layout.

This preserves customizability while making the compact widget and expanded experience feel like one
product rather than a collection of ad hoc cards.

## Primary-source findings

### 1. MCP Apps supports rich UI, but it is a host-controlled application lifecycle

The official MCP Apps model is a tool plus a declared UI resource. The host fetches the resource,
renders it in a sandboxed iframe, and mediates communication through the host bridge. The app can
receive tool results, call tools, update model context, react to host context changes, and clean up
on teardown.

Sources:

- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP Apps build guide](https://modelcontextprotocol.io/extensions/apps/build)
- [MCP Apps lifecycle API](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html)
- [MCP Apps interaction patterns](https://apps.extensions.modelcontextprotocol.io/api/documents/patterns.html)

Implication for the plan: MCP Apps is a useful reference for the bridge, lifecycle, sandbox, and
display-mode concepts. It is not a reason to introduce an iframe runtime or a general component
DSL into KasiAi’s first release. A same-origin host renderer is appropriate while KasiAi owns the
UI and capabilities.

### 2. Inline UI should be deliberately small; complex work should expand

OpenAI’s UI guidance recommends inline cards for one action or decision or a small amount of data.
It warns against deep navigation, multiple views, tabs, nested scrolling, duplicate inputs, and
crowding the card with actions. It recommends limiting primary actions and using expanded/fullscreen
surfaces for rich or multi-step work.

Source: [OpenAI UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)

Implication for the plan: the proposed one-to-five action range is too permissive. The inline
contract should normally expose one primary action and at most one secondary action. Additional
actions belong behind disclosure, a follow-up, or an expanded surface. The widget’s expand control
should open a real workspace/sheet with a deliberate responsive layout, not merely make the same
narrow card taller.

### 3. State has different owners and must not be collapsed into widget state

OpenAI’s UI guidance separates authoritative business data, ephemeral UI-instance state, and
durable cross-session state. The UI renders server-authoritative results and temporary interaction
state; the server validates actions and returns updated data. MCP Apps similarly documents stable
view identity, teardown persistence, host-context changes, and app-only tools for refresh or
pagination.

Sources:

- [OpenAI UI state management](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP Apps interaction patterns](https://apps.extensions.modelcontextprotocol.io/api/documents/patterns.html)

Implication for the plan: add an explicit state ownership model. A selected row, expanded section,
or filter is UI state. A draft agent, social connection, report, or content item is domain state.
A long-running job is run/workflow state. Conversation context is separate again. Do not use the
chat message or browser-local state as the source of truth for user work.

### 4. Actions are untrusted inputs and must be server-authorized

OpenAI’s tool and security guidance requires server-side validation, authorization on every call,
careful structured output, confirmation for irreversible operations, and no secrets in UI payloads.
ChatKit guidance also treats action payloads as untrusted and recommends server handlers for
side-effects. App-only tools are useful for UI mechanics that should not add noise to model context,
such as refresh, pagination, and form submission.

Sources:

- [OpenAI MCP server/tool result guidance](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI security and privacy](https://developers.openai.com/plugins/guides/security-privacy)
- [OpenAI ChatKit actions](https://developers.openai.com/api/docs/guides/chatkit-actions)

Implication for the plan: a client event containing `blockId`, `actionId`, values, and an idempotency
key is only an input envelope. The server must resolve the capability, current resource, actor,
grant, approval requirement, version/freshness, and allowed transition. Static action lists in a
manifest cannot be treated as the effective action list for a particular result.

### 5. Long-running work needs a durable handle and resumable states

MCP Tasks formalizes durable handles, `working`, `input_required`, `completed`, `failed`, and
`cancelled` states, plus polling, input, and cooperative cancellation. It specifically targets
human-in-the-loop work, external jobs, unreliable connections, and mobile clients.

Source: [MCP Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview)

Implication for the plan: do not create a second generic workflow engine before mapping these
semantics onto KasiTek’s existing run, approval, external-event, retry, cancellation, and SSE
paths. Create a separate durable workflow object only when it represents user-owned work that must
outlive a single agent run.

### 6. Accessibility and forms must be contract requirements, not renderer aspirations

W3C guidance requires labels and programmatic associations, logical grouping, usable instructions,
inline error identification, preserved values, and focus management. WAI-ARIA patterns define
keyboard and state semantics for buttons and disclosures. WCAG 2.2 covers visible focus and target
size, and its mobile guidance applies to touch, small screens, zoom, and alternate input methods.

Sources:

- [W3C Forms Tutorial](https://www.w3.org/WAI/tutorials/forms/)
- [W3C form labels](https://www.w3.org/WAI/tutorials/forms/labels/)
- [W3C error identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification)
- [WAI-ARIA button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
- [WAI-ARIA disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
- [WCAG 2.2 focus visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible)
- [WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
- [W3C mobile accessibility](https://www.w3.org/WAI/standards-guidelines/mobile/)

Implication for the plan: “keyboard, screen reader, and mobile” is not enough as an acceptance
criterion. Every interactive view needs semantic controls, visible focus, labels, error placement,
focus after submit/step changes, adequate hit targets, preserved form values, and a keyboard-safe
expanded/modal variant. Complex forms should expand rather than become cramped chat bubbles.

## Repository findings

The current codebase already contains useful seams, but they should be composed carefully:

- [`ToolRegistry`](../../../agents/src/tools/registry.ts) is the execution authority. It validates
  schemas, grants, approvals, expiry, invocation, and handler access.
- [`generateCapabilitySurfaces`](../../../agents/src/capabilities/surfaces.ts) already projects
  registered tools into browser, REST, MCP, permission, audit, and documentation surfaces. This
  is the natural seam to extend with presentation metadata; it should not become a second executor.
- [`CapabilityManifestMetadata`](../../../agents/src/tools/types.ts) already describes execution,
  idempotency, approval, audit, redaction, and availability. It does not yet describe a particular
  result’s current actions or view data, which must be computed after authorization and execution.
- [`agentResponseSchema`](../../../agents/src/media/contracts.ts) currently keeps final responses
  strict around text, media, and authorization. Adding a UI field should preserve that strictness,
  not turn the final response into an unrestricted component tree.
- [`loop.ts`](../../../agents/src/runtime/loop.ts) and the run repository already model approval,
  human input, external events, cancellation, retry, SSE, and persisted outputs. A new workflow
  abstraction should prove it cannot reuse these paths before adding another state machine.
- [`kasiai.ts`](../../../agents/src/system/kasiai.ts) currently allowlists a bounded set of
  workspace, connection, report, insight, and content capabilities. Full agent creation and social
  OAuth are not automatically available merely because the client has direct functions for them.
  Capability coverage must be inventoried before those workflows are promised in chat.
- The client already renders text/Markdown, media, authorization actions, and approval-related
  surfaces. `DynamicUiRenderer` should be a host-level renderer for validated view models, not a
  place where product authorization or business rules are reimplemented.

## Critique of the current plan

| Area | Risk | Recommended correction |
| --- | --- | --- |
| `ui.blocks` in the agent response | The model can invent stale data, arbitrary layout, or actions that do not exist. It creates a second UI protocol. | Render a server-owned, schema-validated result projection. Let the model choose a presentation intent only from an allowlist. |
| Generic block catalog | Stats, tables, charts, forms, previews, approvals, progress, and workflows create a large API before one vertical slice is proven. | Start with text, summary/list, status/progress, one primary action, one secondary action, choice, and small form. Defer charts, generic previews, and workflow blocks. |
| Capability presentation metadata | Static metadata cannot know current resource state, user grants, provider readiness, freshness, or approval. | Keep static descriptors declarative; compute effective actions and data on the server per result. |
| One-to-five actions | Five buttons make an inline card look like a toolbar and create poor mobile hierarchy. | One primary plus one secondary; disclose or expand for the rest. |
| Central renderer | A renderer can become a shallow switch that knows every product rule. | Give it a deep boundary: `RenderableViewModel` in, interaction envelope out; domain capabilities own data and authorization. |
| Workflow registry | A generic workflow engine risks duplicating runs, approvals, retries, and external events. | Reuse existing run infrastructure first; add durable workflow state only for user-owned resumable work. |
| Same-origin now, iframe later | The plan treats iframe/artifact support as an easy future extension, although it changes CSP, origin, bridge, teardown, and threat-model assumptions. | Keep it explicitly out of the first slice and make it a separate architecture decision. |
| Accessibility | The current wording is a checklist, not a behavior contract. | Define semantics, focus, labels, errors, target sizes, keyboard behavior, and responsive form rules as testable requirements. |
| Fallback | A static text fallback cannot account for channel, locale, stale data, or failed actions. | Define capability-aware fallback states for unsupported, stale, unauthorized, loading, failed, and disconnected cases. |
| Scope and coverage | The plan jumps from rendering to agent creation, OAuth, content, reports, and onboarding without proving each capability path exists. | Build a capability inventory and one read-only plus one controlled-write vertical slice before broad workflows. |
| Success metrics | “Reduced navigation” can reward stuffing more UI into chat. | Measure useful-action latency, completion, abandonment, recovery, stale-action rate, fallback rate, render/action errors, and resume success. |

## Recommended changes to `KASIAI_DYNAMIC_UI_PLAN.md`

### 1. Replace the response contract with four explicit layers

Specify these separate objects and owners:

1. **Execution manifest:** capability name/version, schema, risk, scopes, approval, idempotency,
   audit, redaction, availability, and handler. Owned by the server registry.
2. **Presentation descriptor:** stable host-supported view kind, supported display modes, required
   data shape, possible action references, loading/error/fallback hints, and accessibility metadata.
   It is declarative and versioned; it does not grant access.
3. **Effective result projection:** the current authorized data snapshot, freshness/version,
   effective actions, approval state, continuation/run handle, and channel-safe fallback. Produced
   by the server after execution and authorization.
4. **Interaction envelope:** view instance ID, action reference, validated values, source/result
   version, and idempotency key. It is untrusted input and must be revalidated server-side.

Do not allow arbitrary model-authored `ui.blocks` to be authoritative. If the model selects a view,
make it a small enum or registered presentation ID and ignore unsupported selections safely.

### 2. Define a small presentation grammar and display modes

First-release view kinds should be limited to:

- summary/list or compact table;
- status/progress;
- choice;
- small form;
- confirmation/approval;
- action/result state.

Use three host modes: inline card, expanded workspace/sheet, and text/native fallback. Define the
promotion rule: more than one decision, more than one short form section, large data, rich media,
or long-running monitoring expands. Do not implement nested scrolling in an inline card.

### 3. Make progressive disclosure part of the interaction contract

Every view should have a clear hierarchy:

1. what changed or what requires attention;
2. the next decision;
3. one primary action;
4. one optional secondary action;
5. details behind disclosure or in the expanded view.

The text response should add context, not repeat every label and value already shown in the view.

### 4. Specify state and lifecycle before adding workflows

Document ownership for conversation/run state, business state, UI-instance state, and durable
workflow state. Define the view lifecycle as create → connect → render → update → suspend/teardown,
including stable view identity, unsaved-input persistence, reconnect behavior, host theme/locale/
timezone/container changes, and stopping polling or expensive work when hidden.

Use model-context updates only for semantic information needed by a future model turn, such as a
selected item or completed UI action. Do not stream every UI interaction into model context.

### 5. Reuse existing run and approval semantics

Map UI progress to existing run states where possible. For work that outlives a request, expose a
durable run/job handle and resumable statuses equivalent to `working`, `input_required`,
`completed`, `failed`, and `cancelled`. Define cooperative cancellation, retry, reconnect, and
stale-view behavior. Add a separate workflow record only when the product needs durable user-owned
configuration/drafts, not simply because a flow has multiple screens.

### 6. Turn accessibility and forms into acceptance criteria

Require visible and programmatic labels, groups, required/optional state, sensible input types and
autocomplete, inline error text plus a summary when needed, preserved values after errors, focus
movement after submit/step changes, visible focus, semantic buttons/disclosures, keyboard operation,
adequate touch targets, and zoom/reflow at mobile widths. Define the complex-form promotion rule:
inline for a few fields; expanded/modal for multi-section or high-risk input.

### 7. Define safe action and failure behavior

For every action, specify loading, disabled, success, validation error, authorization failure,
stale result, provider failure, timeout, cancellation, and reconnect states. Preserve user input on
recoverable errors. Require confirmation for irreversible actions. Treat refresh, pagination, and
filter changes as app/UI actions when they should not create model-context noise.

### 8. Inventory capability coverage before workflow promises

For each proposed workflow—agent creation, social connection, content, reports, and onboarding—list:

- the user goal;
- existing server capability and allowlist status;
- missing read/prepare/commit actions;
- authorization and approval boundary;
- durable state owner;
- first view and fallback;
- failure and resume behavior.

This prevents the UI plan from implying that a client-side function is already a safe model-callable
capability.

### 9. Change the implementation sequence

Use this narrower sequence:

1. **Contract and inventory:** finalize the four layers, state ownership, display modes, and one
   capability coverage matrix.
2. **Read-only vertical slice:** implement one report/insight result with inline summary, expanded
   detail, refresh/pagination, text fallback, and mobile/accessibility tests.
3. **Controlled-write slice:** implement one draft/approval flow using existing authorization,
   approval, idempotency, run, and error paths.
4. **One durable workflow:** choose either agent configuration or content creation, not both, and
   prove resume/reconnect/cancel behavior.
5. **Broaden registered views:** add capabilities based on measured interaction failures, not by
   expanding the generic block catalog in advance.
6. **Separate runtime decision:** evaluate iframe/artifact/MCP Apps interoperability only after the
   same-origin contract is stable and its security/lifecycle boundary is specified.

### 10. Add evidence-based release gates

Track completion rate, time to first useful action, abandonment by step, recovery after validation
or provider failure, stale/replayed action rate, render latency, action latency, fallback rate,
resume success, and accessibility violations. Release behind capability-level flags. Rollback must
be able to disable dynamic presentation while preserving text/media and existing approval flows.

## Bottom line

The plan should build a reliable presentation layer over the existing capability system, not a
general-purpose AI layout engine. The product can still feel highly dynamic: a user asks, KasiAi
executes a real capability, the host shows a focused preview, and the user expands only when the
task deserves a workspace. That gives KasiAi a path to agent creation, account connections, content,
reports, and onboarding without making every chat message a fragile mini-application.

## Release/documentation note

This is a research-only change. No application, package, deployment, or generated release files were
modified. Before implementation, the plan should record the repository release-process decisions
for documentation, analytics, structured logs, version/release identity, verification, rollout,
and rollback. The relevant release-process document is
[`release-process.md`](../../internal/operations/release-process.md).
