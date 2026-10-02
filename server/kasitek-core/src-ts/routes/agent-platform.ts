import { canonicalJsonBody } from "../identity/json-body.js";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { Readable } from "node:stream";
import { createId } from "@paralleldrive/cuid2";
import * as website from "../services/website/index.js";
import { listWhatsappConnections } from "../services/whatsapp/connections.js";
import {
  bad,
  nonempty,
  requiredString,
  validatedQuery,
  validUint,
  checkLimit,
  sanitizeMessageBody,
  validAudioSignature,
  guardRawPayload,
} from "../services/agent-platform/controller-support.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireCapability } from "../services/billing.js";
import { ApiError, RequestExtractionError } from "../error.js";
import { AgentPlatformClient } from "../services/agent-platform/client.js";
import type { AgentTransportOptions } from "../services/agent-platform/transport.js";
const agentScopeCache = new WeakMap<
  FastifyRequest,
  {
    user: Awaited<ReturnType<typeof extractUser>>;
    org: string;
    management: boolean;
  }
>();
async function agentScope(
  request: FastifyRequest,
  core: CoreContext,
  management = false,
) {
  const cached = agentScopeCache.get(request);
  if (cached && (!management || cached.management)) return cached;
  const user = await extractUser(request, core),
    org = await resolveActiveOrgId(request, core, user.id);
  if (management)
    await requireCapability(core.pool, org, "feature.agents.manage");
  const result = { user, org, management };
  agentScopeCache.set(request, result);
  return result;
}
const param = (request: FastifyRequest, name: string) =>
  (request.params as Record<string, string>)[name]!;
function requiredJson(request: FastifyRequest): unknown {
  if (request.body === undefined) bad("Invalid request");
  return canonicalJsonBody(request);
}
function objectBody(
  request: FastifyRequest,
  message: string,
  optional = false,
): Record<string, unknown> {
  const body =
    request.body === undefined && optional ? {} : canonicalJsonBody(request);
  if (
    body === null ||
    body instanceof SerdeFloat ||
    typeof body !== "object" ||
    Array.isArray(body)
  )
    throw new ApiError(400, "bad_request", message);
  return body as Record<string, unknown>;
}
function headerValue(request: FastifyRequest, key: string): string | null {
  const value = request.headers[key];
  return typeof value === "string" ? value : null;
}
function deploymentBody(request: FastifyRequest): website.DeploymentInput {
  let body: Record<string, unknown>;
  try {
    body = objectBody(request, "Invalid website deployment");
  } catch (error) {
    if (error instanceof ApiError && error.status === 400)
      throw new RequestExtractionError("json");
    throw error;
  }
  for (const key of [
    "displayName",
    "welcomeText",
    "launcherPosition",
    "colorPreset",
    "avatarUrl",
    "privacyPolicyUrl",
  ])
    if (
      body[key] !== undefined &&
      body[key] !== null &&
      typeof body[key] !== "string"
    )
      throw new RequestExtractionError("json");
  if (
    body.allowedOrigins !== undefined &&
    body.allowedOrigins !== null &&
    (!Array.isArray(body.allowedOrigins) ||
      body.allowedOrigins.some((value) => typeof value !== "string"))
  )
    throw new RequestExtractionError("json");
  if (body.appearance !== undefined && body.appearance !== null) {
    if (typeof body.appearance !== "object" || Array.isArray(body.appearance))
      throw new RequestExtractionError("json");
    const appearance = body.appearance as Record<string, unknown>;
    if (
      appearance.primaryColor !== undefined &&
      appearance.primaryColor !== null &&
      typeof appearance.primaryColor !== "string"
    )
      throw new RequestExtractionError("json");
    for (const key of [
      "launcherSize",
      "windowWidth",
      "windowHeight",
      "borderRadius",
      "launcherOffset",
    ])
      if (
        appearance[key] !== undefined &&
        appearance[key] !== null &&
        (!Number.isInteger(appearance[key]) ||
          Number(appearance[key]) < -2147483648 ||
          Number(appearance[key]) > 2147483647)
      )
        throw new RequestExtractionError("json");
    if (
      appearance.showBranding !== undefined &&
      appearance.showBranding !== null &&
      typeof appearance.showBranding !== "boolean"
    )
      throw new RequestExtractionError("json");
  }
  return body as website.DeploymentInput;
}
/** Source controller adapters. Additional domain orchestration is registered as completed. */
export function registerAgentPlatformRoutes(
  app: FastifyInstance,
  core: CoreContext,
  options: AgentTransportOptions = {},
): void {
  app.get("/api/agents/models/catalog", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).getModelCatalog(org, user.id);
    return reply.code(200).send(result);
  });
  app.post("/api/agents", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Agent body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createAgent(org, user.id, request.body);
    return reply.code(201).send(result);
  });
  app.post("/api/agents/studio", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Studio agent body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createStudioAgent(org, user.id, request.body);
    return reply.code(201).send(result);
  });
  app.patch("/api/agents/:agentId", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Agent body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).updateAgent(org, user.id, param(request, "agentId").trim(), request.body);
    return reply.code(200).send(result);
  });
  app.post("/api/agents/credentials/verify", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(
      request,
      "Credential verification body must be an object",
      false,
    );
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).verifyProviderCredential(org, user.id, request.body);
    return reply.code(200).send(result);
  });
  app.post("/api/agents/credentials", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Credential body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createProviderCredential(org, user.id, request.body);
    return reply.code(201).send(result);
  });
  app.get("/api/agents/credentials", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listProviderCredentials(org, user.id);
    return reply.code(200).send(result);
  });
  app.post("/api/agents/external-agents", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "External agent body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createExternalAgent(org, user.id, request.body);
    return reply.code(201).send(result);
  });
  app.get("/api/agents/external-agents", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listExternalAgents(org, user.id);
    return reply.code(200).send(result);
  });
  app.get(
    "/api/agents/external-agents/:installationId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getExternalAgent(org, user.id, param(request, "installationId").trim());
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/external-agents/:installationId/health",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getExternalAgentHealth(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.delete(
    "/api/agents/external-agents/:installationId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).archiveExternalAgent(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post("/api/agents/:agentId/versions", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Agent version body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createAgentVersion(
      org,
      user.id,
      param(request, "agentId").trim(),
      requiredJson(request),
    );
    return reply.code(201).send(result);
  });
  app.get("/api/agents/operations/summary", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).operationsSummary(org, user.id);
    return reply.code(200).send(result);
  });
  app.get("/api/agents/operations/health", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).operationsHealth(org, user.id);
    return reply.code(200).send(result);
  });
  app.get("/api/agents/operations/kill-switches", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listKillSwitches(org, user.id);
    return reply.code(200).send(result);
  });
  app.get(
    "/api/agents/installations/:installationId/schedules",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationSchedules(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/knowledge/sources/:sourceId", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).getKnowledgeSource(org, user.id, param(request, "sourceId").trim());
    return reply.code(200).send(result);
  });
  app.post("/api/agents/knowledge/websites/map", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Website map body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).mapAgentWebsite(org, user.id, request.body);
    return reply.code(200).send(result);
  });
  app.post("/api/agents/knowledge/websites/crawl", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Website crawl body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).startAgentWebsiteCrawl(org, user.id, request.body);
    return reply.code(202).send(result);
  });
  app.get(
    "/api/agents/knowledge/websites/crawl/:sourceId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getAgentWebsiteCrawl(org, user.id, param(request, "sourceId").trim());
      return reply.code(200).send(result);
    },
  );
  app.delete(
    "/api/agents/knowledge/websites/crawl/:sourceId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).cancelAgentWebsiteCrawl(
        org,
        user.id,
        param(request, "sourceId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.delete("/api/agents/memory/:memoryId", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "Memory deletion body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).deleteMemory(
      org,
      user.id,
      param(request, "memoryId").trim(),
      requiredJson(request),
    );
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/memory/:memoryId/revalidate",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(request, "Memory revalidation body must be an object", false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).revalidateMemory(
        org,
        user.id,
        param(request, "memoryId").trim(),
        requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/conversations",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listConversations(org, user.id, param(request, "installationId"));
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/conversations/handoffs/:handoffId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getHandoff(org, user.id, param(request, "handoffId").trim());
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/conversations/handoffs/:handoffId/claim",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).claimHandoff(org, user.id, param(request, "handoffId").trim());
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/conversations/handoffs/:handoffId/release",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      objectBody(request, "Handoff release body must be an object", true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).releaseHandoff(
        org,
        user.id,
        param(request, "handoffId").trim(),
        request.body === undefined ? {} : requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/conversations/handoffs/:handoffId/expire",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).expireHandoff(org, user.id, param(request, "handoffId").trim());
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/conversations/handoffs/:handoffId/continue",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      objectBody(request, "Handoff continuation body must be an object", true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).continueHandoff(
        org,
        user.id,
        param(request, "handoffId").trim(),
        request.body === undefined ? {} : requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/conversations/handoffs/:handoffId/resolve",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      objectBody(request, "Handoff resolution body must be an object", true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).resolveHandoff(
        org,
        user.id,
        param(request, "handoffId").trim(),
        request.body === undefined ? {} : requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/kasiai/home",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).kasiaiHome(org, user.id, param(request, "installationId").trim());
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/kasiai/preferences",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).kasiaiPreferences(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.patch(
    "/api/agents/installations/:installationId/kasiai/preferences",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      objectBody(request, "KasiAi preferences must be an object", false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).updateKasiaiPreferences(
        org,
        user.id,
        param(request, "installationId").trim(),
        requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.patch(
    "/api/agents/conversations/:conversationId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      objectBody(request, "Conversation update must be an object", false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).updateConversation(
        org,
        user.id,
        param(request, "conversationId").trim(),
        requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/conversations/:conversationId/channel-default",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).setChannelDefaultConversation(
        org,
        user.id,
        param(request, "conversationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/conversations/:conversationId/restore",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).restoreConversation(
        org,
        user.id,
        param(request, "conversationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/channels",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationChannels(
        org,
        user.id,
        param(request, "installationId"),
      );
      return reply.code(200).send(result);
    },
  );
  app.patch(
    "/api/agents/installations/:installationId/channels/:connectionId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(request, "Channel update body must be an object", false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).updateChannelConnection(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "connectionId").trim(),
        requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/channels/:connectionId/pairing",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(request, "Pairing body must be an object", true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).issueChannelPairing(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "connectionId").trim(),
      );
      return reply.code(201).send(result);
    },
  );
  app.delete(
    "/api/agents/installations/:installationId/channels/:connectionId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).revokeChannelConnection(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "connectionId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.delete(
    "/api/agents/channel-bindings/:bindingId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).revokeChannelBinding(org, user.id, param(request, "bindingId").trim());
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/templates", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listTemplates(org, user.id);
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/templates/:templateKey/install",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(request, "Template installation body must be an object", true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).installTemplate(
        org,
        user.id,
        param(request, "templateKey"),
        request.body === undefined ? {} : requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/credentials",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationCredentials(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/credentials",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(
        request,
        "Installation credential body must be an object",
        false,
      );
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).createInstallationCredential(
        org,
        user.id,
        param(request, "installationId").trim(),
        requiredJson(request),
      );
      return reply.code(201).send(result);
    },
  );
  app.delete(
    "/api/agents/installations/:installationId/credentials/:credentialId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).revokeInstallationCredential(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "credentialId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/credentials/:credentialId/rotate",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).rotateInstallationCredential(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "credentialId").trim(),
      );
      return reply.code(201).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/capabilities",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationCapabilities(
        org,
        user.id,
        param(request, "installationId").trim(),
        null,
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/capabilities", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listCapabilities(org, user.id);
    return reply.code(200).send(result);
  });
  app.get("/api/agents/capabilities/directory", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listCapabilityDirectory(org, user.id);
    return reply.code(200).send(result);
  });
  app.get(
    "/api/agents/installations/:installationId/connection-directory",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listConnectionDirectory(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/readiness",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getInstallationReadiness(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/skills", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listSkills(org, user.id);
    return reply.code(200).send(result);
  });
  app.get("/api/agents/plugins/directory", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listPluginDirectory(org, user.id);
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/installations/:installationId/skills/catalog/:catalogId/install",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).installSkillCatalog(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "catalogId").trim(),
        requiredJson(request),
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/plugins/catalog/:catalogId/install",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).installPluginCatalog(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "catalogId").trim(),
      );
      return reply.code(201).send(result);
    },
  );
  app.get("/api/agents/extensions/packages", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listExtensionPackages(org, user.id);
    return reply.code(200).send(result);
  });
  app.get("/api/agents/skills/:skillId/versions", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listSkillVersions(org, user.id, param(request, "skillId").trim());
    return reply.code(200).send(result);
  });
  app.get(
    "/api/agents/agent-versions/:agentVersionId/skills",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listPinnedSkills(org, user.id, param(request, "agentVersionId").trim());
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/agent-versions/:agentVersionId/skills/:skillVersionId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).pinSkill(
        org,
        user.id,
        param(request, "agentVersionId").trim(),
        param(request, "skillVersionId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/mcp/providers", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listMcpProviders(org, user.id);
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/installations/:installationId/mcp/catalog/:catalogId/connect",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).connectMcpCatalog(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "catalogId").trim(),
        requiredJson(request),
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/mcp/catalog/:catalogId/oauth/start",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).startMcpCatalogOAuth(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "catalogId").trim(),
        requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post("/api/agents/mcp/providers", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    objectBody(request, "MCP provider body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createMcpProvider(org, user.id, request.body);
    return reply.code(201).send(result);
  });
  app.post(
    "/api/agents/mcp/providers/:providerId/discover",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).discoverMcpProvider(org, user.id, param(request, "providerId").trim());
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/mcp/providers/:providerId/health",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).healthMcpProvider(org, user.id, param(request, "providerId").trim());
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/mcp/providers/:providerId/versions",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listMcpProviderVersions(
        org,
        user.id,
        param(request, "providerId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/mcp/providers/:providerId/versions/:versionId/publish",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).publishMcpProviderVersion(
        org,
        user.id,
        param(request, "providerId").trim(),
        param(request, "versionId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/mcp/providers/:providerId/revoke",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).revokeMcpProvider(org, user.id, param(request, "providerId").trim());
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/agent-versions/:agentVersionId/mcp-providers",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listPinnedMcpProviders(
        org,
        user.id,
        param(request, "agentVersionId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/agent-versions/:agentVersionId/mcp-providers/:providerVersionId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).pinMcpProvider(
        org,
        user.id,
        param(request, "agentVersionId").trim(),
        param(request, "providerVersionId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/integrations/catalog", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listIntegrationsCatalog(org, user.id);
    return reply.code(200).send(result);
  });
  app.get(
    "/api/agents/installations/:installationId/integrations",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationIntegrations(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/integrations/:integrationId/oauth/start",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).startGoogleOAuth(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "integrationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/integrations/:integrationId/api-key",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(request, "Integration API key body must be an object", false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).saveIntegrationApiKey(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "integrationId").trim(),
        requiredJson(request),
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/integrations/:integrationId/local-connector",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(
        request,
        "Integration connector body must be an object",
        false,
      );
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).saveIntegrationLocalConnector(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "integrationId").trim(),
        requiredJson(request),
      );
      return reply.code(201).send(result);
    },
  );
  app.get(
    "/api/agents/installations/:installationId/grants",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationGrants(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/connectors", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listConnectors(org, user.id);
    return reply.code(200).send(result);
  });
  app.get(
    "/api/agents/installations/:installationId/connectors",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationConnectors(
        org,
        user.id,
        param(request, "installationId").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/:agentId/versions", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listAgentVersions(org, user.id, param(request, "agentId"));
    return reply.code(200).send(result);
  });
  app.get("/api/agents/:agentId/deployment-status", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).getAgentDeploymentStatus(org, user.id, param(request, "agentId").trim());
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/installations/:installationId/preflight",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      objectBody(request, "Deployment preflight body must be an object", true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).preflightInstallationDeployment(
        org,
        user.id,
        param(request, "installationId").trim(),
        request.body === undefined ? {} : requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/deploy",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(request, "Installation deploy body must be an object", false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).deployInstallation(
        org,
        user.id,
        param(request, "installationId").trim(),
        requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/promote",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(
        request,
        "Installation promotion body must be an object",
        false,
      );
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).promoteInstallation(
        org,
        user.id,
        param(request, "installationId").trim(),
        request.body === undefined ? {} : requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/rollback",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      objectBody(request, "Installation rollback body must be an object", true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).rollbackInstallation(
        org,
        user.id,
        param(request, "installationId").trim(),
        request.body === undefined ? {} : requiredJson(request),
      );
      return reply.code(200).send(result);
    },
  );
  app.post("/api/agents/:agentId/archive", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).archiveAgent(org, user.id, param(request, "agentId"));
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/installations/:installationId/platform/conversation",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).resolvePlatformConversation(
        org,
        user.id,
        param(request, "installationId"),
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/platform/conversation/new",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).createPlatformConversation(
        org,
        user.id,
        param(request, "installationId"),
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/platform/conversations/clear",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).clearPlatformConversations(
        org,
        user.id,
        param(request, "installationId"),
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/audio/transcription-jobs/:jobId/retry",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).retryAudioTranscription(org, user.id, param(request, "jobId").trim());
      return reply.code(202).send(result);
    },
  );
  app.get("/api/agents/runs/:runId", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(core.config, options).getRun(
      org,
      user.id,
      param(request, "runId"),
    );
    return reply.code(200).send(result);
  });
  app.get("/api/agents/runs/:runId/timeline", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).getRunTimeline(org, user.id, param(request, "runId"));
    return reply.code(200).send(result);
  });
  app.post("/api/agents/runs/:runId/retry", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const result = await new AgentPlatformClient(core.config, options).retryRun(
      org,
      user.id,
      param(request, "runId"),
    );
    return reply.code(202).send(result);
  });
  app.post("/api/agents/runs/:runId/approval-group", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    objectBody(request, "Approval group body must be an object", false);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).approveRunGroup(org, user.id, param(request, "runId"), request.body);
    return reply.code(202).send(result);
  });

  app.post("/api/agents/kasiai/ensure", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const body = objectBody(request, "KasiAi settings must be an object", true);
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).ensureKasiai(org, user.id, body);
    return reply.code(200).send(result);
  });
  app.get("/api/agents", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, {});
    if (
      query.environment !== null &&
      query.environment !== undefined &&
      !["playground", "live"].includes(query.environment as string)
    )
      bad("Agent environment must be playground or live");
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listAgents(org, user.id, (query.environment as string | null) ?? null);
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/external-agents/:installationId/status/:status",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const status = param(request, "status");
      if (!["active", "paused", "disabled"].includes(status))
        bad("Invalid external-agent status");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).setExternalAgentStatus(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "status").trim(),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/operations/runs", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    checkLimit(query.limit, 200, "Run limit must be between 1 and 200");
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).operationsRuns(org, user.id, (query.limit as number | null) ?? null);
    return reply.code(200).send(result);
  });
  app.get(
    "/api/agents/operations/effects/reconciliation",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const query = validatedQuery(request, { limit: 32 });
      checkLimit(
        query.limit,
        500,
        "Reconciliation limit must be between 1 and 500",
      );
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).operationsEffectsReconciliation(
        org,
        user.id,
        (query.limit as number | null) ?? null,
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/operations/effects/:effectId/reconcile",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const body = objectBody(request, "Reconciliation body must be an object");
      if (body.outcome !== "succeeded" && body.outcome !== "failed")
        bad("Reconciliation outcome must be succeeded or failed");
      if (body.outcome === "failed" && !Object.hasOwn(body, "error"))
        bad("A failed reconciliation requires an error object");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).reconcileEffect(org, user.id, param(request, "effectId").trim(), body);
      return reply.code(202).send(result);
    },
  );
  app.post("/api/agents/operations/kill-switches", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    const body = objectBody(request, "Kill-switch body must be an object");
    if (
      !["organization", "agent", "installation", "tool"].includes(
        body.scopeType as string,
      )
    )
      bad("Kill-switch scopeType is invalid");
    requiredString(body, "scopeId", "Kill-switch scopeId is required");
    requiredString(body, "reason", "Kill-switch reason is required");
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createKillSwitch(org, user.id, body);
    return reply.code(201).send(result);
  });
  app.delete(
    "/api/agents/operations/kill-switches/:switchId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).disableKillSwitch(org, user.id, param(request, "switchId").trim());
      return reply.code(204).send();
    },
  );
  app.get(
    "/api/agents/installations/:installationId/runs",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const query = validatedQuery(request, { limit: 32 });
      checkLimit(query.limit, 200, "Run limit must be between 1 and 200");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).listInstallationRuns(
        org,
        user.id,
        param(request, "installationId").trim(),
        (query.limit as number | null) ?? null,
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/schedules",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const body = objectBody(request, "Schedule body must be an object");
      const expression = requiredString(
        body,
        "expression",
        "Schedule expression is required",
      );
      if (Buffer.byteLength(expression) > 240)
        bad("Schedule expression is too long");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).createInstallationSchedule(
        org,
        user.id,
        param(request, "installationId").trim(),
        body,
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/schedules/:scheduleId/status/:status",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const status = param(request, "status");
      if (!["active", "paused", "disabled"].includes(status))
        bad("Invalid schedule status");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).setScheduleStatus(
        org,
        user.id,
        param(request, "scheduleId").trim(),
        param(request, "status"),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/knowledge/sources", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    checkLimit(query.limit, 500, "Knowledge limit must be between 1 and 500");
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listKnowledgeSources(
      org,
      user.id,
      (query.agentId as string | null) ?? null,
      (query.installationId as string | null) ?? null,
      (query.limit as number | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.post("/api/agents/knowledge/sources", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    const body = objectBody(request, "Knowledge source body must be an object");
    requiredString(body, "agentId", "agentId is required");
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).createKnowledgeSource(org, user.id, body);
    return reply.code(201).send(result);
  });
  app.post(
    "/api/agents/knowledge/sources/:sourceId/ingest-url",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const body = objectBody(
        request,
        "Knowledge ingest body must be an object",
      );
      requiredString(body, "url", "url is required");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).ingestKnowledgeSourceUrl(
        org,
        user.id,
        param(request, "sourceId").trim(),
        body,
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/knowledge/sources/:sourceId/ingest-text",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const body = objectBody(
        request,
        "Knowledge ingest body must be an object",
      );
      requiredString(body, "text", "text is required");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).ingestKnowledgeSourceText(
        org,
        user.id,
        param(request, "sourceId").trim(),
        body,
      );
      return reply.code(201).send(result);
    },
  );
  app.delete(
    "/api/agents/knowledge/sources/:sourceId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const body = objectBody(
        request,
        "Knowledge deletion body must be an object",
        true,
      );
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).deleteKnowledgeSource(
        org,
        user.id,
        param(request, "sourceId").trim(),
        body,
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/memory", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    const agentId = requiredString(query, "agentId", "agentId is required");
    checkLimit(query.limit, 500, "Memory limit must be between 1 and 500");
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listMemory(
      org,
      user.id,
      agentId,
      (query.installationId as string | null) ?? null,
      (query.limit as number | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.get("/api/agents/conversations/handoffs", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listHandoffs(
      org,
      user.id,
      (query.installationId as string | null) ?? null,
      (query.agentId as string | null) ?? null,
      (query.channelType as string | null) ?? null,
      (query.reason as string | null) ?? null,
      (query.status as string | null) ?? null,
      (query.assignment as string | null) ?? null,
      (query.priority as string | null) ?? null,
      (query.search as string | null) ?? null,
      (query.limit as number | null) ?? null,
      (query.cursor as string | null) ?? null,
      (query.before as string | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.get("/api/agents/conversations/live", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listLiveConversations(
      org,
      user.id,
      (query.installationId as string | null) ?? null,
      (query.agentId as string | null) ?? null,
      (query.channelType as string | null) ?? null,
      (query.search as string | null) ?? null,
      (query.limit as number | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.get("/api/agents/conversations/customer", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listCustomerConversations(
      org,
      user.id,
      (query.installationId as string | null) ?? null,
      (query.agentId as string | null) ?? null,
      (query.channelType as string | null) ?? null,
      (query.search as string | null) ?? null,
      (query.limit as number | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.get("/api/agents/conversations/summary", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).getConversationSummary(
      org,
      user.id,
      (query.installationId as string | null) ?? null,
      (query.agentId as string | null) ?? null,
      (query.channelType as string | null) ?? null,
      (query.search as string | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/conversations/:conversationId/status/:status",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const status = param(request, "status");
      if (!["archived", "deleted"].includes(status))
        bad("Unsupported conversation status");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).setConversationStatus(
        org,
        user.id,
        param(request, "conversationId"),
        param(request, "status"),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/audit", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, { limit: 32 });
    checkLimit(query.limit, 500, "Audit limit must be between 1 and 500");
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listAudit(
      org,
      user.id,
      (query.action as string | null) ?? null,
      (query.resourceType as string | null) ?? null,
      (query.limit as number | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.post(
    "/api/agents/installations/:installationId/status/:status",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const status = param(request, "status");
      if (!["active", "paused", "disabled"].includes(status))
        bad("Invalid installation status");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).setInstallationStatus(
        org,
        user.id,
        param(request, "installationId"),
        param(request, "status"),
      );
      return reply.code(200).send(result);
    },
  );
  app.get("/api/agents/skills/directory", async (request, reply) => {
    const { user, org } = await agentScope(request, core, false);
    const query = validatedQuery(request, {});
    const result = await new AgentPlatformClient(
      core.config,
      options,
    ).listSkillDirectory(
      org,
      user.id,
      (query.agentVersionId as string | null) ?? null,
    );
    return reply.code(200).send(result);
  });
  app.delete(
    "/api/agents/agent-versions/:agentVersionId/skills/:skillVersionId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).unpinSkill(
        org,
        user.id,
        param(request, "agentVersionId").trim(),
        param(request, "skillVersionId").trim(),
      );
      return reply.code(204).send();
    },
  );
  app.delete(
    "/api/agents/agent-versions/:agentVersionId/mcp-providers/:providerVersionId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).unpinMcpProvider(
        org,
        user.id,
        param(request, "agentVersionId").trim(),
        param(request, "providerVersionId").trim(),
      );
      return reply.code(204).send();
    },
  );
  app.delete(
    "/api/agents/installations/:installationId/integrations/:integrationId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).disconnectIntegration(
        org,
        user.id,
        param(request, "installationId").trim(),
        param(request, "integrationId").trim(),
      );
      return reply.code(204).send();
    },
  );
  app.post(
    "/api/agents/installations/:installationId/tools",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const toolName = requiredString(
        request.body,
        "toolName",
        "toolName is required",
      );
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).grantInstallationTool(
        org,
        user.id,
        param(request, "installationId").trim(),
        toolName,
      );
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/grants/resources",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const body = objectBody(request, "Resource grant body must be an object");
      if (!nonempty(body.resourceType) || !nonempty(body.resourceId))
        bad("resourceType and resourceId are required");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).grantInstallationResource(
        org,
        user.id,
        param(request, "installationId").trim(),
        body,
      );
      return reply.code(200).send(result);
    },
  );
  app.post(
    "/api/agents/installations/:installationId/grants/connectors",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const body = canonicalJsonBody(request);
      requiredString(body, "connectorId", "connectorId is required");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).grantInstallationConnector(
        org,
        user.id,
        param(request, "installationId").trim(),
        body,
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/agent-versions/:agentVersionId/effective-config",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const query = validatedQuery(request, {});
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getAgentVersionEffectiveConfig(
        org,
        user.id,
        param(request, "agentVersionId").trim(),
        (query.installationId as string | null) ?? null,
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/conversations/:conversationId",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const query = validatedQuery(request, { limit: 32 });
      checkLimit(
        query.limit,
        200,
        "Conversation message limit must be between 1 and 200",
      );
      if (
        query.before !== null &&
        query.before !== undefined &&
        !validUint(String(query.before), 64)
      )
        bad("Conversation cursor is invalid");
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getConversation(
        org,
        user.id,
        param(request, "conversationId"),
        (query.limit as number | null) ?? null,
        (query.before as string | null) ?? null,
      );
      return reply.code(200).send(result);
    },
  );
  app.get(
    "/api/agents/runs/:runId/memory-observatory",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, false);
      const query = validatedQuery(request, { limit: 32, afterSequence: 64 });
      checkLimit(
        query.limit,
        200,
        "Memory observatory limit must be between 1 and 200",
      );
      const result = await new AgentPlatformClient(
        core.config,
        options,
      ).getRunMemoryObservatory(
        org,
        user.id,
        param(request, "runId").trim(),
        (query.afterSequence as bigint | null) ?? null,
        (query.limit as number | null) ?? null,
      );
      return reply.code(200).send(result);
    },
  );
  for (const provider of ["mcp", "google", "microsoft"] as const) {
    app.get(
      `/api/agents/integrations/${provider}/oauth/callback`,
      async (request, reply) => {
        const client = new AgentPlatformClient(core.config, options);
        const query = request.raw.url?.split("?").slice(1).join("?") ?? "";
        const value = await (provider === "mcp"
          ? client.completeMcpOAuthCallback(query)
          : provider === "google"
            ? client.completeGoogleOAuthCallback(query)
            : client.completeMicrosoftOAuthCallback(query));
        let target: URL;
        try {
          target = new URL(
            core.config.frontendUrl.replace(/\/+$/, "") + "/studio",
          );
        } catch (error) {
          throw new ApiError(
            500,
            "internal_error",
            `Invalid frontend URL: ${error}`,
          );
        }
        const result = value as Record<string, unknown> | null;
        for (const key of [
          "connection",
          "integration",
          "status",
          "installationId",
          "error",
        ]) {
          if (typeof result?.[key] === "string")
            target.searchParams.append(key, result[key] as string);
        }
        if (
          result &&
          Object.hasOwn(result, "error") &&
          !Object.hasOwn(result, "status")
        )
          target.searchParams.append("status", "error");
        return reply
          .code(302)
          .header("cache-control", "no-store")
          .header("location", target.toString())
          .send();
      },
    );
  }
  app.delete("/api/agents/:agentId", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    const response = await new AgentPlatformClient(
      core.config,
      options,
    ).deleteAgent(org, user.id, param(request, "agentId").trim());
    const ids = (response as Record<string, unknown> | null)?.installationIds;
    if (Array.isArray(ids))
      await website.deleteAgentWebsiteDeployments(
        core.pool,
        org,
        ids.filter((id): id is string => typeof id === "string"),
      );
    return reply.send(response);
  });
  app.post("/api/agents/installations", async (request, reply) => {
    const { user, org } = await agentScope(request, core, true);
    const body = objectBody(
      request,
      "Installation body must be an object",
      true,
    );
    if (!Object.hasOwn(body, "scopeType")) body.scopeType = "organization";
    if (!Object.hasOwn(body, "scopeId")) body.scopeId = org;
    if (!Object.hasOwn(body, "settings")) body.settings = {};
    return reply
      .code(201)
      .send(
        await new AgentPlatformClient(core.config, options).createInstallation(
          org,
          user.id,
          body,
        ),
      );
  });
  app.patch(
    "/api/agents/installations/:installationId/settings",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true);
      const settings = objectBody(
        request,
        "Installation settings must be an object",
      );
      if (
        Object.keys(settings).some(
          (key) =>
            ![
              "language",
              "tone",
              "responseDetail",
              "notificationsEnabled",
            ].includes(key),
        )
      )
        bad("Unsupported installation setting");
      if (!Object.keys(settings).length)
        bad("At least one installation setting is required");
      if (
        typeof settings.language === "string" &&
        ([...settings.language].length < 2 ||
          [...settings.language].length > 20)
      )
        bad("Language must be between 2 and 20 characters");
      if (
        typeof settings.tone === "string" &&
        !["concise", "balanced", "detailed"].includes(settings.tone)
      )
        bad("Invalid tone");
      if (
        typeof settings.responseDetail === "string" &&
        !["concise", "standard", "detailed"].includes(settings.responseDetail)
      )
        bad("Invalid response detail");
      if (
        Object.hasOwn(settings, "notificationsEnabled") &&
        typeof settings.notificationsEnabled !== "boolean"
      )
        bad("notificationsEnabled must be boolean");
      return reply.send(
        await new AgentPlatformClient(
          core.config,
          options,
        ).setInstallationSettings(
          org,
          user.id,
          param(request, "installationId"),
          settings,
        ),
      );
    },
  );
  for (const action of ["publish", "rollback", "retire"] as const) {
    app.post(
      `/api/agents/:agentId/versions/:versionId/${action}`,
      async (request, reply) => {
        const { user, org } = await agentScope(request, core, true);
        const client = new AgentPlatformClient(core.config, options),
          agent = param(request, "agentId"),
          version = param(request, "versionId");
        return reply.send(
          await (action === "publish"
            ? client.publishAgentVersion(org, user.id, agent, version)
            : action === "rollback"
              ? client.rollbackAgentVersion(org, user.id, agent, version)
              : client.retireAgentVersion(org, user.id, agent, version)),
        );
      },
    );
  }
  app.post(
    "/api/agents/conversations/handoffs/:handoffId/messages",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core);
      const body = objectBody(
        request,
        "Human message body must be an object",
        true,
      );
      const header = request.headers["idempotency-key"];
      const key = nonempty(header)
        ? header.trim()
        : nonempty(body.idempotencyKey)
          ? body.idempotencyKey.trim()
          : bad("idempotency-key is required");
      body.idempotencyKey = key;
      return reply.send(
        await new AgentPlatformClient(core.config, options).sendHumanMessage(
          org,
          user.id,
          param(request, "handoffId").trim(),
          body,
          key,
        ),
      );
    },
  );
  app.post(
    "/api/agents/installations/:installationId/platform/messages",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core);
      return reply
        .code(202)
        .send(
          await new AgentPlatformClient(
            core.config,
            options,
          ).sendPlatformMessage(
            org,
            user.id,
            param(request, "installationId"),
            sanitizeMessageBody(canonicalJsonBody(request)),
          ),
        );
    },
  );
  app.post("/api/agents/runs/:runId/cancel", async (request, reply) => {
    const { user, org } = await agentScope(request, core);
    const value = (request.body as Record<string, unknown> | null)?.reason;
    const reason = typeof value === "string" ? value : "";
    if (Buffer.byteLength(reason) > 500) bad("Cancellation reason is too long");
    return reply
      .code(202)
      .send(
        await new AgentPlatformClient(core.config, options).cancelRun(
          org,
          user.id,
          param(request, "runId"),
          { reason },
        ),
      );
  });
  app.post("/api/agents/runs/:runId/external-event", async (request, reply) => {
    const { user, org } = await agentScope(request, core);
    const body = objectBody(request, "External event body must be an object");
    const key = requiredString(body, "key", "External event key is required");
    if (Buffer.byteLength(key) > 160) bad("External event key is too long");
    if (
      Object.hasOwn(body, "payload") &&
      (!body.payload ||
        typeof body.payload !== "object" ||
        Array.isArray(body.payload))
    )
      bad("External event payload must be an object");
    return reply
      .code(202)
      .send(
        await new AgentPlatformClient(core.config, options).signalExternalEvent(
          org,
          user.id,
          param(request, "runId"),
          body,
        ),
      );
  });
  for (const kind of ["feed", "conversation", "run"] as const) {
    const path =
      kind === "feed"
        ? "/api/agents/conversations/events/stream"
        : kind === "conversation"
          ? "/api/agents/conversations/:conversationId/events/stream"
          : "/api/agents/runs/:runId/events/stream";
    app.get(path, async (request, reply) => {
      const { user, org } = await agentScope(request, core);
      const query = validatedQuery(request, { after: 64 }),
        client = new AgentPlatformClient(core.config, options);
      const response = await (kind === "feed"
        ? client.streamConversationFeedEvents(org, user.id)
        : kind === "conversation"
          ? client.streamConversationEvents(
              org,
              user.id,
              param(request, "conversationId"),
              (query.after as bigint | undefined) ?? null,
            )
          : client.streamRunEvents(
              org,
              user.id,
              param(request, "runId"),
              (query.after as bigint | undefined) ?? null,
            ));
      return reply
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache, no-transform")
        .header("connection", "keep-alive")
        .header("x-accel-buffering", "no")
        .send(response.body ? Readable.fromWeb(response.body as never) : null);
    });
  }

  app.get(
    "/api/agents/installations/:installationId/website-deployments",
    async (request, reply) => {
      const { org } = await agentScope(request, core);
      const deployments = await website.listAgentWebsiteDeployments(
        core.pool,
        org,
        param(request, "installationId").trim(),
      );
      const base = core.config.publicApiUrl.replace(/\/+$/, "");
      return reply.send({
        deployments: deployments.map((deployment) => ({
          ...deployment,
          shareUrl: `${base}/api/widget/v1/share/${deployment.publicId}`,
          embedCode: `<script async src="${base}/api/widget/v1/loader.js" data-kasitek-deployment="${deployment.publicId}"></script>`,
        })),
      });
    },
  );
  app.post(
    "/api/agents/installations/:installationId/website-deployments",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true),
        input = deploymentBody(request),
        installation = param(request, "installationId").trim(),
        publicId = `wdg_${createId()}`;
      const channel = await new AgentPlatformClient(
        core.config,
        options,
      ).ensureChannelConnection(org, user.id, installation, {
        channelType: "website",
        channelKey: publicId,
        metadata: { surface: "website-chat", publicDeploymentId: publicId },
      });
      const id = (channel as Record<string, unknown> | null)?.id;
      if (typeof id !== "string")
        throw new ApiError(
          500,
          "internal_error",
          "Agent website channel response is invalid",
        );
      const deployment = await website.createAgentWebsiteDeployment(
        core.pool,
        org,
        installation,
        id,
        publicId,
        user.id,
        input,
      );
      const base = core.config.publicApiUrl.replace(/\/+$/, "");
      return reply.code(201).send({
        deployment,
        embedCode: `<script async src="${base}/api/widget/v1/loader.js" data-kasitek-deployment="${publicId}"></script>`,
        shareUrl: `${base}/api/widget/v1/share/${publicId}`,
      });
    },
  );
  app.patch(
    "/api/agents/installations/:installationId/website-deployments/:deploymentId",
    async (request, reply) => {
      const { org } = await agentScope(request, core, true);
      return reply.send({
        deployment: await website.updateAgentWebsiteDeployment(
          core.pool,
          org,
          param(request, "installationId").trim(),
          param(request, "deploymentId").trim(),
          deploymentBody(request),
        ),
      });
    },
  );
  app.post(
    "/api/agents/installations/:installationId/website-deployments/:deploymentId/status/:status",
    async (request, reply) => {
      const { org } = await agentScope(request, core, true);
      return reply.send({
        deployment: await website.setAgentWebsiteDeploymentStatus(
          core.pool,
          org,
          param(request, "installationId").trim(),
          param(request, "deploymentId").trim(),
          param(request, "status")
            .trim()
            .replace(/[a-z]/g, (c) => c.toUpperCase()),
        ),
      });
    },
  );
  app.post(
    "/api/agents/installations/:installationId/channels",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core, true),
        body = objectBody(request, "Channel connection body must be an object");
      const channelType = requiredString(
        body,
        "channelType",
        "channelType is required",
      ).replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (
        ![
          "whatsapp",
          "facebook",
          "instagram",
          "telegram",
          "discord",
          "website",
        ].includes(channelType)
      )
        bad(`Unsupported agent channel: ${channelType}`);
      if (
        !["telegram", "discord"].includes(channelType) &&
        !nonempty(body.channelKey)
      )
        bad("channelKey is required for this channel");
      if (["facebook", "instagram"].includes(channelType)) {
        const key =
          typeof body.channelKey === "string" ? body.channelKey.trim() : "";
        const provider = channelType === "instagram" ? "INSTAGRAM" : "FACEBOOK";
        const connected = await core.pool.query<{ connected: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM "ExternalConnection" WHERE id=$1 AND "orgId"=$2 AND provider::text=$3 AND status='CONNECTED'::"ExternalConnectionStatus") AS connected`,
          [key, org, provider],
        );
        if (!connected.rows[0]?.connected)
          throw new ApiError(
            409,
            "conflict",
            "This Meta account is no longer connected. Reconnect it before assigning it to an agent.",
          );
        const metadata = body.metadata;
        if (
          metadata &&
          typeof metadata === "object" &&
          !(metadata instanceof SerdeFloat) &&
          !Array.isArray(metadata)
        ) {
          const metadataId = (metadata as Record<string, unknown>)
            .coreConnectionId;
          if (typeof metadataId === "string" && metadataId.trim() !== key)
            bad("coreConnectionId must match channelKey");
        }
      }
      if (
        ["telegram", "discord"].includes(channelType) &&
        !nonempty(body.credentialSecret) &&
        !nonempty(body.credentialReference)
      )
        bad(
          channelType === "telegram"
            ? "A Telegram bot token is required"
            : "A Discord bot token is required",
        );
      body.channelType = channelType;
      if (["facebook", "instagram"].includes(channelType)) {
        if (!Object.hasOwn(body, "metadata")) body.metadata = {};
        if (
          body.metadata &&
          typeof body.metadata === "object" &&
          !(body.metadata instanceof SerdeFloat) &&
          !Array.isArray(body.metadata)
        )
          Object.assign(body.metadata, {
            coreConnectionId:
              typeof body.channelKey === "string" ? body.channelKey : "",
            provider: channelType === "instagram" ? "INSTAGRAM" : "FACEBOOK",
            routing: "public",
          });
      }
      return reply
        .code(201)
        .send(
          await new AgentPlatformClient(
            core.config,
            options,
          ).ensureChannelConnection(
            org,
            user.id,
            param(request, "installationId").trim(),
            body,
          ),
        );
    },
  );
  app.post(
    "/api/agents/kasiai/channels/whatsapp/pairing",
    async (request, reply) => {
      const { user, org } = await agentScope(request, core);
      const body = objectBody(request, "Invalid pairing request");
      if (typeof body.connectionId !== "string") bad("Invalid pairing request");
      const connectionId = body.connectionId.trim();
      const connections = await listWhatsappConnections(core.pool, org);
      if (!connections.some((connection) => connection.id === connectionId))
        throw new ApiError(404, "not_found", "WhatsApp connection not found");
      const client = new AgentPlatformClient(core.config, options),
        installation = await client.ensureKasiai(org, user.id, {}),
        installationId = (installation as Record<string, unknown> | null)?.id;
      if (typeof installationId !== "string")
        throw new ApiError(
          500,
          "internal_error",
          "KasiAi installation response is invalid",
        );
      const channel = await client.ensureChannelConnection(
        org,
        user.id,
        installationId,
        {
          channelType: "whatsapp",
          channelKey: connectionId,
          metadata: { coreConnectionId: connectionId },
        },
      );
      const channelId = (channel as Record<string, unknown> | null)?.id;
      if (typeof channelId !== "string")
        throw new ApiError(
          500,
          "internal_error",
          "Agent channel response is invalid",
        );
      const pairing = await client.issueChannelPairing(
        org,
        user.id,
        installationId,
        channelId,
      );
      return reply.code(201).send({
        installationId,
        channel,
        pairing,
        instruction:
          "Send the one-time pairing code as a WhatsApp message to the connected KasiTek number.",
      });
    },
  );
  app.register(async (raw) => {
    raw.addHook("onRequest", async (request) => {
      await agentScope(
        request,
        core,
        request.url.includes("/knowledge/sources/"),
      );
    });
    raw.setErrorHandler((error, request, reply) => {
      if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
        return reply.code(400).send({
          error: request.url.includes("/knowledge/sources/")
            ? "Knowledge file upload exceeds the 20 MB limit"
            : "Audio must be 25 MB or smaller",
          code: "bad_request",
        });
      return app.errorHandler(error, request, reply);
    });
    raw.addHook("preParsing", (request, _reply, payload, done) => {
      const knowledge = request.url.includes("/knowledge/sources/");
      done(
        null,
        guardRawPayload(
          payload,
          (knowledge ? 22 : 25) * 1024 * 1024,
          knowledge
            ? "Knowledge file upload exceeds the 20 MB limit"
            : "Audio must be 25 MB or smaller",
        ),
      );
    });
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    raw.post(
      "/api/agents/knowledge/sources/:sourceId/ingest-file",
      { bodyLimit: 22 * 1024 * 1024 },
      async (request, reply) => {
        const { user, org } = await agentScope(request, core, true);
        const body = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
        return reply
          .code(201)
          .send(
            await new AgentPlatformClient(
              core.config,
              options,
            ).ingestKnowledgeSourceFile(
              org,
              user.id,
              param(request, "sourceId").trim(),
              headerValue(request, "content-type") ??
                "application/octet-stream",
              body,
            ),
          );
      },
    );
    raw.post(
      "/api/agents/installations/:installationId/platform/audio",
      { bodyLimit: 25 * 1024 * 1024 },
      async (request, reply) => {
        const { user, org } = await agentScope(request, core);
        const mime = (headerValue(request, "content-type") ?? "")
          .split(";")[0]!
          .trim();
        if (
          ![
            "audio/aac",
            "audio/flac",
            "audio/m4a",
            "audio/mp4",
            "audio/mpeg",
            "audio/ogg",
            "audio/opus",
            "audio/wav",
            "audio/webm",
            "application/ogg",
          ].includes(mime)
        )
          bad("A supported audio MIME type is required");
        const key = headerValue(request, "x-audio-idempotency-key")?.trim();
        if (!key || Buffer.byteLength(key) < 8 || Buffer.byteLength(key) > 240)
          bad("A valid audio idempotency key is required");
        const conversation = headerValue(
          request,
          "x-audio-conversation-id",
        )?.trim();
        if (!conversation || Buffer.byteLength(conversation) > 64)
          bad("A conversation is required for audio messages");
        let fileName: string | null = null;
        try {
          const value = headerValue(request, "x-audio-file-name");
          if (value !== null) fileName = decodeURIComponent(value);
        } catch {}
        const optional = (header: string, max: number) => {
          const value = headerValue(request, header)?.trim();
          return value && [...value].length <= max ? value : null;
        };
        const bytes = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
        if (!bytes?.length) bad("Audio is required");
        if (!validAudioSignature(bytes, mime))
          bad("Audio contents do not match the declared format");
        return reply
          .code(202)
          .send(
            await new AgentPlatformClient(
              core.config,
              options,
            ).sendPlatformAudio(
              org,
              user.id,
              param(request, "installationId"),
              bytes,
              mime,
              fileName,
              key,
              conversation,
              optional("x-audio-caption", 4000),
              optional("x-audio-context-route", 500),
              optional("x-audio-context-title", 240),
            ),
          );
      },
    );
  });
}
