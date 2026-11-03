# Growth model selection

Owner: Agents engineering. Reviewed: 2026-11-03.

Growth managers can choose a saved model for one Growth agent from its chat composer. The choice
publishes a new agent configuration, applies to new messages and refreshes the coordinator's pinned
specialist version when a specialist changes. Already admitted work retains its accepted route.
Returning to Default stores the inherited selection and resolves the current product default.

`GET /api/agents/features/:featureId/models` returns the current feature revision, inherited state,
saved selection, resolved default model and permitted models, including their advertised context window, maximum output,
and input/output USD prices per million tokens. Unavailable catalogue values remain unavailable;
the display does not substitute the current task input allowance for the model window or infer
a zero price from missing data. Prices come from saved provider metadata, not a billing guarantee. `PATCH /api/agents/features/:featureId/model` accepts
`requestId`, `expectedRevision`, and `selection` (`organization_default`, or `connection` with exact
`connectionId` and `modelId`). Stable request identity protects retries; stale revisions reject the
change. Both routes require current Growth manager authority and the normal feature entitlement.
Growth signs the `models.list` and `models.select` commands through its existing product channel.
The browser never receives provider credentials or arbitrary agent configuration write authority.

The list reads the saved model catalogue, not a live provider search or inference probe. Models must
fit the agent's context/generation configuration and declared tool requirements. The active product
default use grant supplies a model-ID ceiling; existing exact agent grants also remain selectable.
A cached provider model alone does not grant access. Selection commissions an exact agent grant
within this current ceiling, retaining earlier grants so an in-flight accepted request is not revoked
by a picker change. An administrator removing a model's execution permission must revoke its
agent-specific grant as well as any product-default grant. Credential and connection revocation
continue to fence all routes immediately.

Missing, stale or unpermitted saved selections stay visible as unavailable; the picker never changes
the model automatically. The installation operator must explicitly authorize additional model IDs
before they appear. This change does not install a free-model filter, paid fallback, provider discovery,
or an API-key editor. A metadata-ready choice does not guarantee provider availability or answer quality.

Release: additive signed command and Growth HTTP routes; no schema change. Publish the shared
contracts, Agents API, Growth API and Growth web together. Existing authorization, configuration
version and command receipt mechanisms are reused. New analytics events, log/metric pipelines,
platform release tags and hosted deployment are not applicable to this local change. Existing command
analytics does not emit an unregistered event for these operations. Rollback restores the prior
composer/routes after draining, without rewriting accepted work or selected model receipts.

The shared picker shows the model name, a compact context value such as `262K` or `1.1M` above input/output prices, and `Free` when both prices are zero. Maximum output stays in the catalogue contract but is not displayed. The inherited option shows its resolved model name with `Default`.
