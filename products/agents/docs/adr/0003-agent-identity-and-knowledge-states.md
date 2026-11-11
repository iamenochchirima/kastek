# 0003: Structured agent identity and separate knowledge states

Status: Accepted. 2026-11-11.

## Context

Agent behaviour lived in one free-text `instructions` field. Owners mixed persona, task rules
and refusal policy in that field, and guided setup could overwrite text they had written.
Knowledge also conflated three different facts: a revision was approved, an agent version
attached it, and a customer channel could use it. An upload could publish a source to customers
before the agent save succeeded.

Identity and behaviour were also absent from existing agents. Changing their prompt would change
customer-visible answers without an owner action.

## Decision

Store identity and guidance as optional structured fields in the existing agent configuration:

```ts
type AgentConfiguration = {
  instructions: string;
  identity?: AgentIdentity;
  guidance?: AgentGuidance;
};
```

- The draft and every immutable version carry the same shape. No revision table is added.
- Prompt composition is platform contract, identity, instructions, guidance, tools and retrieved
  knowledge. Identity and guidance cannot grant tools or override the platform contract.
- A configuration without `identity` and `guidance` composes to exactly the previous prompt.
  Existing agents keep that path until an owner saves the new layers.
- New agents receive role-specific defaults. Guided setup updates a default identity when
  responsibilities change and preserves identity and instructions the owner has edited.
- Knowledge has three separate states: approved, attached to an agent version, and
  customer-eligible. Customer eligibility requires an active, approved, public, attached revision.
- Upload and website import may approve and attach a source in the owner's draft, but never make
  it public automatically. Publishing to customer channels remains an explicit Knowledge action.
- Review freshness is per source: last verified, who verified it, and a review due date. A due
  date produces a warning; it is not a hard cutoff.

## Consequences

- Legacy prompt parity is testable and existing published agents do not change silently.
- Owners edit persona separately from task rules and policy.
- Approval no longer implies customer visibility, so the knowledge screen must show attached and
  eligible state explicitly, not just a Ready badge.
- A failed agent save can leave an approved private source, but cannot leave a public source that
  no agent attached.
- Review dates are advisory. Stale knowledge remains usable until an owner withdraws or replaces
  it.
- A feature flag is unnecessary for the first rollout because the composition is additive and
  legacy agents have no identity. Removing an identity is a deliberate owner edit.

## Alternatives considered

- **Canonical markdown document.** Easier to import and export, but parsing and section ownership
  make validation, partial updates and per-field limits implicit.
- **Automatic identity adoption for existing agents.** Rejected. It changes customer-visible
  behaviour without an owner save.
- **One hard freshness cutoff.** Rejected. Sources age at different rates and a global cutoff
  would disable valid knowledge without an owner decision.
- **Approval implies customer visibility.** Rejected. It removes the explicit publish decision and
  allowed a failed attach to expose knowledge.
