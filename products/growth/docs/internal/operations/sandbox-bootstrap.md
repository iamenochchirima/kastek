---
title: Evaluation sandbox bootstrap
owner: engineering
last_reviewed: 2026-11-10
---

# Evaluation sandbox bootstrap

The evaluation provisioner creates a Growth sandbox as a pair:

- a Growth database, API and owner/business workspace
- a dedicated Agents runtime sandbox
- signed Growth ↔ Agents service keys and a recorded pair

`products/growth/api/src/bootstrap-sandbox.ts` is the product-owned bootstrap for
the Growth side. It is only for isolated evaluation sandboxes:

```sh
DATABASE_URL=<fresh-growth-database> \
GROWTH_BOOTSTRAP_EMAIL=owner@example.local \
GROWTH_BOOTSTRAP_WORKSPACE_NAME="Acme support" \
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_ID=growth-default \
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_REVISION=1 \
node --import tsx products/growth/api/src/bootstrap-sandbox.ts
```

It creates a verified local Growth user, organization with OWNER membership,
BusinessProfile, a local owner session, and a pending `GrowthAgentSetup` job. The
provisioner runs the `growth-agent-setup-worker` to create the four Growth agents
in the paired Agents runtime.

The bootstrap session has a future identity-check timestamp so it can be used
without a running identity provider. It must never be used as a production
authentication path. Production login remains Keycloak OIDC.
