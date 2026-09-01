# KasiAi dynamic UI plan

**Status:** Phases 0–3 implementation complete; rollout is gated by visual approval and operational release ownership

**Owner:** Agent Platform

**Last updated:** 2026-09-01

## Objective

Make KasiAi a conversational control surface for KasiTek. Users should be able to ask for
platform work, see trusted results in compact cards, open a larger workspace for multi-step work,
fill focused forms, and approve side effects without losing the existing product navigation.

The first release must improve the experience without creating a second execution system. The
existing capability registry, authorization, approval, run, workflow, and message infrastructure
remain authoritative.

## Design correction from research

The original plan was too broad. It proposed a new workflow registry and generic UI block language
before proving the smaller seam. The repository already has versioned workflow graphs, durable run
state, checkpoints, approval records, external-event resume, and generated capability surfaces.

The corrected direction is:

1. Extend the existing capability registry with presentation metadata.
2. Let trusted server-side projections turn authorized tool results into bounded view models.
3. Keep the model responsible for explanation and intent, not arbitrary layout, data, or action
   wiring.
4. Use one host renderer for compact views. Expand into a real workspace when a task needs more
   than one decision or a narrow form.
5. Route future interactions back into the current run, approval, and workflow state instead of
   starting an unrelated chat message for every click.

## Scope

### Current implementation slice

- Add a validated, versioned dynamic UI response section to the existing agent response envelope.
- Add presentation metadata to the current capability manifest and generated surfaces.
- Add server-owned projections for the first read-only capability results, starting with workspace
  connections and content posts.
- Persist and deliver the optional UI section through the existing message and run records.
- Add host-owned renderers for compact summaries, lists, and progress views in the dashboard chat
  and embedded Website Chat widget.
- Add choice and bounded form renderers in the dashboard and Website Chat widget.
- Add expanded workspace cards that hand off to the existing agent editor, connections, content, and
  reporting routes.
- Carry the optional view through the existing website delivery envelope so the embedded widget
  does not fall back to text-only when a rich view is available.
- Negotiate external-channel presentation at delivery time with native links, numbered prompts, or
  bounded text fallbacks.
- Reuse tenant and widget customization through shared theme tokens and existing layout rules.
- Add an interaction coordinator that resolves stored actions and routes follow-up, refresh, choice,
  form, and waiting-run resume through existing admission and Temporal boundaries.
- Add durable UI interaction receipts for resume idempotency and a feature flag for rollout/rollback.
- Add contract and projection tests, then run agent, client, and core checks.

### Completed later slices

- Structured interaction routing for navigation, follow-up, refresh, forms, and choices.
- Resumable interaction state backed by existing run/workflow records and external-event signals.
- Expanded/resizable workspace handoffs for reports, agent creation, social authorization, and
  content operations.
- Registered product workflow definitions that reuse existing product routes and capability scopes.
- Rich fallbacks for external channels.

### Excluded from this slice

- Arbitrary model-generated HTML, CSS, JavaScript, React, or iframes.
- Client-submitted backend tool names or unsupervised side-effect actions.
- A new generic workflow registry or new workflow persistence tables.
- Replacing product pages or forcing every task into chat.
- Making external channels depend on the web renderer; they continue to use text/media fallbacks.

## Existing seams and ownership

- `ToolRegistry` validates inputs and outputs, grants, approvals, expiry, invocation, and handler
  access. It remains the execution seam.
- `generateCapabilitySurfaces` projects manifests into MCP, permission, audit, and documentation
  surfaces. Presentation metadata belongs on this existing projection.
- `agentResponseSchema` is the durable response seam. The UI field is optional and must preserve
  text/media-only messages.
- The run repository already persists the complete response JSON in message content and run output.
  No migration is expected for phase 0, pending compatibility checks.
- Existing workflow state, checkpoints, approval records, external events, and SSE streams own
  long-running execution. The dynamic UI layer must not duplicate them.
- `KasiAiChat` already renders Markdown, media, authorization remediation, approvals, and activity.
  The dashboard renderer is a small host-owned module called from that existing message path.
- `WEBSITE_CHAT_FRAME` is the existing embedded widget surface. It receives delivery content through
  the existing polling endpoint, so the UI view can be carried as optional message content without
  changing the widget's session or transport model.

## Architecture

```text
Capability registry
 ├── execution metadata and handler
 └── presentation metadata
      └── server-owned result projection
           └── versioned AgentResponse.ui view model
                └── host renderer and channel fallback
```

Presentation metadata describes a reviewed projection and preferred display mode. It does not
contain executable code. A projection receives the already authorized, schema-validated, redacted
tool result and emits only bounded display data and stable, reviewed navigation/follow-up actions.

The model may write normal response text and call the existing final-response capability for media.
It does not author the UI tree. The runtime attaches a projection selected by the registered
capability after the tool result is available.

## Phase 0 contract

The response extension is optional and backward compatible:

```ts
{
  version: "1",
  text: "Here are the connected accounts.",
  media: [],
  ui: {
    version: "1",
    mode: "inline",
    blocks: [{
      type: "list",
      id: "connected-accounts",
      title: "Connected accounts",
      items: [{
        title: "Instagram",
        description: "@kasitek",
        status: "success"
      }],
      actions: [{
        id: "open-connections",
        label: "Open connections",
        kind: "navigate",
        href: "/connections"
      }]
    }]
  }
}
```

The initial block set stays deliberately bounded:

- `summary` for bounded key/value facts;
- `list` for bounded read-only rows with status and reviewed actions; and
- `progress` for named read-only status steps;
- `workspace` for a reviewed handoff to an existing product workspace;
- `form` for bounded typed input; and
- `choice` for a bounded set of reviewed options.

Every block has a stable ID and protocol version. Payload size, block count, row count, text
lengths, and action count are bounded. Unknown blocks are ignored while the text remains visible.
The response tool input does not accept `ui`; only server-owned projections can attach it.

## State ownership

- Business state belongs to KasiTek domain services, such as a draft, connection, report, or agent.
- Run state belongs to the existing run/workflow/checkpoint records.
- Conversation state belongs to messages and conversation records.
- View state belongs to the browser, such as expanded sections, selected rows, and filters.

A message may display a snapshot, but it is not the source of truth for a mutable platform object.
Later interactions must carry a stable resource reference and re-read current authorization,
ownership, freshness, approval, and capability availability on the server.

## Renderer rules

The web renderers own layout, theme tokens, responsive behavior, accessible semantics, loading,
empty, stale, success, error, and unknown-block states. They must not reimplement authorization or
business rules. The embedded widget only executes reviewed navigation links and follow-up prompts;
it does not select or invoke backend capabilities.

Inline views should normally have one primary action and at most one secondary action. Complex work
must open an actual expanded workspace or existing product editor. The widget's expand affordance
must change the available layout, not merely make a narrow card taller.

Forms and disclosures use semantic controls, visible focus, labels, keyboard operation, inline
errors, preserved values, and deliberate mobile hit targets. The dashboard submits typed values to
the coordinator; the anonymous widget serializes visitor intent through its existing message path.

## Interaction and workflow direction

The interaction coordinator accepts a message/block/action envelope and resolves the action from the
stored response plus registry metadata. It rechecks organization, installation, actor, resource
ownership, current capability policy, freshness, approval, expiry, and idempotency before dispatch.

The browser will never select an arbitrary tool by name.

Agent creation, social account connection, content scheduling/publishing, and report exploration are
registered product workflows. The UI hands off to the existing `AgentSpec` editor, OAuth/connection
flow, content workspace, and report routes; those domain surfaces continue to own drafts, provider
state, filters, approvals, and persistence.

## Channel behavior

The platform web client and embedded Website Chat widget are the first rich renderers. The widget
receives the optional view through its existing delivery content envelope. External channels
continue to receive text, native buttons/links where supported, or concise numbered choices. They
must remain useful when the UI section is absent or unsupported.

## Security and reliability

- Validate the UI response server-side and treat all displayed text as untrusted content.
- Do not allow arbitrary HTML, links outside approved origins, executable code, secrets, tokens, raw
  provider scopes, or long-lived signed URLs in the view model.
- Derive UI data from trusted, authorized, redacted tool output or an authorized resource
  projection.
- Keep approval and authorization checks server-side and authoritative.
- Make future interactions idempotent and reject stale or replayed actions.
- Preserve text/media fallback for malformed or unsupported UI.
- Emit bounded structured lifecycle events for render, fallback, interaction, and workflow outcomes
  when those paths are enabled.

## Implementation checklist

### Phase 0, foundation

- [x] Confirm the existing registry, run, workflow, response, and client seams.
- [x] Critique the first plan against the repository and primary-source research.
- [x] Define and validate the small UI response contract.
- [x] Add presentation metadata to capability manifests and generated surfaces.
- [x] Add server-owned projections for connections and content posts.
- [x] Attach projections to completed responses without changing response-tool input.
- [x] Render summary/list/progress blocks in the existing KasiAi chat and Website Chat widget.
- [x] Add tests for schema bounds, projection redaction, backward compatibility, and delivery/rendering seams.
- [x] Update internal technical documentation and generated capability documentation.

### Phase 1, interaction coordinator

- [x] Keep navigation local and use a dedicated coordinator route for stateful interactions.
- [x] Support navigation, safe follow-up, refresh, choice, and bounded form submission.
- [x] Resume waiting runs through existing external-event signals where a run is waiting.
- [x] Revalidate conversation/install ownership, current platform policy, action expiry, and
      idempotency.
- [x] Add bounded interaction telemetry; operational dashboards consume the existing telemetry
      export. A dedicated dashboard panel is not applicable to this release.

### Phase 2, expanded product workspaces

- [x] Add real expanded/resizable workspace presentation for multi-step tasks. Website Chat changes
      its iframe layout; dashboard KasiAi already uses the resizable full-height panel.
- [x] Reuse the existing `AgentSpec` and agent workflow editor for agent creation.
- [x] Reuse OAuth and connection pages for social account setup.
- [x] Reuse existing content preview, draft, schedule, publish, and approval workflow views.
- [x] Reuse existing report filters and bounded data views with their mobile treatment.

### Phase 3, channel and runtime coverage

- [x] Define text/native-control fallbacks per external channel.
- [x] Add delivery-time capability negotiation and feature-flagged rollout by organization/install.
- [x] Keep sandboxed iframe/artifact execution outside this change as a separate security project.

## Verification

- [x] Unit-test response and manifest schemas, bounds, duplicate IDs, unknown block handling, and
      projection output.
- [x] Test that old text/media responses parse and render unchanged.
- [x] Test that projection data contains no credentials, provider IDs, raw scopes, or transport
      URLs.
- [x] Test renderer keyboard semantics in host controls and safe navigation handling in both web
      renderers.
- [x] Test external-channel delivery retains the text fallback while Website Chat carries the
      optional view, including native link components where supported.
- [x] Run the agent contract/runtime tests and full agent test suite after the final Phase 3 patch.
- [x] Run the agent build and client lint/type/build checks after the final Phase 3 patch.
- [x] Run the relevant `kasitek-core` Website Chat tests for the delivery envelope and frame bundle
      after the final widget controls patch.
- [ ] Use browser screenshots for the compact widget and expanded panel before enabling a rollout;
      blocked in this environment because no browser connection is available.

## Release record

**Change:** Add an optional server-owned dynamic UI projection to KasiAi responses, route reviewed
interactions through existing runs, hand off expanded product workspaces, and negotiate channel-safe
fallbacks.

**Owner:** Agent Platform, with Product/UX review for the renderer.

**Risk:** Standard for read-only views. Elevated for stateful UI interactions because they admit new
runs and resume waiting workflows; existing authorization, approval, ownership, and idempotency
boundaries remain authoritative.

**Affected services and user surfaces:** Agent runtime, capability registry, run/message persistence,
KasiAi web client, website widget, and generated capability documentation.

**Platform release version or release ID:** To be assigned at release. Keep separate from the `ui`
protocol version and capability versions.

**API/schema/migration changes:** Optional `AgentResponse.ui`, capability presentation metadata,
`POST /v1/installations/:installationId/platform/ui-interactions`, and migration
`106_dynamic_ui_interaction_receipts.sql`. Existing JSON response content remains backward compatible.

**Feature flag and rollout:** `dynamic_ui_enabled` is disabled by default until the release owner
enables it for an organization or installation. Roll out to internal installations first, then a
small tenant cohort while watching UI interaction rejection, duplicate, fallback, and dispatch
failure telemetry.

**Analytics and logging:** `kasitek.ui.interaction.count` records bounded outcomes and action kinds;
the existing `agent.ui.interaction` span records block/action correlation. No new user-level payload
is logged. A dedicated dashboard is not applicable; alerts should use the existing telemetry sink.

**Rollback:** Disable `dynamic_ui_enabled` at global, organization, or installation scope. New
responses revert to text/media, and new UI interaction requests are rejected. Existing runs and
waiting workflows remain managed by their normal run controls.

**Documentation:** Updated `docs/internal/architecture/kasiai-dynamic-ui.md` and generated capability
documentation. No public API documentation change is required until the interaction endpoint is
externally exposed.

**Validation evidence:** The final verification pass completed successfully: the Agents TypeScript
build passed; the full Agents suite passed with 651 tests and 84 skipped across 109 files; the
client KasiAi type check and targeted ESLint checks passed; the client production build generated
all 53 pages; the relevant `kasitek-core` Website Chat tests passed (9/9); the widget controller
file passed `rustfmt --check`; and `git diff --check` passed. Browser screenshots remain pending
because this environment has no connected browser, so rollout visual approval is still an
operational follow-up rather than a completed verification claim.

**Post-release review date:** Assign with the rollout owner.

## Open decisions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Registry ownership | Extend the existing registry; do not create a UI registry | Agent Platform | Decided |
| Projection ownership | Server-owned projection from trusted tool results | Agent Platform | Decided |
| Initial block set | Summary, list, progress, workspace, form, choice | Agent Platform/UX | Decided |
| Initial runtime | Same-origin host renderer | Agent Platform | Decided |
| Side effects | Reuse existing authorization, approval, idempotency, and audit paths | Agent Platform | Decided |
| Interaction transport | Dedicated coordinator route with stored-view resolution and existing run admission | Agent Platform | Decided |
| Expanded surface | Reuse existing agent, connection, content, and reporting routes; expand Website Chat's iframe shell | Product/Frontend | Decided |
| Feature control | Existing `dynamic_ui_enabled` flag at global, organization, and installation scope | Platform Ops | Decided; rollout owner assignment pending |
| Analytics events | `kasitek.ui.interaction.count` plus `agent.ui.interaction` span | Data/Platform | Decided |

## Notes

This document now describes active implementation. Commit, push, and deployment remain separate
release actions and will happen only after the phase 0 verification and release gates pass.
