# 0003: Direct authorized content actions

Date: 2026-11-02. Status: accepted. Owner: Enoch Chirima.

## Context

ADR 0002 made content execution depend on a separate Growth-recorded human approval. Client
form support proved unreliable, and the embedded card remained unverified in the native host.
The owner explicitly removed this requirement. MCP clients already control tool confirmation;
Growth remains responsible for delegated permissions and reliable business execution.

## Decision

Content writes execute as ordinary authorized operations across MCP, REST and the internal
interface. Current membership, scope, entitlement, account permissions and domain validation remain
mandatory. Durable request receipts, single-use claims and unknown-outcome reconciliation remain.
Private draft/media writes use `requested_draft`; public/destructive writes use `requested_action`.
These record delegated requests, not human approval. Non-content review policy is unchanged.

`content.actions.preview` stays optional and returns exact model-readable content, destinations,
ordered media, timing and validation. It never executes a provider action. Supplying a preview
binds execution to its unchanged action/input/revisions, workspace, principal and expiry. Without
a preview the operation validates its current snapshot. Preparation/status controls cannot admit
an effect. Mandatory MCP forms, embedded approval UI and app-only confirmation tools are removed.

The current internal publication uses an explicit product-only `authorized_write` policy; content
writes are never mislabeled as reads or private drafts. Retained publications keep their immutable
authority descriptors. Historical approval provenance remains available for audit.

## Consequences and verification

Client confirmation follows the client's settings; a server tool call does not prove a human
reviewed the content. Integrators must grant publication/manage scopes only to trusted agents.
Tests cover ordinary direct execution, optional frozen previews, scopes/revocation, snapshot drift,
request replay and uncertain outcomes. Provider format and delivery restrictions remain separate.
Production acceptance checks ordinary MCP execution rather than native card rendering.
