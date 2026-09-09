import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import {
  discoverRemoteMcpTools,
  remoteMcpToolsSchema,
  remoteMcpToolName,
  resolveRemoteMcpAuthorizationToken,
  validateRemoteMcpEndpoint,
  type RemoteMcpTool,
} from "../../mcp/remote";
import { createMcpServerSnapshot, McpOperationCoordinator } from "../../mcp/operation-boundary";
import { z } from "zod";
import type { ToolInvocationContext } from "../../tools/types";
import type { ToolRegistry } from "../../tools/registry";
import { recordRemoteMcpOperation } from "../../telemetry/spans";
import { DurableOperationCoordinator } from "../../operations/durable-operation";
import { DurableOperationRepository } from "./durable-operation-repository";

export const createRemoteMcpProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  endpointUrl: z.string().trim().url().max(2_000),
  catalogId: z.string().trim().min(1).max(180).optional(),
  credentialReference: z.string().uuid().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  maxResponseBytes: z.number().int().min(1_024).max(1_048_576).default(1_048_576),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(60),
}).strict();
export type CreateRemoteMcpProviderInput = z.infer<typeof createRemoteMcpProviderInputSchema>;

export interface RemoteMcpProviderRecord {
  id: string;
  organization_id: string;
  owner_type: "organization" | "user";
  owner_id: string;
  name: string;
  endpoint_url: string;
  catalog_id: string | null;
  credential_reference: string | null;
  status: "draft" | "approved" | "revoked";
  timeout_ms: number;
  max_response_bytes: number;
  rate_limit_per_minute: number;
  health_status: "unknown" | "healthy" | "unhealthy";
  health_checked_at: string | null;
  health_last_success_at: string | null;
  health_latency_ms: number | null;
  health_failure_code: string | null;
  health_consecutive_failures: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RemoteMcpProviderVersionRecord {
  id: string;
  provider_id: string;
  organization_id: string;
  revision: number;
  status: "draft" | "published" | "revoked";
  protocol_version: string;
  tools: RemoteMcpTool[];
  checksum: string;
  created_by: string;
  created_at: string;
  published_at: string | null;
  provider_name?: string;
  endpoint_url?: string;
  credential_reference?: string | null;
  timeout_ms?: number;
  max_response_bytes?: number;
  rate_limit_per_minute?: number;
}

export function isCustomRemoteMcpProvider(provider: Pick<RemoteMcpProviderRecord, "catalog_id">): boolean {
  return provider.catalog_id === null;
}

export class RemoteMcpProviderRepository {
  private readonly operations: DurableOperationCoordinator;

  public constructor(
    private readonly pool: Pool,
    private readonly resolveCredential?: (organizationId: string, credentialReference: string) => Promise<string>,
    operationCoordinator?: DurableOperationCoordinator,
  ) {
    this.operations = operationCoordinator ?? new DurableOperationCoordinator(new DurableOperationRepository(pool));
  }

  public async create(organizationId: string, actorId: string, input: CreateRemoteMcpProviderInput): Promise<RemoteMcpProviderRecord> {
    const parsed = createRemoteMcpProviderInputSchema.parse(input);
    validateRemoteMcpEndpoint(parsed.endpointUrl, process.env.NODE_ENV === "production" ? "production" : "development");
    const result = await query<RemoteMcpProviderRecord>(this.pool, `INSERT INTO agent_mcp_providers (organization_id, owner_id, name, catalog_id, endpoint_url, credential_reference, timeout_ms, max_response_bytes, rate_limit_per_minute, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, [organizationId, organizationId, parsed.name, parsed.catalogId ?? null, parsed.endpointUrl, parsed.credentialReference ?? null, parsed.timeoutMs, parsed.maxResponseBytes, parsed.rateLimitPerMinute, actorId]);
    if (!result.rows[0]) throw new Error("REMOTE_MCP_PROVIDER_CREATE_FAILED");
    return result.rows[0];
  }

  public async list(organizationId: string): Promise<RemoteMcpProviderRecord[]> {
    const result = await query<RemoteMcpProviderRecord>(this.pool, "SELECT * FROM agent_mcp_providers WHERE organization_id = $1 AND status <> 'revoked' ORDER BY name", [organizationId]);
    return result.rows;
  }

  public async getByCatalogId(organizationId: string, catalogId: string): Promise<RemoteMcpProviderRecord | null> {
    const result = await query<RemoteMcpProviderRecord>(this.pool, "SELECT * FROM agent_mcp_providers WHERE organization_id = $1 AND catalog_id = $2 AND status <> 'revoked'", [organizationId, catalogId]);
    return result.rows[0] ?? null;
  }

  public async setCredentialReference(organizationId: string, providerId: string, credentialReference: string | null): Promise<RemoteMcpProviderRecord> {
    const result = await query<RemoteMcpProviderRecord>(this.pool, "UPDATE agent_mcp_providers SET credential_reference = $1, updated_at = now() WHERE id = $2 AND organization_id = $3 AND status <> 'revoked' RETURNING *", [credentialReference, providerId, organizationId]);
    if (!result.rows[0]) throw new Error("REMOTE_MCP_PROVIDER_NOT_FOUND");
    return result.rows[0];
  }

  public async discover(organizationId: string, actorId: string, providerId: string): Promise<RemoteMcpProviderVersionRecord> {
    const provider = await this.get(organizationId, providerId);
    if (!provider || provider.status === "revoked") throw new Error("REMOTE_MCP_PROVIDER_NOT_FOUND");
    const authorizationToken = provider.credential_reference && this.resolveCredential
      ? resolveRemoteMcpAuthorizationToken(await this.resolveCredential(organizationId, provider.credential_reference))
      : undefined;
    const startedAt = performance.now();
    let discovered;
    try {
      discovered = await discoverRemoteMcpTools({ endpointUrl: provider.endpoint_url, authorizationToken, timeoutMs: provider.timeout_ms, maxResponseBytes: provider.max_response_bytes, environment: process.env.NODE_ENV === "production" ? "production" : "development" });
      await this.recordHealthSuccess(organizationId, providerId, performance.now() - startedAt);
      recordRemoteMcpOperation({ operation: "discovery", outcome: "success", durationMs: performance.now() - startedAt });
    } catch (error) {
      await this.recordHealthFailure(organizationId, providerId, error, performance.now() - startedAt);
      recordRemoteMcpOperation({ operation: "discovery", outcome: "error", durationMs: performance.now() - startedAt, errorCode: remoteMcpErrorCode(error) });
      throw error;
    }
    return withTransaction(this.pool, async (client) => {
      const next = await client.query<{ revision: number }>("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM agent_mcp_provider_versions WHERE provider_id = $1", [providerId]);
      const revision = Number(next.rows[0]!.revision);
      const checksum = createHash("sha256").update(JSON.stringify({ providerId, revision, protocolVersion: discovered.protocolVersion, tools: discovered.tools })).digest("hex");
      const result = await client.query<RemoteMcpProviderVersionRecord>(`INSERT INTO agent_mcp_provider_versions (provider_id, organization_id, revision, protocol_version, tools, checksum, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`, [providerId, organizationId, revision, discovered.protocolVersion, JSON.stringify(discovered.tools), checksum, actorId]);
      if (!result.rows[0]) throw new Error("REMOTE_MCP_PROVIDER_DISCOVERY_FAILED");
      return hydrateVersion(result.rows[0]);
    });
  }

  /** Probe the current provider endpoint without creating or publishing a revision. */
  public async healthCheck(organizationId: string, providerId: string): Promise<RemoteMcpProviderRecord> {
    const provider = await this.get(organizationId, providerId);
    if (!provider || provider.status === "revoked") throw new Error("REMOTE_MCP_PROVIDER_NOT_FOUND");
    const authorizationToken = provider.credential_reference && this.resolveCredential
      ? resolveRemoteMcpAuthorizationToken(await this.resolveCredential(organizationId, provider.credential_reference))
      : undefined;
    const startedAt = performance.now();
    try {
      await discoverRemoteMcpTools({ endpointUrl: provider.endpoint_url, authorizationToken, timeoutMs: provider.timeout_ms, maxResponseBytes: provider.max_response_bytes, environment: process.env.NODE_ENV === "production" ? "production" : "development" });
      const updated = await this.recordHealthSuccess(organizationId, providerId, performance.now() - startedAt);
      recordRemoteMcpOperation({ operation: "health_check", outcome: "success", durationMs: performance.now() - startedAt });
      return updated;
    } catch (error) {
      const updated = await this.recordHealthFailure(organizationId, providerId, error, performance.now() - startedAt);
      recordRemoteMcpOperation({ operation: "health_check", outcome: "error", durationMs: performance.now() - startedAt, errorCode: remoteMcpErrorCode(error) });
      if (error instanceof Error) Object.assign(error, { health: updated });
      throw error;
    }
  }

  public async publish(organizationId: string, actorId: string, providerId: string, versionId: string): Promise<RemoteMcpProviderVersionRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<RemoteMcpProviderVersionRecord>(`UPDATE agent_mcp_provider_versions version SET status = 'published', published_at = COALESCE(published_at, now()) WHERE version.id = $1 AND version.provider_id = $2 AND version.organization_id = $3 AND version.status = 'draft' AND EXISTS (SELECT 1 FROM agent_mcp_providers provider WHERE provider.id = version.provider_id AND provider.organization_id = version.organization_id AND provider.health_status = 'healthy') RETURNING version.*`, [versionId, providerId, organizationId]);
      if (!result.rows[0]) throw new Error("REMOTE_MCP_PROVIDER_VERSION_NOT_FOUND_OR_NOT_DRAFT_OR_UNHEALTHY");
      await client.query("UPDATE agent_mcp_providers SET status = 'approved', updated_at = now() WHERE id = $1 AND organization_id = $2", [providerId, organizationId]);
      await client.query("INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata) VALUES ($1, 'human', $2, 'remote_mcp_provider.approved', 'remote_mcp_provider_version', $3, $4::jsonb)", [organizationId, actorId, versionId, JSON.stringify({ providerId, toolCount: hydrateVersion(result.rows[0]).tools.length })]);
      return hydrateVersion(result.rows[0]);
    });
  }

  public async revoke(organizationId: string, actorId: string, providerId: string): Promise<void> {
    const result = await query(this.pool, "UPDATE agent_mcp_providers SET status = 'revoked', updated_at = now() WHERE id = $1 AND organization_id = $2 AND status <> 'revoked'", [providerId, organizationId]);
    if (!result.rowCount) throw new Error("REMOTE_MCP_PROVIDER_NOT_FOUND");
    await query(this.pool, "UPDATE agent_mcp_provider_versions SET status = 'revoked' WHERE provider_id = $1 AND organization_id = $2 AND status <> 'revoked'", [providerId, organizationId]);
    await query(this.pool, "INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata) VALUES ($1, 'human', $2, 'remote_mcp_provider.revoked', 'remote_mcp_provider', $3, '{}'::jsonb)", [organizationId, actorId, providerId]);
  }

  public async listVersions(organizationId: string, providerId: string): Promise<RemoteMcpProviderVersionRecord[]> {
    const result = await query<RemoteMcpProviderVersionRecord>(this.pool, `SELECT version.*, provider.name AS provider_name, provider.endpoint_url, provider.credential_reference, provider.timeout_ms, provider.max_response_bytes FROM agent_mcp_provider_versions version JOIN agent_mcp_providers provider ON provider.id = version.provider_id WHERE version.provider_id = $1 AND version.organization_id = $2 ORDER BY version.revision DESC`, [providerId, organizationId]);
    return result.rows.map(hydrateVersion);
  }

  public async pin(organizationId: string, actorId: string, agentVersionId: string, providerVersionId: string): Promise<void> {
    const result = await query(this.pool, `INSERT INTO agent_version_mcp_providers (organization_id, agent_version_id, provider_version_id, pinned_by) SELECT $1, version.id, provider_version.id, $2 FROM agent_versions version JOIN agent_definitions definition ON definition.id = version.agent_definition_id JOIN agent_mcp_provider_versions provider_version ON provider_version.id = $4 AND provider_version.status = 'published' JOIN agent_mcp_providers provider ON provider.id = provider_version.provider_id AND provider.status = 'approved' AND provider.health_status = 'healthy' WHERE version.id = $3 AND definition.organization_id = $1 AND provider.organization_id = $1 ON CONFLICT DO NOTHING`, [organizationId, actorId, agentVersionId, providerVersionId]);
    if (!result.rowCount) throw new Error("REMOTE_MCP_PROVIDER_VERSION_NOT_FOUND_OR_NOT_PUBLISHED_OR_UNHEALTHY");
  }

  public async unpin(organizationId: string, agentVersionId: string, providerVersionId: string): Promise<void> {
    const result = await query(this.pool, "DELETE FROM agent_version_mcp_providers WHERE organization_id = $1 AND agent_version_id = $2 AND provider_version_id = $3", [organizationId, agentVersionId, providerVersionId]);
    if (!result.rowCount) throw new Error("REMOTE_MCP_PROVIDER_PIN_NOT_FOUND");
  }

  public async listPinned(organizationId: string, agentVersionId: string): Promise<RemoteMcpProviderVersionRecord[]> {
    const result = await query<RemoteMcpProviderVersionRecord>(this.pool, `SELECT provider_version.*, provider.name AS provider_name, provider.endpoint_url, provider.credential_reference, provider.timeout_ms, provider.max_response_bytes FROM agent_version_mcp_providers pin JOIN agent_mcp_provider_versions provider_version ON provider_version.id = pin.provider_version_id JOIN agent_mcp_providers provider ON provider.id = provider_version.provider_id WHERE pin.organization_id = $1 AND pin.agent_version_id = $2 AND provider.status = 'approved' AND provider.health_status = 'healthy' AND provider_version.status = 'published' ORDER BY provider.name`, [organizationId, agentVersionId]);
    return result.rows.map(hydrateVersion);
  }

  /** Register only explicitly pinned provider tools in the run's shared registry. */
  public async registerPinnedTools(organizationId: string, agentVersionId: string, registry: ToolRegistry): Promise<string[]> {
    const providers = await this.listPinned(organizationId, agentVersionId);
    const names: string[] = [];
    for (const provider of providers) {
      const catalogVersion = `${provider.revision}.0.0`;
      const catalogSource = {
        kind: "mcp" as const,
        id: provider.id,
        version: catalogVersion,
        checksum: provider.checksum,
        trust: "organization" as const,
      };
      const serverCatalogId = `mcp.${provider.id}`;
      if (!registry.catalog.get(serverCatalogId, catalogVersion)) {
        registry.catalog.register({
          id: serverCatalogId,
          version: catalogVersion,
          kind: "mcp_server",
          name: provider.provider_name ?? provider.provider_id,
          description: `MCP server ${provider.provider_name ?? provider.provider_id}`,
          category: "mcp",
          logo: "mcp",
          tags: ["mcp", "remote", provider.protocol_version],
          source: catalogSource,
          provider: { id: provider.provider_id, name: provider.provider_name ?? provider.provider_id, version: catalogVersion },
          toolsetIds: [`mcp.${provider.id}`],
          runtime: {
            execution: "mcp",
            timeoutMs: provider.timeout_ms ?? 15_000,
            requiredScopes: ["mcp:remote"],
            credentialRequirements: provider.credential_reference ? ["mcp.remote"] : [],
          },
        });
      }
      for (const tool of provider.tools) {
        const name = remoteMcpToolName(provider.id, tool.name);
        names.push(name);
        if (registry.get(name)) continue;
        registry.register({
          name,
          version: "1.0.0",
          description: `Reviewed remote MCP tool ${tool.name} from ${provider.provider_name ?? provider.provider_id}`,
          riskClass: "external-effect",
          requiresApproval: true,
          timeoutMs: provider.timeout_ms ?? 15_000,
          inputSchema: tool.inputSchema,
          outputSchema: { type: "object", properties: { result: {} }, required: ["result"], additionalProperties: false },
          catalog: {
            kind: "mcp_tool",
            category: "mcp",
            tags: ["mcp", "remote", "tool"],
            source: catalogSource,
            provider: { id: provider.provider_id, name: provider.provider_name ?? provider.provider_id, version: catalogVersion },
            toolsetIds: [`mcp.${provider.id}`],
            runtime: { execution: "mcp" },
          },
          manifest: {
            ownerService: "remote-mcp",
            requiredScope: "mcp:remote",
            execution: "durable",
            idempotency: "required",
            approval: "always",
            auditClassification: "restricted",
            redaction: ["result"],
          },
          handler: async (context: ToolInvocationContext, argumentsValue: Record<string, unknown>) => ({
            result: await this.callPinnedTool({ organizationId: context.organizationId, agentVersionId: context.agentVersionId, providerVersionId: provider.id, toolName: tool.name, argumentsValue, operationId: context.operationId, runId: context.runId }),
          }),
        });
      }
      const toolsetId = `mcp.${provider.id}`;
      if (!registry.catalog.listToolsets().some((toolset) => toolset.id === toolsetId && toolset.version === catalogVersion)) {
        registry.catalog.registerToolset({
          id: toolsetId,
          version: catalogVersion,
          name: provider.provider_name ?? provider.provider_id,
          description: `${provider.provider_name ?? provider.provider_id} MCP tools`,
          source: catalogSource,
          capabilityIds: provider.tools.map((tool) => remoteMcpToolName(provider.id, tool.name)),
          includes: [],
        });
      }
    }
    return names;
  }

  public async callPinnedTool(input: { organizationId: string; agentVersionId: string; providerVersionId: string; toolName: string; argumentsValue: Record<string, unknown>; operationId?: string; runId?: string }): Promise<unknown> {
    const result = await query<RemoteMcpProviderVersionRecord>(this.pool, `SELECT provider_version.*, provider.endpoint_url, provider.credential_reference, provider.timeout_ms, provider.max_response_bytes, provider.rate_limit_per_minute FROM agent_version_mcp_providers pin JOIN agent_mcp_provider_versions provider_version ON provider_version.id = pin.provider_version_id JOIN agent_mcp_providers provider ON provider.id = provider_version.provider_id WHERE pin.organization_id = $1 AND pin.agent_version_id = $2 AND pin.provider_version_id = $3 AND provider.status = 'approved' AND provider.health_status = 'healthy' AND provider_version.status = 'published'`, [input.organizationId, input.agentVersionId, input.providerVersionId]);
    const provider = result.rows[0];
    if (!provider || !provider.endpoint_url || !provider.timeout_ms || !provider.max_response_bytes) throw new Error("REMOTE_MCP_PROVIDER_NOT_PINNED");
    const allowed = await withTransaction(this.pool, async (client) => {
      const window = await client.query<{ request_count: number }>(
        `INSERT INTO agent_mcp_provider_rate_windows
          (organization_id, provider_id, window_started_at, request_count)
         VALUES ($1, $2, date_trunc('minute', now()), 1)
         ON CONFLICT (provider_id, window_started_at)
         DO UPDATE SET request_count = agent_mcp_provider_rate_windows.request_count + 1, updated_at = now()
         RETURNING request_count`,
        [input.organizationId, provider.provider_id],
      );
      await client.query(
        `DELETE FROM agent_mcp_provider_rate_windows
         WHERE organization_id = $1 AND provider_id = $2
           AND window_started_at < date_trunc('minute', now()) - interval '5 minutes'`,
        [input.organizationId, provider.provider_id],
      );
      return Number(window.rows[0]?.request_count ?? 0) <= (provider.rate_limit_per_minute ?? 60);
    });
    if (!allowed) {
      recordRemoteMcpOperation({ operation: "invocation", outcome: "rejected", errorCode: "REMOTE_MCP_RATE_LIMITED" });
      throw new Error("REMOTE_MCP_RATE_LIMITED");
    }
    const tool = hydrateVersion(provider).tools.find((candidate) => candidate.name === input.toolName);
    if (!tool) throw new Error("REMOTE_MCP_TOOL_NOT_PINNED");
    const authorizationToken = provider.credential_reference && this.resolveCredential
      ? resolveRemoteMcpAuthorizationToken(await this.resolveCredential(input.organizationId, provider.credential_reference))
      : undefined;
    const startedAt = performance.now();
    try {
      const snapshot = createMcpServerSnapshot({
        scope: { organizationId: input.organizationId, agentVersionId: input.agentVersionId },
        serverId: provider.provider_id,
        revision: provider.revision,
        endpointUrl: provider.endpoint_url,
        protocolVersion: provider.protocol_version,
        state: "published",
        tools: hydrateVersion(provider).tools,
        limits: {
          timeoutMs: provider.timeout_ms,
          maxResponseBytes: provider.max_response_bytes,
          maxSchemaBytes: 1_000_000,
          maxResultBytes: Math.min(provider.max_response_bytes, 256_000),
          maxTools: 100,
        },
      });
      const operation = new McpOperationCoordinator({
        environment: process.env.NODE_ENV === "production" ? "production" : "development",
        durableOperations: this.operations,
      });
      const response = await operation.call({
        scope: snapshot.scope,
        snapshot,
        toolName: tool.name,
        argumentsValue: input.argumentsValue,
        authorizationToken,
        operationId: input.operationId ?? `${input.runId ?? "mcp"}:${input.providerVersionId}:${tool.name}`,
        environment: process.env.NODE_ENV === "production" ? "production" : "development",
      });
      if (!response.ok) throw new Error(response.error.code);
      const result = response.value.result;
      recordRemoteMcpOperation({ operation: "invocation", outcome: "success", durationMs: performance.now() - startedAt });
      return result;
    } catch (error) {
      recordRemoteMcpOperation({ operation: "invocation", outcome: "error", durationMs: performance.now() - startedAt, errorCode: remoteMcpErrorCode(error) });
      throw error;
    }
  }

  private async recordHealthSuccess(organizationId: string, providerId: string, latencyMs: number): Promise<RemoteMcpProviderRecord> {
    const result = await query<RemoteMcpProviderRecord>(this.pool, `UPDATE agent_mcp_providers SET health_status = 'healthy', health_checked_at = now(), health_last_success_at = now(), health_latency_ms = $3, health_failure_code = NULL, health_consecutive_failures = 0, updated_at = now() WHERE id = $1 AND organization_id = $2 AND status <> 'revoked' RETURNING *`, [providerId, organizationId, Math.max(0, Math.min(120000, Math.round(latencyMs)))]);
    if (!result.rows[0]) throw new Error("REMOTE_MCP_PROVIDER_NOT_FOUND");
    return result.rows[0];
  }

  private async recordHealthFailure(organizationId: string, providerId: string, error: unknown, latencyMs: number): Promise<RemoteMcpProviderRecord> {
    const result = await query<RemoteMcpProviderRecord>(this.pool, `UPDATE agent_mcp_providers SET health_status = 'unhealthy', health_checked_at = now(), health_latency_ms = $3, health_failure_code = $4, health_consecutive_failures = health_consecutive_failures + 1, updated_at = now() WHERE id = $1 AND organization_id = $2 AND status <> 'revoked' RETURNING *`, [providerId, organizationId, Math.max(0, Math.min(120000, Math.round(latencyMs))), remoteMcpErrorCode(error)]);
    if (!result.rows[0]) throw new Error("REMOTE_MCP_PROVIDER_NOT_FOUND");
    return result.rows[0];
  }

  private async get(organizationId: string, providerId: string): Promise<RemoteMcpProviderRecord | null> {
    const result = await query<RemoteMcpProviderRecord>(this.pool, "SELECT * FROM agent_mcp_providers WHERE id = $1 AND organization_id = $2", [providerId, organizationId]);
    return result.rows[0] ?? null;
  }

}

function hydrateVersion(row: RemoteMcpProviderVersionRecord): RemoteMcpProviderVersionRecord {
  return { ...row, tools: remoteMcpToolsSchema.parse(typeof row.tools === "string" ? JSON.parse(row.tools) : row.tools ?? []) };
}

function remoteMcpErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "REMOTE_MCP_HEALTH_CHECK_FAILED";
  const match = message.match(/^REMOTE_MCP_[A-Z0-9_]+/);
  return (match?.[0] ?? "REMOTE_MCP_HEALTH_CHECK_FAILED").slice(0, 128);
}
