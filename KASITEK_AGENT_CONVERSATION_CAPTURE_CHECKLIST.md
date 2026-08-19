# Agent Conversation Capture Checklist

This is the focused follow-up for installation-local agent transcripts. It deliberately does not
move records into `kasitek-core /inbox`; a later integration may add a reference between the two
systems.

## Ownership and routing

- [x] Keep `system_hosted` KasiAi chats private to the workspace actor.
- [x] Keep `kasitek_hosted` test messages separate from customer conversations.
- [x] Resolve hosted channel traffic by installation, channel connection, external identity, and
  external thread ID.
- [x] Prevent different agents, customers, or channel threads from sharing a transcript.
- [x] Preserve provider-message idempotency and durable inbound/outbound run links.

## Durable history and projections

- [x] Add explicit conversation kinds: `personal`, `customer`, `test`, and `external`.
- [x] Persist participant type and external identity for customer conversations.
- [x] Persist last-message timestamp, direction, preview, message count, assignment field, and
  unread projection fields.
- [x] Update projections for platform inbound messages, channel inbound messages, agent replies,
  and direct message appends.
- [x] Add installation-scoped customer conversation listing and conversation detail reads.
- [x] Keep customer history separate from `/inbox` in API and UI copy.

## External-connected agents

- [x] Do not create conversations for MCP/REST capability calls by default.
- [x] Persist every call as a durable installation run, including immediate reads.
- [x] Record transport (`mcp` or `rest`) in the durable operation input.
- [x] Expose installation-scoped operation history and usage counters for tools, model calls,
  status, approvals, and estimated cost.
- [x] Keep external operations out of customer chat history.

## Verification completed

- [x] Agent typecheck and build pass.
- [x] Agent unit/HTTP/conformance suite passes: 292 passed, 41 expected integration skips.
- [x] Local PostgreSQL platform-chat integration passes: 9/9, including separate customer threads
  and conversation projections.
- [x] Local PostgreSQL channel, memory, hosted-boundary, durable-run, and REST/MCP parity suites
  pass, including external operation transport and usage assertions.
- [x] Client typecheck and targeted lint pass.
- [x] Migrations `055` and corrective `056` apply to the local Agent database.

## Intentionally later

- [ ] Add staff assignment, handoff queues, and per-staff read state.
- [ ] Add optional cross-reference or unified view with `/inbox`.
- [ ] Run browser and configured provider end-to-end scenarios for each supported channel.
- [ ] Add retention/export policy verification for installation-local transcripts.
