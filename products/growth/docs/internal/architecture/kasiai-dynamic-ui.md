---
id: kasiai-dynamic-ui
title: KasiAi dynamic UI
sidebar_position: 11
owner: agent-platform
last_reviewed: 2026-09-01
---

# KasiAi dynamic UI

KasiAi can attach a small, structured UI view to a normal agent response. The view is optional.
Text, media, authorization, approval, and channel delivery continue to work when a client does not
support the view.

## Ownership

The capability registry remains the execution source of truth. A capability may declare a reviewed
presentation projection. After the runtime receives an authorized and schema-validated tool result,
the server-side projection turns safe fields into a bounded `AgentResponse.ui` value.

The model does not submit the UI tree, backend tool name, permission decision, or executable code.
The response tool still accepts the text and media contract only. The runtime adds a UI view when a
registered capability has a projection for the result.

The dashboard and embedded Website Chat renderers own layout, theme tokens, responsive behavior,
focus, empty states, and safe navigation links. They do not authorize or execute platform
capabilities. Website Chat receives the same optional view through its existing message-content
delivery envelope; external channels continue to receive text/media fallbacks.

## Block contract

The version 1 view model supports six block types:

- `summary` for bounded key/value facts;
- `list` for bounded read-only rows and reviewed navigation actions; and
- `progress` for read-only named status steps.
- `workspace` for a link into an existing expanded product surface;
- `choice` for a bounded set of server-defined options; and
- `form` for a bounded set of typed fields and a reviewed submit action.

The response protocol is versioned independently from capability and agent versions. Payload size,
block count, row count, text length, and action count are bounded by the server schema. Unknown or
unsupported views must leave the text response visible.

The first projections cover `connections_list` and `content_posts_list`. They expose display names,
provider labels, handles, status, and safe descriptions. They do not expose provider IDs,
credentials, raw scopes, provider payloads, or transport URLs.

## Interaction boundary

Navigation remains a local link. Other controls are sent to
`POST /v1/installations/:installationId/platform/ui-interactions`. The
`AgentUiInteractionCoordinator` resolves the submitted message, block, and action against the
stored outbound response; it never trusts a client-supplied tool name or prompt. It validates
choice/form values, checks conversation and installation ownership, rechecks current installation
policy through the existing platform-message admission path, and starts the existing Temporal run.
Waiting `resume` actions signal the existing external-event boundary after checking that the stored
run is still waiting. Resume idempotency uses `agent_ui_interaction_receipts`; platform follow-ups
reuse the existing run/message idempotency records.

The authenticated dashboard is the stateful interaction surface. Website Chat is an anonymous
visitor surface, so its navigation links open the approved app route and its choice/form controls
serialize a concise user intent into the existing website message ingestion path. Owner-only
resource mutations still require the authenticated platform coordinator and existing approval
checks.

Multi-step work should use the existing run, workflow, checkpoint, approval, and external-event
state. The UI view is a snapshot, not the source of truth for a draft, connection, report, or agent.

## Product workspaces

[`product-workflows.ts`](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/api/src/workflows/product-workflows.ts)
is a presentation catalog for the existing product
surfaces. It registers the entry route and capability scope for agent creation, social connections,
content operations, and workspace reporting. It does not execute workflow nodes or persist state.
Workspace cards open the existing agent editor, OAuth/connection pages, content workspace, or report
route. The current dynamic UI layer therefore adds a conversational entry point without replacing
those domain-owned editors.

## Channel negotiation and fallback

The delivery boundary selects a `ChannelUiProfile`:

- dashboard and Website Chat receive the validated rich view;
- Telegram and Discord receive text plus reviewed app-local link components;
- WhatsApp receives a numbered, link-safe text representation; and
- text-only channels receive the same bounded text representation without native controls.

The fallback includes display data only. It does not serialize stored follow-up prompts, backend tool
names, credentials, provider IDs, or arbitrary URLs. Dynamic UI is protected by the
`dynamic_ui_enabled` operator flag; disabling the flag removes new projections and rejects new UI
interactions while leaving ordinary text delivery available.
