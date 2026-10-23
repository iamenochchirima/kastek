# Agent connection guide

External clients can use Growth's supported REST operations with a workspace Developer API key.
Create or rotate the key in **Developers → API keys**, then send it as a Bearer credential.
See [Public API v1](./public-v1.md) for the supported operations and access checks.

Product OAuth MCP is unavailable. The former Agents MCP gateway and local bridge have been removed.
There is no replacement MCP endpoint or package to configure.

The standalone Agents product has its own workspace, configuration, test, and website-publication
journey. Its current setup is documented in `products/agents/README.md` in the repository.
Growth's embedded agents use its authenticated backend and the shared product execution API.

Embedded Growth features will use Growth authorization without requiring an Agents-product
account or subscription. The target architecture is recorded in
`products/agents/docs/architecture/agent-platform-architecture.md` in the repository.
