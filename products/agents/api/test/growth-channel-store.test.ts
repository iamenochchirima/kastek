import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ChannelStore } from "../src/product/channels/channel-store";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  agent: "00000000-0000-4000-8000-000000000002",
  connection: "00000000-0000-4000-8000-000000000003",
  deployment: "00000000-0000-4000-8000-000000000004",
  grant: "00000000-0000-4000-8000-000000000005",
  intent: "00000000-0000-4000-8000-000000000006",
  request: "00000000-0000-4000-8000-000000000007",
  exchangeRequest: "00000000-0000-4000-8000-000000000008",
};

describe("Growth-managed channel authority", () => {
  it("uses the verified Growth actor for outbound Growth commands", async () => {
    const growthActor = { issuer: "https://growth.example.test/identity", subject: "growth-user-1" };
    const agentsActor = { issuer: "https://agents.example.test/identity", subject: "agents-user-1" };
    const row = {
      id: ids.connection,
      organization_id: ids.organization,
      created_by: "account-1",
      kind: "facebook",
      mode: "growth_managed",
      state: "active",
      asset_id: "page-1",
      revision: 1,
      credential_revision: 0,
      metadata: { growthLink: {
        growthOrganizationId: "growth-org-1",
        growthConnectionId: "growth-connection-1",
        permissionRevision: "permission-revision-1",
        providerMode: "meta",
        intentId: ids.intent,
        requestId: ids.request,
        exchangeRequestId: ids.exchangeRequest,
        agentId: ids.agent,
        actor: agentsActor,
        growthActor,
        state: "active",
        grantId: ids.grant,
      } },
      created_at: new Date("2026-11-05T00:00:00.000Z"),
      updated_at: new Date("2026-11-05T00:00:00.000Z"),
      bound_agent_id: ids.agent,
      local_grant_id: ids.grant,
      local_grant_state: "active",
      grant_provider: "facebook",
      growth_organization_id: "growth-org-1",
      growth_connection_id: "growth-connection-1",
      provider_asset_id: "page-1",
      permission_revision: "permission-revision-1",
    };
    const pool = { query: async () => ({ rows: [row] }) } as unknown as Pool;
    const store = new ChannelStore(pool);

    const authority = await store.growthManagedDeliveryAuthority({
      connectionId: ids.connection,
      deploymentId: ids.deployment,
    });

    expect(authority.actor).toEqual(growthActor);
    expect(authority.actor).not.toEqual(agentsActor);

    row.metadata.growthChannelHealth = { state: "needs_attention", code: "AGENT_CHANNEL_PERMISSION_MISSING" };

    await expect(store.assertGrowthManagedInboundAuthority({
      workspaceId: ids.organization,
      agentId: ids.agent,
      connectionId: ids.connection,
      grantId: ids.grant,
      provider: "facebook",
      providerAssetId: "page-1",
      actor: growthActor,
    })).resolves.toMatchObject({ connectionId: ids.connection, assetId: "page-1" });
    await expect(store.growthManagedDeliveryAuthority({
      connectionId: ids.connection,
      deploymentId: ids.deployment,
    })).rejects.toMatchObject({ code: "GROWTH_CHANNEL_NEEDS_ATTENTION" });
  });
});
