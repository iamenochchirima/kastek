---
title: Architecture
slug: /architecture
sidebar_position: 4
---

# Architecture

This is the technical source of truth for how Kasitek products, services, systems, agents, and integrations fit together.

It records decisions that implementation must follow. It is deliberately concise: detailed delivery plans belong in implementation trackers, not here.

## 1. Product Map

Kasitek Labs builds AI-powered products and services for SMBs. `Kasitek` is the connected business system; individual products are focused ways to use that system.

```text
Kasitek Labs
|
|-- Kasitek: connected business system
|   |-- KasiInbox: customer conversations and support work
|   |-- KasiReach: outbound campaigns and lead follow-up
|   |-- KasiSocial: social publishing and engagement
|   `-- KasiAgents: native agents, workflows, and agent access gateway
|
`-- Services: websites, agent implementation, automation, and ongoing support
```

Future products must extend the same business system rather than create disconnected copies of customers, contacts, content, or workflows.

## 2. System Map

```text
                         Kasitek Labs
                              |
              +---------------+----------------+
              |                                |
      Direct Kasitek product              White-label product
              |                                |
  client/apps/client                    client/apps/tenant-portal
  client/apps/admin                     server/kasitek-tenants
  server/kasitek-core                    tenant database
              |
              +-------------+------------------+
                            |
                    Shared business capabilities
        customers | conversations | campaigns | content | workflows
```

### Architectural Boundaries

- `server/kasitek-core` owns the direct Kasitek product runtime.
- `server/kasitek-tenants` owns white-label tenant auth, routing, isolation, and branded portal concerns.
- The white-label platform keeps its own database and identity/session model.
- The three white-label layers remain mandatory: Kasitek platform, tenant staff, and tenant clients.
- Product interfaces may evolve independently, but they must use shared, typed business capabilities where they operate on the same data.

## 3. Agent Architecture

`KasiAgents` is both a native agent platform and the controlled gateway through which external agents interact with Kasitek.

```text
External agents and AI clients
              |
       MCP with OAuth
              |
       KasiAgents Gateway
 identity | tenant scope | policy | approval | audit
              |
       Capability Registry
              |
  KasiInbox | KasiReach | KasiSocial | future products
              |
        Kasitek business data

Native Kasitek agents use the same Capability Registry.
Specialist agents may delegate structured, long-running work through A2A.
```

### Protocol Roles

| Interface | Role in Kasitek |
| --- | --- |
| REST API and webhooks | The foundational product and integration contract. |
| MCP | Lets approved external AI clients discover permitted context and call Kasitek capabilities. |
| A2A | Lets independent agents discover one another and delegate structured tasks. |

MCP and A2A are adapters over real domain services. They must never become an alternate path around Kasitek permissions, validation, or audit records.

### Agent Control Rules

- Agents act through typed capabilities, never unrestricted database access.
- Every call is scoped to one organisation and the identity that authorised it.
- Read, draft, send, publish, spend, delete, and admin actions have different policy levels.
- Sending messages, publishing content, spending money, deleting data, and privileged account changes require explicit approval unless an approved policy says otherwise.
- Each execution records actor, inputs, data scope, tools used, output, approval, result, and failure state.
- Access is revocable and credentials are short-lived.

## 4. Initial Capability Model

Capabilities describe business actions, not a particular model or agent framework.

| Capability family | Example actions | Default risk |
| --- | --- | --- |
| Customer context | `search_customers`, `get_conversation_summary` | Read |
| Drafting | `draft_reply`, `draft_social_post`, `create_campaign_draft` | Draft |
| Operational changes | `assign_conversation`, `schedule_post` | Controlled write |
| External actions | `send_message`, `publish_post`, `launch_campaign` | Approval required |
| Privileged actions | `delete_data`, `change_billing`, `manage_access` | Admin approval required |

## 5. Integration Direction

Integrations connect to the appropriate product domain and then publish safe capabilities through the registry.

```text
Meta / WhatsApp / Email / Web / CRM / Automation platforms
                         |
                    Product domain service
                         |
                  Capability Registry
                         |
                 KasiAgents and external agents
```

Provider credentials, tokens, webhooks, and raw API details remain owned by their relevant integration service. Agents receive only the safe business action required to complete a task.

## 6. Delivery Sequence

1. Define and implement the shared capability registry and its typed contracts.
2. Add organisation-scoped agent identity, grants, policy evaluation, approvals, and immutable execution logs.
3. Build native KasiAgents workflows on top of those capabilities.
4. Expose a limited, read-and-draft-first MCP server for approved external agents.
5. Add A2A support for delegated and long-running specialist agent tasks after the internal execution model is proven.

## 7. Decision Register

| Decision | Status | Notes |
| --- | --- | --- |
| Kasitek is the shared business system; product lines are focused surfaces over it. | Accepted | Prevents siloed products and duplicated customer context. |
| KasiAgents is the native agent runtime and external-agent gateway. | Accepted | It does not bypass product-domain ownership. |
| REST is foundational; MCP and A2A are protocol adapters. | Accepted | Keeps interoperability without coupling the platform to one protocol. |
| External-agent access is organisation-scoped, policy-limited, and auditable. | Accepted | No broad account or database access. |
| MCP is introduced before A2A. | Accepted | External tool access is the nearer product need; agent delegation follows. |

## 8. Open Decisions

- Which first capability set is valuable enough for external MCP access?
- Which native agents should launch first: inbox triage, sales follow-up, social content, or website lead qualification?
- Which actions can be pre-approved by organisation policy, and which always require a person?
- Where should long-running workflows execute, and how are they retried, paused, or cancelled?
- What commercial tier includes external-agent access and custom agent development?
