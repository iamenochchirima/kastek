import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { ApiError } from "../../error.js";
import { AgentPlatformTransport } from "./transport.js";
/** Explicit source-owned adapters preserve endpoint, scope and body contracts. */
export class AgentPlatformClient extends AgentPlatformTransport {
  async ensureKasiai(
    organizationId: string,
    actorId: string,
    settings: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/system-agents/kasiai/installation",
      organizationId,
      actorId,
      ["kasiai:write"],
      settings,
    );
  }
  async getModelCatalog(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/models/catalog",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listCapabilities(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/capabilities",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listCapabilityDirectory(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/capabilities/directory",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listConnectionDirectory(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/connection-directory`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async createAgent(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/agents",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async createStudioAgent(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/studio/agents",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async updateAgent(
    organizationId: string,
    actorId: string,
    agentId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "PATCH",
      `/v1/agents/${agentId}`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async deleteAgent(
    organizationId: string,
    actorId: string,
    agentId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/agents/${agentId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async verifyProviderCredential(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/credentials/verify",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async createProviderCredential(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/credentials",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async listProviderCredentials(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/credentials",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async createExternalAgent(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/external-agents",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async listExternalAgents(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/external-agents",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async getExternalAgent(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/external-agents/${installationId}`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async getExternalAgentHealth(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/external-agents/${installationId}/health`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async archiveExternalAgent(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/external-agents/${installationId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async setExternalAgentStatus(
    organizationId: string,
    actorId: string,
    installationId: string,
    status: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/external-agents/${installationId}/status/${status}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async createAgentVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/agents/${agentId}/versions`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async operationsSummary(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/operations/summary",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async operationsHealth(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/operations/health",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async reconcileEffect(
    organizationId: string,
    actorId: string,
    effectId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/operations/effects/${effectId}/reconcile`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async listKillSwitches(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/operations/kill-switches",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async createKillSwitch(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/operations/kill-switches",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async disableKillSwitch(
    organizationId: string,
    actorId: string,
    switchId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/operations/kill-switches/${switchId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async operatorSummary(operatorId: string): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      "/v1/operator/summary",
      operatorId,
      ["operator:read"],
      undefined,
    );
  }
  async operatorRetentionPreview(
    operatorId: string,
    organizationId: string,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      `/v1/operator/retention/preview/${queryEncode(organizationId)}`,
      operatorId,
      ["operator:read"],
      undefined,
    );
  }
  async operatorHealth(operatorId: string): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      "/v1/operator/health",
      operatorId,
      ["operator:read"],
      undefined,
    );
  }
  async operatorNotifications(operatorId: string): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      "/v1/operator/notifications",
      operatorId,
      ["operator:read"],
      undefined,
    );
  }
  async operatorAcknowledgeNotification(
    operatorId: string,
    notificationId: string,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "POST",
      `/v1/operator/notifications/${queryEncode(notificationId)}/acknowledge`,
      operatorId,
      ["operator:write"],
      {},
    );
  }
  async operatorCreateCommand(
    operatorId: string,
    idempotencyKey: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestOperatorCommand(
      "POST",
      "/v1/operator/commands",
      operatorId,
      ["operator:write"],
      idempotencyKey,
      body,
    );
  }
  async operatorGetCommand(
    operatorId: string,
    commandId: string,
  ): Promise<unknown> {
    return this.requestOperatorCommand(
      "GET",
      `/v1/operator/commands/${queryEncode(commandId)}`,
      operatorId,
      ["operator:read"],
      null,
      undefined,
    );
  }
  async operatorApproveCommand(
    operatorId: string,
    commandId: string,
  ): Promise<unknown> {
    return this.requestOperatorCommand(
      "POST",
      `/v1/operator/commands/${queryEncode(commandId)}/approve`,
      operatorId,
      ["operator:write"],
      null,
      {},
    );
  }
  async operatorProjection(
    operatorId: string,
    projectionKey: string,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      `/v1/operator/projections/${queryEncode(projectionKey)}`,
      operatorId,
      ["operator:read"],
      undefined,
    );
  }
  async operatorRebuildProjections(
    operatorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestOperatorCommand(
      "POST",
      "/v1/operator/projections/rebuild",
      operatorId,
      ["operator:write"],
      null,
      body,
    );
  }
  async listTemplates(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/templates",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async installTemplate(
    organizationId: string,
    actorId: string,
    templateKey: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/templates/${templateKey}/install`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async setInstallationStatus(
    organizationId: string,
    actorId: string,
    installationId: string,
    status: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/status/${status}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async setInstallationSettings(
    organizationId: string,
    actorId: string,
    installationId: string,
    settings: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "PATCH",
      `/v1/installations/${installationId}/settings`,
      organizationId,
      actorId,
      ["agents:write"],
      settings,
    );
  }
  async listInstallationCredentials(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/credentials`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async createInstallationCredential(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/credentials`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async revokeInstallationCredential(
    organizationId: string,
    actorId: string,
    installationId: string,
    credentialId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/installations/${installationId}/credentials/${credentialId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async rotateInstallationCredential(
    organizationId: string,
    actorId: string,
    installationId: string,
    credentialId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/credentials/${credentialId}/rotate`,
      organizationId,
      actorId,
      ["agents:write"],
      {},
    );
  }
  async getInstallationReadiness(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/readiness`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listSkills(organizationId: string, actorId: string): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/skills",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listPluginDirectory(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/plugins/directory",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async installSkillCatalog(
    organizationId: string,
    actorId: string,
    installationId: string,
    catalogId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/skills/catalog/${catalogId}/install`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async installPluginCatalog(
    organizationId: string,
    actorId: string,
    installationId: string,
    catalogId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/plugins/catalog/${catalogId}/install`,
      organizationId,
      actorId,
      ["agents:write"],
      {},
    );
  }
  async listExtensionPackages(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/extensions/packages",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listSkillVersions(
    organizationId: string,
    actorId: string,
    skillId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/skills/${skillId}/versions`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listPinnedSkills(
    organizationId: string,
    actorId: string,
    agentVersionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/agent-versions/${agentVersionId}/skills`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async pinSkill(
    organizationId: string,
    actorId: string,
    agentVersionId: string,
    skillVersionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/agent-versions/${agentVersionId}/skills/${skillVersionId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async unpinSkill(
    organizationId: string,
    actorId: string,
    agentVersionId: string,
    skillVersionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/agent-versions/${agentVersionId}/skills/${skillVersionId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async listMcpProviders(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/mcp/providers",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async connectMcpCatalog(
    organizationId: string,
    actorId: string,
    installationId: string,
    catalogId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/mcp/catalog/${catalogId}/connect`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async startMcpCatalogOAuth(
    organizationId: string,
    actorId: string,
    installationId: string,
    catalogId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/mcp/catalog/${catalogId}/oauth/start`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async createMcpProvider(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/mcp/providers",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async discoverMcpProvider(
    organizationId: string,
    actorId: string,
    providerId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/mcp/providers/${providerId}/discover`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async healthMcpProvider(
    organizationId: string,
    actorId: string,
    providerId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/mcp/providers/${providerId}/health`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async listMcpProviderVersions(
    organizationId: string,
    actorId: string,
    providerId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/mcp/providers/${providerId}/versions`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async publishMcpProviderVersion(
    organizationId: string,
    actorId: string,
    providerId: string,
    versionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/mcp/providers/${providerId}/versions/${versionId}/publish`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async revokeMcpProvider(
    organizationId: string,
    actorId: string,
    providerId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/mcp/providers/${providerId}/revoke`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async listPinnedMcpProviders(
    organizationId: string,
    actorId: string,
    agentVersionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/agent-versions/${agentVersionId}/mcp-providers`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async pinMcpProvider(
    organizationId: string,
    actorId: string,
    agentVersionId: string,
    providerVersionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/agent-versions/${agentVersionId}/mcp-providers/${providerVersionId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async unpinMcpProvider(
    organizationId: string,
    actorId: string,
    agentVersionId: string,
    providerVersionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/agent-versions/${agentVersionId}/mcp-providers/${providerVersionId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async listIntegrationsCatalog(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/integrations/catalog",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listInstallationIntegrations(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/integrations`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async startGoogleOAuth(
    organizationId: string,
    actorId: string,
    installationId: string,
    integrationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/integrations/${integrationId}/oauth/start`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async saveIntegrationApiKey(
    organizationId: string,
    actorId: string,
    installationId: string,
    integrationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/integrations/${integrationId}/api-key`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async saveIntegrationLocalConnector(
    organizationId: string,
    actorId: string,
    installationId: string,
    integrationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/integrations/${integrationId}/local-connector`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async disconnectIntegration(
    organizationId: string,
    actorId: string,
    installationId: string,
    integrationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/installations/${installationId}/integrations/${integrationId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async grantInstallationTool(
    organizationId: string,
    actorId: string,
    installationId: string,
    toolName: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/tools`,
      organizationId,
      actorId,
      ["agents:write"],
      { toolName: toolName },
    );
  }
  async listInstallationGrants(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/grants`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async grantInstallationResource(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/grants/resources`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async listConnectors(
    organizationId: string,
    actorId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      "/v1/connectors",
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async listInstallationConnectors(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/connectors`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async grantInstallationConnector(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/grants/connectors`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async listInstallationSchedules(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/schedules`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async createInstallationSchedule(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/schedules`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async setScheduleStatus(
    organizationId: string,
    actorId: string,
    scheduleId: string,
    status: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/schedules/${scheduleId}/status/${status}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async createKnowledgeSource(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/knowledge/sources",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async getKnowledgeSource(
    organizationId: string,
    actorId: string,
    sourceId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/knowledge/sources/${sourceId}`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async ingestKnowledgeSourceUrl(
    organizationId: string,
    actorId: string,
    sourceId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/knowledge/sources/${sourceId}/ingest-url`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async ingestKnowledgeSourceText(
    organizationId: string,
    actorId: string,
    sourceId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/knowledge/sources/${sourceId}/ingest-text`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async ingestKnowledgeSourceFile(
    organizationId: string,
    actorId: string,
    sourceId: string,
    contentType: string,
    body: Buffer,
  ): Promise<unknown> {
    return this.requestBytes(
      "POST",
      `/v1/knowledge/sources/${sourceId}/ingest-file`,
      organizationId,
      actorId,
      ["agents:write"],
      contentType,
      body,
    );
  }
  async deleteKnowledgeSource(
    organizationId: string,
    actorId: string,
    sourceId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/knowledge/sources/${sourceId}`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async mapAgentWebsite(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/knowledge/websites/map",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async startAgentWebsiteCrawl(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/knowledge/websites/crawl",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async getAgentWebsiteCrawl(
    organizationId: string,
    actorId: string,
    sourceId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/knowledge/websites/crawl/${sourceId}`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async cancelAgentWebsiteCrawl(
    organizationId: string,
    actorId: string,
    sourceId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/knowledge/websites/crawl/${sourceId}`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async deleteMemory(
    organizationId: string,
    actorId: string,
    memoryId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/memory/${memoryId}`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async revalidateMemory(
    organizationId: string,
    actorId: string,
    memoryId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/memory/${memoryId}/revalidate`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async listAgentVersions(
    organizationId: string,
    actorId: string,
    agentId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/agents/${agentId}/versions`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async getAgentDeploymentStatus(
    organizationId: string,
    actorId: string,
    agentId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/agents/${agentId}/deployment-status`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async preflightInstallationDeployment(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/preflight`,
      organizationId,
      actorId,
      ["agents:read"],
      body,
    );
  }
  async deployInstallation(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/deploy`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async promoteInstallation(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/promote`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async rollbackInstallation(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/rollback`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async publishAgentVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    versionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/agents/${agentId}/versions/${versionId}/publish`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async createInstallation(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/installations",
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async rollbackAgentVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    versionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/agents/${agentId}/versions/${versionId}/rollback`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async retireAgentVersion(
    organizationId: string,
    actorId: string,
    agentId: string,
    versionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/agents/${agentId}/versions/${versionId}/retire`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async archiveAgent(
    organizationId: string,
    actorId: string,
    agentId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/agents/${agentId}/archive`,
      organizationId,
      actorId,
      ["agents:write"],
      undefined,
    );
  }
  async resolvePlatformConversation(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/platform/conversation`,
      organizationId,
      actorId,
      ["chat:read"],
      {},
    );
  }
  async createPlatformConversation(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/platform/conversation/new`,
      organizationId,
      actorId,
      ["chat:write"],
      {},
    );
  }
  async clearPlatformConversations(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/platform/conversations/clear`,
      organizationId,
      actorId,
      ["chat:write"],
      {},
    );
  }
  async listConversations(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/conversations`,
      organizationId,
      actorId,
      ["chat:read"],
      undefined,
    );
  }
  async getHandoff(
    organizationId: string,
    actorId: string,
    handoffId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/conversations/handoffs/${handoffId}`,
      organizationId,
      actorId,
      ["agents:read"],
      undefined,
    );
  }
  async claimHandoff(
    organizationId: string,
    actorId: string,
    handoffId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/handoffs/${handoffId}/claim`,
      organizationId,
      actorId,
      ["agents:write"],
      {},
    );
  }
  async releaseHandoff(
    organizationId: string,
    actorId: string,
    handoffId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/handoffs/${handoffId}/release`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async expireHandoff(
    organizationId: string,
    actorId: string,
    handoffId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/handoffs/${handoffId}/expire`,
      organizationId,
      actorId,
      ["agents:write"],
      {},
    );
  }
  async continueHandoff(
    organizationId: string,
    actorId: string,
    handoffId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/handoffs/${handoffId}/continue`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async resolveHandoff(
    organizationId: string,
    actorId: string,
    handoffId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/handoffs/${handoffId}/resolve`,
      organizationId,
      actorId,
      ["agents:write"],
      body,
    );
  }
  async kasiaiHome(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/kasiai/home`,
      organizationId,
      actorId,
      ["kasiai:read"],
      {},
    );
  }
  async kasiaiPreferences(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/kasiai/preferences`,
      organizationId,
      actorId,
      ["kasiai:read"],
      undefined,
    );
  }
  async updateKasiaiPreferences(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "PATCH",
      `/v1/installations/${installationId}/kasiai/preferences`,
      organizationId,
      actorId,
      ["kasiai:write"],
      body,
    );
  }
  async updateConversation(
    organizationId: string,
    actorId: string,
    conversationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "PATCH",
      `/v1/conversations/${conversationId}`,
      organizationId,
      actorId,
      ["chat:write"],
      body,
    );
  }
  async setChannelDefaultConversation(
    organizationId: string,
    actorId: string,
    conversationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/${conversationId}/channel-default`,
      organizationId,
      actorId,
      ["chat:write"],
      {},
    );
  }
  async setConversationStatus(
    organizationId: string,
    actorId: string,
    conversationId: string,
    status: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/${conversationId}/status/${status}`,
      organizationId,
      actorId,
      ["chat:write"],
      {},
    );
  }
  async restoreConversation(
    organizationId: string,
    actorId: string,
    conversationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/conversations/${conversationId}/restore`,
      organizationId,
      actorId,
      ["chat:write"],
      {},
    );
  }
  async sendPlatformMessage(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/platform/messages`,
      organizationId,
      actorId,
      ["chat:write"],
      body,
    );
  }
  async ingestChannelMessage(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/channels/inbound",
      organizationId,
      actorId,
      ["channels:ingest"],
      body,
    );
  }
  async getAudioTranscriptionJob(
    organizationId: string,
    actorId: string,
    jobId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/audio/transcription-jobs/${jobId}`,
      organizationId,
      actorId,
      ["chat:read"],
      undefined,
    );
  }
  async retryAudioTranscription(
    organizationId: string,
    actorId: string,
    jobId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/audio/transcription-jobs/${jobId}/retry`,
      organizationId,
      actorId,
      ["chat:write"],
      {},
    );
  }
  async updateChannelDeliveryStatus(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/channels/delivery-status",
      organizationId,
      actorId,
      ["channels:ingest"],
      body,
    );
  }
  async consumeChannelPairing(
    organizationId: string,
    actorId: string,
    token: string,
    externalIdentity: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/channel-pairing/consume",
      organizationId,
      actorId,
      ["channels:ingest"],
      {
        token: token,
        externalIdentity: externalIdentity,
      },
    );
  }
  async listInstallationChannels(
    organizationId: string,
    actorId: string,
    installationId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/installations/${installationId}/channels`,
      organizationId,
      actorId,
      ["channels:read"],
      undefined,
    );
  }
  async ensureChannelConnection(
    organizationId: string,
    actorId: string,
    installationId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/channels`,
      organizationId,
      actorId,
      ["channels:write"],
      body,
    );
  }
  async revokeChannelConnection(
    organizationId: string,
    actorId: string,
    installationId: string,
    connectionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/installations/${installationId}/channels/${connectionId}`,
      organizationId,
      actorId,
      ["channels:write"],
      undefined,
    );
  }
  async updateChannelConnection(
    organizationId: string,
    actorId: string,
    installationId: string,
    connectionId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "PATCH",
      `/v1/installations/${installationId}/channels/${connectionId}`,
      organizationId,
      actorId,
      ["channels:write"],
      body,
    );
  }
  async issueChannelPairing(
    organizationId: string,
    actorId: string,
    installationId: string,
    connectionId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/installations/${installationId}/channels/${connectionId}/pairing`,
      organizationId,
      actorId,
      ["channels:write"],
      {},
    );
  }
  async revokeChannelBinding(
    organizationId: string,
    actorId: string,
    bindingId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/v1/channel-bindings/${bindingId}`,
      organizationId,
      actorId,
      ["channels:write"],
      undefined,
    );
  }
  async getRun(
    organizationId: string,
    actorId: string,
    runId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/runs/${runId}`,
      organizationId,
      actorId,
      ["runs:read"],
      undefined,
    );
  }
  async getRunTimeline(
    organizationId: string,
    actorId: string,
    runId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/runs/${runId}/timeline`,
      organizationId,
      actorId,
      ["runs:read"],
      undefined,
    );
  }
  async cancelRun(
    organizationId: string,
    actorId: string,
    runId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/runs/${runId}/cancel`,
      organizationId,
      actorId,
      ["runs:cancel"],
      body,
    );
  }
  async retryRun(
    organizationId: string,
    actorId: string,
    runId: string,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/runs/${runId}/retry`,
      organizationId,
      actorId,
      ["chat:write"],
      {},
    );
  }
  async signalExternalEvent(
    organizationId: string,
    actorId: string,
    runId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/runs/${runId}/external-event`,
      organizationId,
      actorId,
      ["runs:write"],
      body,
    );
  }
  async approveRunGroup(
    organizationId: string,
    actorId: string,
    runId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/runs/${runId}/approval-group`,
      organizationId,
      actorId,
      ["runs:approve"],
      body,
    );
  }
  async decideChannelApproval(
    organizationId: string,
    actorId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/v1/channel-approvals/decide",
      organizationId,
      actorId,
      ["channels:ingest"],
      body,
    );
  }
  async listAgents(
    org: string,
    actor: string,
    environment: string | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      environment === null
        ? "/v1/agents"
        : `/v1/agents?environment=${environment}`,
      org,
      actor,
      ["agents:read"],
    );
  }
  async operationsRuns(
    org: string,
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/operations/runs", [["limit", limit]]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async operationsEffectsReconciliation(
    org: string,
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/operations/effects/reconciliation", [["limit", limit]]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async listAudit(
    org: string,
    actor: string,
    action: string | null,
    resourceType: string | null,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/audit", [
        ["action", action],
        ["resourceType", resourceType],
        ["limit", limit],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async operatorAudit(
    actor: string,
    action: string | null,
    resourceType: string | null,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/audit", [
        ["action", action],
        ["resourceType", resourceType],
        ["limit", limit],
      ]),
      actor,
      ["operator:read"],
    );
  }
  async operatorSearch(
    actor: string,
    query: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      `/v1/operator/search?q=${queryEncode(query)}${limit === null ? "" : `&limit=${limit}`}`,
      actor,
      ["operator:read"],
    );
  }
  async listInstallationCapabilities(
    org: string,
    actor: string,
    id: string,
    credentialId: string | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath(`/v1/installations/${id}/capabilities`, [
        ["credentialId", credentialId],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async listSkillDirectory(
    org: string,
    actor: string,
    id: string | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/skills/directory", [["agentVersionId", id]]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async completeMcpOAuthCallback(query: string): Promise<unknown> {
    return this.requestOAuthCallback(
      "/v1/integrations/mcp/oauth/callback" + (query.trim() ? `?${query}` : ""),
    );
  }
  async completeGoogleOAuthCallback(query: string): Promise<unknown> {
    return this.requestOAuthCallback(
      "/v1/integrations/google/oauth/callback" +
        (query.trim() ? `?${query}` : ""),
    );
  }
  async completeMicrosoftOAuthCallback(query: string): Promise<unknown> {
    return this.requestOAuthCallback(
      "/v1/integrations/microsoft/oauth/callback" +
        (query.trim() ? `?${query}` : ""),
    );
  }
  async listInstallationRuns(
    org: string,
    actor: string,
    id: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath(`/v1/installations/${id}/runs`, [["limit", limit]]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async listKnowledgeSources(
    org: string,
    actor: string,
    agentId: string | null,
    installationId: string | null,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/knowledge/sources", [
        ["agentId", agentId],
        ["installationId", installationId],
        ["limit", limit],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async listMemory(
    org: string,
    actor: string,
    agentId: string,
    installationId: string | null,
    limit: number | null,
  ): Promise<unknown> {
    const params: [string, string | number | null][] = [
      ["installationId", installationId],
      ["limit", limit],
    ];
    return this.requestJson(
      "GET",
      `/v1/memory?agentId=${queryEncode(agentId)}${queryPath("", params).replace(/^\?/, "&")}`,
      org,
      actor,
      ["agents:read"],
    );
  }
  async getAgentVersionEffectiveConfig(
    org: string,
    actor: string,
    id: string,
    installationId: string | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath(`/v1/agent-versions/${id}/effective-config`, [
        ["installationId", installationId],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async listHandoffs(
    org: string,
    actor: string,
    installationId: string | null,
    agentId: string | null,
    channelType: string | null,
    reason: string | null,
    status: string | null,
    assignment: string | null,
    priority: string | null,
    search: string | null,
    limit: number | null,
    cursor: string | null,
    before: string | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/conversations/handoffs", [
        ["installationId", installationId],
        ["agentId", agentId],
        ["channelType", channelType],
        ["reason", reason],
        ["status", status],
        ["assignment", assignment],
        ["priority", priority],
        ["search", search],
        ["cursor", cursor],
        ["before", before],
        ["limit", limit],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async listLiveConversations(
    org: string,
    actor: string,
    installationId: string | null,
    agentId: string | null,
    channelType: string | null,
    search: string | null,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/conversations/live", [
        ["installationId", installationId],
        ["agentId", agentId],
        ["channelType", channelType],
        ["search", search],
        ["limit", limit],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async listCustomerConversations(
    org: string,
    actor: string,
    installationId: string | null,
    agentId: string | null,
    channelType: string | null,
    search: string | null,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/conversations/customer", [
        ["installationId", installationId],
        ["agentId", agentId],
        ["channelType", channelType],
        ["search", search],
        ["limit", limit],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async getConversationSummary(
    org: string,
    actor: string,
    installationId: string | null,
    agentId: string | null,
    channelType: string | null,
    search: string | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath("/v1/conversations/summary", [
        ["installationId", installationId],
        ["agentId", agentId],
        ["channelType", channelType],
        ["search", search],
      ]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async getConversation(
    org: string,
    actor: string,
    id: string,
    limit: number | null,
    before: string | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath(`/v1/conversations/${id}`, [
        ["limit", limit],
        ["before", before],
      ]),
      org,
      actor,
      ["chat:read"],
    );
  }
  async getRunMemoryObservatory(
    org: string,
    actor: string,
    id: string,
    afterSequence: bigint | number | null,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestJson(
      "GET",
      queryPath(`/v1/runs/${id}/memory-observatory`, [
        ["afterSequence", afterSequence],
        ["limit", limit],
      ]),
      org,
      actor,
      ["runs:read"],
    );
  }
  async sendHumanMessage(
    org: string,
    actor: string,
    id: string,
    body: unknown,
    key: string,
  ): Promise<unknown> {
    if (
      body !== null &&
      typeof body === "object" &&
      !(body instanceof SerdeFloat) &&
      !Array.isArray(body)
    )
      body = { ...body, idempotencyKey: key };
    return this.requestJson(
      "POST",
      `/v1/conversations/handoffs/${id}/messages`,
      org,
      actor,
      ["agents:write"],
      body,
    );
  }
  async streamConversationFeedEvents(
    org: string,
    actor: string,
  ): Promise<Response> {
    return this.requestStream("/v1/conversations/events/stream", org, actor, [
      "agents:read",
    ]);
  }
  async streamConversationEvents(
    org: string,
    actor: string,
    id: string,
    after: bigint | number | null,
  ): Promise<Response> {
    return this.requestStream(
      queryPath(`/v1/conversations/${id}/events/stream`, [["after", after]]),
      org,
      actor,
      ["agents:read"],
    );
  }
  async streamRunEvents(
    org: string,
    actor: string,
    id: string,
    after: bigint | number | null,
  ): Promise<Response> {
    return this.requestStream(
      queryPath(`/v1/runs/${id}/events/stream`, [["after", after]]),
      org,
      actor,
      ["runs:read"],
    );
  }
  async transcribeAudio(
    org: string,
    actor: string,
    bytes: Buffer,
    mimeType: string,
    fileName: string | null,
  ): Promise<unknown> {
    return this.requestMultipart(
      "POST",
      "/v1/audio/transcriptions",
      org,
      actor,
      ["channels:ingest"],
      audioForm(bytes, mimeType, fileName),
    );
  }
  async sendPlatformAudio(
    org: string,
    actor: string,
    id: string,
    bytes: Buffer,
    mimeType: string,
    fileName: string | null,
    key: string,
    conversationId: string,
    caption: string | null,
    contextRoute: string | null,
    contextTitle: string | null,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "x-audio-idempotency-key": key,
      "x-audio-conversation-id": conversationId,
    };
    for (const [name, value] of [
      ["x-audio-caption", caption],
      ["x-audio-context-route", contextRoute],
      ["x-audio-context-title", contextTitle],
    ] as const)
      if (value?.trim()) headers[name] = value;
    return this.requestMultipart(
      "POST",
      `/v1/installations/${id}/platform/audio`,
      org,
      actor,
      ["chat:write"],
      audioForm(bytes, mimeType, fileName),
      headers,
    );
  }
  async forwardTelegramWebhook(
    id: string,
    secret: string | null,
    body: unknown,
  ): Promise<unknown> {
    return this.requestForwardedJson(
      `/v1/webhooks/telegram/${id}`,
      secret,
      body,
    );
  }
  async operatorRuns(actor: string, limit: number | null): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/runs", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorExports(actor: string, limit: number | null): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/exports", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorKillSwitches(
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/kill-switches", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorFeatureFlags(
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/feature-flags", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorAudioTranscriptionJobs(
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/audio-transcription/jobs", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorHolds(actor: string, limit: number | null): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/holds", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorRetentionPolicies(
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/retention/policies", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorLegalHolds(
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/retention/legal-holds", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
  async operatorEffectsReconciliation(
    actor: string,
    limit: number | null,
  ): Promise<unknown> {
    return this.requestOperatorJson(
      "GET",
      queryPath("/v1/operator/effects/reconciliation", [["limit", limit]]),
      actor,
      ["operator:read"],
    );
  }
}
function queryPath(
  path: string,
  pairs: [string, string | number | bigint | null][],
): string {
  const values = pairs
    .filter(
      ([, value]) =>
        value !== null && (typeof value !== "string" || value.trim()),
    )
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? queryEncode(value) : value}`,
    );
  return path + (values.length ? "?" + values.join("&") : "");
}
function audioForm(
  bytes: Buffer,
  mimeType: string,
  fileName: string | null,
): FormData {
  if (
    !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+\/[!#$%&'*+.^_`|~0-9a-zA-Z-]+(?:\s*;[^\r\n]*)?$/.test(
      mimeType,
    )
  )
    throw new ApiError(400, "bad_request", "Audio MIME type is invalid");
  const form = new FormData();
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  if (fileName?.trim()) form.append("file", blob, fileName);
  else form.append("file", blob);
  return form;
}

function queryEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}
