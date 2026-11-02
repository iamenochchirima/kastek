---
status: accepted
date: 2026-11-01
---

# Growth owns delegated access and business operations

Growth uses its existing Keycloak sign-in and a Growth-owned OAuth authorization layer for
workspace-specific agent connections, consent, resource-bound credentials and independent
revocation. Identity tokens alone do not represent those delegated business grants; placing
them entirely in Keycloak would couple Growth workspace consent and client lifecycle to realm
configuration, while restoring the removed Agents gateway would put business authority in a
different product. The additional OAuth persistence and token lifecycle are therefore owned
and operated by Growth, without a second password or account system.

One versioned Growth operation catalogue supplies REST, external MCP and internal agent
interfaces. Internal execution calls Growth directly or through the existing signed product
boundary, preserving the same business contracts and reviews while avoiding the public MCP
transport. Shared Agents retains execution/task ownership; Growth retains membership, provider
credentials, approvals, effects and receipts. This adds adapter/version coordination, but avoids
separate tool registries and permission behavior that would drift between internal and external
agents.

The owner approved the [implementation specification](https://linear.app/kasitek/document/growth-oauth-mcp-rest-api-and-internal-tool-parity-implementation-plan-1ec06898320c)
before implementation. Changing the public issuer/resource or the persisted grant boundary
requires an explicit credential and client transition. Current contracts and coverage are in
[Growth operation coverage](../internal/architecture/growth-operations.md).
