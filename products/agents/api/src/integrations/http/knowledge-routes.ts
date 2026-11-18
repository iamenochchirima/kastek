import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentRuntime } from "../../platform/knowledge/document-runtime";
import { KnowledgeStore,requireKnowledgeMember,type KnowledgeScope } from "../../platform/knowledge/knowledge";
import { KnowledgeRetrieval } from "../../platform/knowledge/retrieval";
import { agentConfigurationSchema, PlatformError } from "../../contracts/contracts";
import { knowledgeCapability } from "../../platform/knowledge/capability";

export function registerKnowledgeRoutes(app: FastifyInstance, options: { knowledge: KnowledgeStore; runtime?: Pick<DocumentRuntime,"available"|"profile">; resolveScope(request: FastifyRequest): Promise<KnowledgeScope> }) {
  const organizationBase = "/api/organizations/:organizationId", base = knowledgeCapability.basePath, params = (request: FastifyRequest) => request.params as Record<string, string>;
  app.get(`${base}/sources`, async request => {
    const scope = await options.resolveScope(request);
    const [sources, imports, role, usage] = await Promise.all([options.knowledge.list(scope), options.knowledge.listImports(scope), requireKnowledgeMember(options.knowledge.pool, scope),
      options.knowledge.pool.query(`WITH pins AS (
          SELECT a.id AS agent_id,a.name,jsonb_array_elements_text(a.draft->'sourceRevisionIds')::uuid AS revision_id
          FROM agents_platform.agents a WHERE a.organization_id=$1 AND a.deleted_at IS NULL
          UNION
          SELECT a.id,a.name,jsonb_array_elements_text(v.configuration->'sourceRevisionIds')::uuid
          FROM agents_platform.agents a
          JOIN LATERAL (SELECT configuration FROM agents_platform.agent_versions v WHERE v.agent_id=a.id ORDER BY v.number DESC LIMIT 1) v ON true
          WHERE a.organization_id=$1 AND a.deleted_at IS NULL
        )
        SELECT r.source_id,array_agg(DISTINCT p.name ORDER BY p.name) AS agents
        FROM pins p JOIN agents_platform.source_revisions r ON r.id=p.revision_id AND r.organization_id=$1
        GROUP BY r.source_id`, [scope.organizationId])]);
    const attached = new Map((usage.rows as { source_id: string; agents: string[] }[]).map(row => [row.source_id, row.agents]));
    return { sources: sources.map(source => ({ ...source, attachedAgents: attached.get(source.id) ?? [] })), imports, canApprove: role !== "member" };
  });
  /** Owner-facing keyword check against the saved draft; semantic ranking is exercised by private preview. */
  app.post(`${organizationBase}/agents/:agentId/knowledge/test`, async request => {
    const scope = await options.resolveScope(request);
    const agentId = z.uuid().parse(params(request).agentId);
    const { query } = z.strictObject({ query: z.string().trim().min(1).max(1024) }).parse(request.body ?? {});
    const latest = (await options.knowledge.pool.query<{ id: string; configuration: unknown }>(
      `SELECT v.id,v.configuration FROM agents_platform.agent_versions v
       JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id
       WHERE v.organization_id=$1 AND a.id=$2 AND a.deleted_at IS NULL
       ORDER BY v.number DESC LIMIT 1`, [scope.organizationId, agentId])).rows[0];
    if (!latest) throw new PlatformError("AGENT_NOT_FOUND", 404, "Agent not found");
    const configuration = agentConfigurationSchema.parse(latest.configuration);
    if (!configuration.sourceRevisionIds.length) return { profile: "lexical-v1", configuredProfile: configuration.retrievalProfile.kind, attached: 0, hits: [] };
    const hits = await new KnowledgeRetrieval(options.knowledge.pool).search({
      organizationId: scope.organizationId, versionId: latest.id, sourceRevisionIds: configuration.sourceRevisionIds, publicOnly: false,
    }, query, { kind: "lexical-v1" }, async db => { await requireKnowledgeMember(db, scope); });
    return { profile: "lexical-v1", configuredProfile: configuration.retrievalProfile.kind, attached: configuration.sourceRevisionIds.length,
      hits: hits.map(hit => ({ sourceId: hit.sourceId, revisionId: hit.revisionId, title: hit.title, text: hit.text.slice(0, 1200),
        start: hit.start, page: hit.page, rankScore: hit.rankScore })) };
  });
  const common = { operationId: z.string().min(1).max(128), title: z.string().trim().min(1).max(200), sourceId: z.uuid().optional() };
  app.post(`${base}/imports`, { bodyLimit: 14_100_000 }, async (request, reply) => {
    const scope = await options.resolveScope(request);
    const input = z.discriminatedUnion("kind", [z.strictObject({ ...common, kind: z.literal("upload"), contentType: z.enum(["text/plain", "text/markdown", "text/html", "application/pdf", "application/json", "text/csv"]), contentBase64: z.string().min(4).max(13_981_016) }),
      z.strictObject({ ...common, kind: z.literal("public_url"), url: z.url().max(2048) })]).parse(request.body);
    const available = options.runtime ? await options.runtime.available() : false;
    let job;
    if (input.kind === "public_url") {
      if (!available) throw new PlatformError("DOCUMENT_RUNTIME_UNAVAILABLE", 503, "Document processing is unavailable");
      const { profileRelease } = await options.runtime!.profile();
      const { kind: _kind, ...fields } = input;
      job = await options.knowledge.admitUrl(scope, { ...fields, parserRelease: profileRelease, embeddingRelease: profileRelease });
    } else {
      const content = Buffer.from(input.contentBase64, "base64");
      if (content.toString("base64") !== input.contentBase64) throw new PlatformError("INVALID_INPUT", 400, "File content is invalid");
      const textType = input.contentType === "text/plain" || input.contentType === "text/markdown" || input.contentType === "application/json" || input.contentType === "text/csv" ? input.contentType : null;
      if (textType && !available) {
        if (content.byteLength > 262144) throw new PlatformError("DOCUMENT_RUNTIME_UNAVAILABLE", 503, "Document processing is unavailable for files over 256 KB");
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
        catch { throw new PlatformError("SOURCE_ENCODING_INVALID", 400, "Use UTF-8 encoded content"); }
        job = await options.knowledge.admitText(scope, { operationId: input.operationId, title: input.title, sourceId: input.sourceId, text, contentType: textType });
      } else {
        if (!available) throw new PlatformError("DOCUMENT_RUNTIME_UNAVAILABLE", 503, "Document processing is unavailable");
        const { profileRelease } = await options.runtime!.profile();
        job = await options.knowledge.admitUpload(scope, { operationId: input.operationId, title: input.title, sourceId: input.sourceId,
          contentType: input.contentType, content, parserRelease: profileRelease, embeddingRelease: profileRelease });
      }
    }
    return reply.code(202).send({ job });
  });
  app.get(`${base}/imports/:jobId`, async request => ({ job: await options.knowledge.getJob(await options.resolveScope(request), z.uuid().parse(params(request).jobId)) }));
  app.post(`${base}/imports/:jobId/cancel`, async request => ({ job: await options.knowledge.cancel(await options.resolveScope(request), z.uuid().parse(params(request).jobId)) }));
  app.post(`${base}/sources/:sourceId/policy`, async request => ({ source: await options.knowledge.setPolicy(await options.resolveScope(request), z.uuid().parse(params(request).sourceId),
    z.strictObject({ operationId: z.string(), expectedGeneration: z.number(), action: z.enum(["approve", "withdraw"]), revisionId: z.uuid().optional() }).parse(request.body)) }));
  app.delete(`${base}/sources/:sourceId`, async request => {
    const scope = await options.resolveScope(request);
    const force = z.strictObject({ force: z.enum(["true", "false"]).optional() }).parse(request.query ?? {}).force === "true";
    return options.knowledge.deleteSource(scope, z.uuid().parse(params(request).sourceId), force);
  });
  app.post(`${base}/sources/:sourceId/restore`, async request => ({ source: await options.knowledge.restoreSource(await options.resolveScope(request), z.uuid().parse(params(request).sourceId)) }));
  app.post(`${base}/sources/:sourceId/verify`, async request => {
    const scope = await options.resolveScope(request);
    const body = z.strictObject({ reviewDueAt: z.iso.datetime().optional() }).parse(request.body ?? {});
    return { source: await options.knowledge.verify(scope, z.uuid().parse(params(request).sourceId), body.reviewDueAt) };
  });
  app.get(`${base}/sources/:sourceId/original`, async (request, reply) => {
    const file = await options.knowledge.downloadOriginal(await options.resolveScope(request), z.uuid().parse(params(request).sourceId));
    const name = file.filename.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "source";
    return reply.type(file.contentType)
      .header("content-disposition", `attachment; filename="${name}"`)
      .send(Buffer.from(file.bytes));
  });
  app.get(`${base}/sources/:sourceId/revisions/:revisionId/preview`, async request => options.knowledge.preview(await options.resolveScope(request), z.uuid().parse(params(request).sourceId), z.uuid().parse(params(request).revisionId)));
}
