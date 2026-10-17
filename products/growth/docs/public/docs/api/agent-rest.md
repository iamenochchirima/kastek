# Agent access to Growth REST

An external agent or script can call the supported Growth REST API with a workspace Developer
API key. Send `Authorization: Bearer <developer-api-key>`. Current workspace permissions, key
scopes, expiry, revocation, and operation-specific checks still apply.

See [Public API v1](./public-v1.md) for the current REST contract and
[Agent connection guide](./agent-connection-guide.md) for the integration boundary.

The former installation-token exchange, private Agent Platform routes, and installation-based
agent-management instructions have been removed with the old backend. They are not a supported
setup path for the new Agents product. Product OAuth MCP is unavailable.

The standalone Agents FAQ journey and local setup are documented in `products/agents/README.md`
in the repository. Growth's shared-execution integration is not implemented yet.
