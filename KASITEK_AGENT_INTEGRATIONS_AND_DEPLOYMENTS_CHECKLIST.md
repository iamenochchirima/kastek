# KasiTek Agent Integrations and Deployments Checklist

**Status:** In progress — agent-level Integrations tab first slice implemented; provider bridges remain gated by the contract work below.
**Plan:** [`KASITEK_AGENT_INTEGRATIONS_AND_DEPLOYMENTS_PLAN.md`](KASITEK_AGENT_INTEGRATIONS_AND_DEPLOYMENTS_PLAN.md)
**Scope:** Direct KasiTek product, shared Agent Platform, linked provider profiles, agent deployments, and website delivery

Use this checklist as the execution record. Check an item only after the implementation and its
verification evidence exist. Do not mark a provider Ready because its card, adapter, or database
record exists alone.

## 1. Scope and guardrails

- [ ] Keep WhatsApp, Telegram, Discord, Slack, Messenger, Instagram, Website Chat, WordPress,
      Custom Button, Bot API, and MCP in scope.
- [ ] Keep Zapier, Make, Email, package publishing, and a native WordPress plugin out of scope.
- [ ] Keep this direct-product work in `client/apps/client`, `server/kasitek-core`, and `agents`.
- [ ] Preserve the separate `server/kasitek-tenants` and `client/apps/tenant-portal` boundaries.
- [ ] Remove payment or plan gates from the testing flow.
- [ ] Keep organization isolation, role checks, secret protection, audit, approvals, and provider
      restrictions.
- [ ] Do not add an Account IDs product area; linked account identity remains in Connections.
- [ ] Do not add MCP-versus-REST read/write checkboxes.
- [ ] Do not expose raw provider tokens, API-key hashes, installation secrets, or exchanged tokens.

## 2. Existing connection audit

### WhatsApp

- [x] Confirm `WhatsappConnection` is the current provider-specific source record.
- [x] Confirm `ExternalConnection` is already projected from `WhatsappConnection`.
- [x] Confirm existing WhatsApp inbox/webhook behavior must remain intact.
- [x] Confirm KasiAi already selects an existing WhatsApp connection for pairing.
- [x] Replace the first agent-level WhatsApp setup path with selection of an existing workspace connection.
- [x] Bind the selected WhatsApp connection to a hosted user-agent deployment through the existing pairing flow.
- [ ] Verify inbound messages reach the intended agent.
- [ ] Verify agent replies use the existing WhatsApp provider connection.
- [ ] Verify pause, disconnect, revoke, reconnect, and health states.

### Messenger / Facebook Page

- [x] Confirm Meta OAuth stores Facebook Pages as `SocialChannelConnection` with `platform = FACEBOOK`.
- [x] Confirm Page access tokens and external Page IDs are already stored server-side.
- [x] Confirm Meta Page webhook subscription and Facebook-message inbox processing exist.
- [x] Confirm outbound Meta message handling exists for Facebook conversations.
- [ ] Present this connection as Messenger in the agent-facing catalog while retaining `FACEBOOK`
      as the internal provider value.
- [ ] Allow an existing Facebook Page connection to be selected for an agent deployment.
- [ ] Ensure multiple Pages in one workspace cannot route ambiguously.
- [ ] Verify inbound, outbound, delivery, read, reaction, retry, and failure behavior through an agent.

### Instagram

- [x] Confirm Meta OAuth can discover connected Instagram professional accounts.
- [x] Confirm direct Instagram Login support exists where configured.
- [x] Confirm Instagram records are stored as `SocialChannelConnection` with `platform = INSTAGRAM`.
- [x] Confirm Instagram metadata retains the Page relationship where Meta routing requires it.
- [x] Confirm Instagram webhook subscription and message processing exist.
- [x] Confirm outbound Instagram message handling exists.
- [ ] Allow an existing Instagram connection to be selected for an agent deployment.
- [ ] Preserve the distinction between Meta-connected Instagram and direct Instagram Login in health
      and reconnect messages.
- [ ] Verify inbound, outbound, delivery, read, reaction, retry, and failure behavior through an agent.

## 3. Ownership and data contracts

- [ ] Document the Core-to-Agent connection-reference contract.
- [ ] Decide the stable reference format for a core-owned `ExternalConnection`.
- [ ] Ensure the reference includes organization scope and cannot be replaced by a client-supplied
      organization or installation ID.
- [ ] Keep provider secrets in Core/provider-owned storage; do not copy them into Agent Platform tables.
- [ ] Map `ExternalConnection` status to Agent Platform channel/deployment status.
- [ ] Map provider capability availability to agent runtime capability checks.
- [ ] Map provider webhook events to the correct agent binding.
- [ ] Map outbound agent effects back to the provider owner with idempotency and receipts.
- [ ] Define behavior when a connection is deleted, revoked, expired, or needs reauthorization.
- [ ] Define behavior when more than one agent is attached to a connection.
- [ ] Define default routing and explicit routing keys.
- [ ] Add redacted audit records for connection selection, deployment creation, pause, revoke,
      reconnect, test, and failed delivery.

## 4. Shared Agent Platform bridge

- [ ] Extend or adapt `channel_connections` so it can reference a core-owned connection safely.
- [ ] Keep `channel_bindings` as the routing authority for agent installations.
- [ ] Remove the requirement for users to paste provider credential references when a reusable
      workspace connection is available.
- [ ] Keep Telegram and Discord provider credentials in the approved Agent Platform vault path until
      their ownership is deliberately moved; do not mix this with Meta or WhatsApp tokens.
- [ ] Support hosted KasiTek agents and user-created hosted agents through the same bridge.
- [ ] Add list, create, update, pause, revoke, and test operations.
- [ ] Add authorization tests for workspace, role, installation, and connection ownership.
- [ ] Add tests preventing cross-organization connection references.
- [ ] Add tests for duplicate bindings and ambiguous routing.

## 5. Integrations and Deployments UI

- [x] Add an initial Integrations catalog in `client/apps/client`.
- [x] Add an **Integrations** tab under the agent detail page's **Deployment** section.
- [x] Keep **Integrations** focused on setup and assignment for the current agent.
- [ ] Keep **Channels & status** focused on active bindings, health, delivery, and operational actions.
- [ ] Keep global **Connections** as the source for provider-account management.
- [ ] Let the agent Integrations tab return to the current agent after a new provider connection is added.
- [ ] Add cards for all in-scope integrations.
- [ ] Show `Ready`, `Connected`, `Setup required`, `Needs attention`, `Beta`, and `Coming soon`
      states accurately.
- [ ] Use `Connect`, `Configure`, `Use with agent`, `Test`, and `Get embed code` actions.
- [ ] Do not show payment CTAs or locked-plan messages.
- [x] Show existing WhatsApp, Messenger/Facebook, and Instagram workspace connections in the agent Integrations tab.
- [ ] Allow an existing Messenger/Facebook or Instagram connection to be selected for an agent deployment.
- [ ] Offer provider authentication only when no suitable connection exists or the user chooses to
      add another one.
- [x] Show existing workspace connections without requesting the same provider credential again from
      the agent page; selection is currently live for WhatsApp and display-only for Meta providers
      until their agent routing bridge is implemented.
- [ ] Add agent selection to deployment setup.
- [ ] Add deployment list and deployment detail views.
- [ ] Show provider, agent, status, last health check, last error, and activity link.
- [ ] Add loading, empty, stale, degraded, retry, unauthorized, paused, revoked, and disconnected states.
- [ ] Remove generic credential-reference inputs from the normal user flow.
- [ ] Keep advanced diagnostics available without making them the primary UX.
- [x] Link Bot API and MCP setup to Developers instead of creating duplicate API-key controls here.

## 6. Website, WordPress, and Custom Button

- [ ] Define the public agent deployment record.
- [ ] Issue a public deployment identifier separate from all secret API keys.
- [ ] Add short-lived visitor sessions.
- [ ] Build the website chat widget transport and response streaming.
- [ ] Add origin allowlists.
- [ ] Add rate limits and abuse/spam controls.
- [ ] Ensure provider credentials never reach the browser.
- [ ] Add website deployment test mode.
- [ ] Add copyable embed script.
- [ ] Add WordPress installation instructions using the same embed script.
- [ ] Add Custom Button settings that open or launch the website chat deployment.
- [ ] Verify the widget on a plain HTML page and a WordPress site.
- [ ] Verify revoked or paused deployments stop accepting new visitor sessions.

## 7. Telegram

- [ ] Define Telegram connection creation and secure credential storage.
- [ ] Support BotFather token setup without exposing the token after creation.
- [ ] Register and verify the webhook.
- [ ] Normalize inbound Telegram messages into the Agent Platform message contract.
- [ ] Route inbound messages to the selected agent binding.
- [ ] Send agent replies through the Telegram Bot API.
- [ ] Handle media, unsupported events, duplicates, retries, and provider errors.
- [ ] Add connection health and webhook status.
- [ ] Add disconnect, revoke, and reconnect behavior.
- [ ] Add local and end-to-end tests.
- [ ] Mark Ready only after a real round-trip test succeeds.

## 8. Discord

- [ ] Define Discord application/bot connection creation and secure credential storage.
- [ ] Verify Discord event signatures or gateway authentication as applicable.
- [ ] Normalize inbound messages, mentions, replies, and supported attachments.
- [ ] Route messages to the selected agent binding.
- [ ] Send agent replies to the correct channel or thread.
- [ ] Handle duplicate events, unsupported events, rate limits, retries, and provider errors.
- [ ] Add connection health and event-delivery status.
- [ ] Add disconnect, revoke, and reconnect behavior.
- [ ] Add local and end-to-end tests.
- [ ] Mark Ready only after a real round-trip test succeeds.

## 9. Slack

- [ ] Decide Slack OAuth versus bot-token setup for the first release.
- [ ] Define workspace and channel identity mapping.
- [ ] Store credentials using the approved connection model.
- [ ] Verify inbound events and replay protection.
- [ ] Route inbound events to agent bindings.
- [ ] Send replies and handle threads.
- [ ] Add health, retry, revoke, and reconnect behavior.
- [ ] Add local and end-to-end tests before marking Ready.

## 10. Bot API and MCP

- [ ] Link Bot API setup to the existing Developers API-key lifecycle.
- [ ] Keep API keys workspace-owned and shown only once.
- [ ] Apply capability and resource policy rather than transport read/write labels.
- [ ] Add a clear link from a deployment to its API setup instructions.
- [ ] Keep MCP on the shared Developer API-key contract.
- [ ] Link MCP activity and effective capabilities to the relevant agent installation.
- [ ] Keep package publication deferred.
- [ ] Test key creation, discovery, use, rotation, revoke, and post-revocation rejection.

## 11. Provider-neutral runtime contract

- [ ] Define `connect` or `reuse existing connection`.
- [ ] Define `verify webhook/event`.
- [ ] Define `normalize inbound message`.
- [ ] Define `resolve agent binding`.
- [ ] Define `invoke agent`.
- [ ] Define `send outbound effect`.
- [ ] Define `record provider receipt`.
- [ ] Define `retry` and `reconciliation` behavior.
- [ ] Define `health check`.
- [ ] Define `pause`, `revoke`, `disconnect`, and `reconnect`.
- [ ] Ensure each provider adapter uses the same lifecycle and status vocabulary.

## 12. Verification and observability

- [ ] Add unit tests for provider normalization and verification.
- [ ] Add integration tests for connection reuse and deployment creation.
- [ ] Add end-to-end tests for website, WhatsApp, Telegram, Discord, Messenger, and Instagram.
- [ ] Test multiple connections of the same provider in one workspace.
- [ ] Test revoked, expired, unhealthy, and missing credentials.
- [ ] Test provider 4xx and 5xx responses and confirm they are visible as warnings/errors, not generic info.
- [ ] Record request status, provider, deployment, agent, and correlation identifiers safely.
- [ ] Avoid logging secrets, message bodies by default, or raw provider payloads unless an explicit
      redacted diagnostic mode is enabled.
- [ ] Verify the UI distinguishes successful, redirected, client-error, and server-error states.
- [ ] Verify local startup and migrations from a clean database.

## 13. Release gates

- [ ] Every Ready card has a working setup, round-trip test, health state, and revoke path.
- [ ] Every Coming soon card is prevented from creating a misleading deployment.
- [ ] Existing Connections, Inbox, social publishing, WhatsApp campaigns, and KasiAi behavior remain intact.
- [ ] No duplicate WhatsApp, Facebook Page, or Instagram credentials are created by agent setup.
- [ ] No cross-organization connection or deployment access is possible.
- [ ] No payment guard blocks the testing flow.
- [ ] Root plan and checklist are updated with evidence links or commands for completed work.
- [ ] Remaining unsupported providers and known limitations are shown plainly in the UI and docs.

## Stop conditions

Pause implementation and update the plan if any of these become necessary:

- merging direct and white-label databases or identity systems;
- moving provider secrets into the Agent Platform without an approved ownership decision;
- introducing a second API-key or MCP credential model;
- adding Zapier, Make, Email, package publishing, or a native WordPress plugin;
- bypassing approval, organization isolation, provider policy, audit, idempotency, or reconciliation;
- presenting an adapter or placeholder UI as a production-ready integration.
