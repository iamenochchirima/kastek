# ADR 0004: Trusted product backends use signed service admission

## Decision

Growth and Agency keep signed backend authentication for embedded agent work. They do not
receive per-tenant `/v1` application credentials. Agents exposes one generic product gateway
that accepts a signed service command and carries shared agent and run operations. External
applications continue to use `/v1` application credentials and MCP OAuth.

Product backends authenticate with an RSA service key, a short-lived signed command and a
product-scoped execution grant. The gateway verifies the issuer, audience, request digest,
client identity and actor issuer before admitting work. The initiating user or tenant remains
in the grant and in the run's principal history.

## Context

Growth and Agency serve many tenants from one backend. An application credential belongs to
one Agents organization, so a credential-per-tenant model would add tenant application
provisioning, secret storage, rotation and revocation to both products. Their existing signed
commands already carry the tenant, actor, operation and request digest, and the architecture
target keeps product-scoped grants for embedded work.

The previous Growth path also carried Growth-specific operation names and DTOs into Agents.
That created a second orchestration vocabulary and a large translation layer. The problem is
the vocabulary, not the service authentication.

## Alternatives considered

- **Application credential per tenant.** Matches external `/v1` access, but requires a new
  credential lifecycle in Growth and Agency, and still leaves product-only operations on a
  separate path.
- **OAuth token exchange.** Could provide destination-scoped credentials, but provider support
  and policy are unverified, and it does not define tenant policy or grants by itself.
- **Keep Growth-specific commands.** Works today, but preserves duplicate orchestration and
  blocks product-independent deletion.

## Consequences

- Product backends keep their current trust roots and signing keys.
- Agents owns one product gateway and one shared operation vocabulary.
- Product composition (feature-to-agent mapping, model policy, memory, resources) stays in the
  product that owns it.
- The gateway must enforce the same authority, idempotency and denial rules as `/v1` and MCP.
- External callers are unaffected; they continue to use application credentials.

## Status

Accepted for the platform upgrade. Implementation begins with Growth; Agency follows the
same gateway.
