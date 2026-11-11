import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentRuntime } from "../../capabilities/knowledge/document-runtime";
import { KnowledgeStore,requireKnowledgeMember,type KnowledgeScope } from "../../capabilities/knowledge/knowledge";
import { KnowledgeRetrieval } from "../../capabilities/knowledge/retrieval";
import { agentConfigurationSchema, PlatformError } from "../../contracts/contracts";

export function registerKnowledgeRoutes(app: FastifyInstance, options: { knowledge: KnowledgeStore; runtime?: Pick<DocumentRuntime,"available"|"profile">; resolveScope(request: FastifyRequest): Promise<KnowledgeScope> }) {
  const base = "/api/organizations/:organizationId/knowledge", params = (request: FastifyRequest) => request.params as Record<string, string>;
  app.get(`${base}/sources`, async request => {
    const scope = await options.resolveScope(request);
    const [sources, imports, role] = await Promise.all([options.knowledge.list(scope), options.knowledge.listImports(scope), requireKnowledgeMember(options.knowledge.pool, scope)]);
    return { sources, imports, canApprove: role !== "member" };
  });
  /** Owner-facing keyword check against the saved draft; semantic ranking is exercised by private preview. */
  app.post(`${base}/agents/:agentId/knowledge/test`, async request => {
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
    if (!configuration.sourceRevisionIds.length) return { profile: "lexical-v1", configuredProfile: configuration.retrievalProfile.kind, attached: 0, privateSources: 0, hits: [] };
    const privateSources = Number((await options.knowledge.pool.query(
      `SELECT count(DISTINCT v.source_id) AS count FROM agents_platform.version_sources v
       JOIN agents_platform.sources s ON s.id=v.source_id AND s.organization_id=v.organization_id
       WHERE v.organization_id=$1 AND v.version_id=$2 AND s.visibility='private' AND v.revision_id=ANY($3::uuid[])`,
      [scope.organizationId, latest.id, configuration.sourceRevisionIds])).rows[0]?.count ?? 0);
    const hits = await new KnowledgeRetrieval(options.knowledge.pool).search({
      organizationId: scope.organizationId, versionId: latest.id, sourceRevisionIds: configuration.sourceRevisionIds, publicOnly: true,
    }, query, { kind: "lexical-v1" }, async db => { await requireKnowledgeMember(db, scope); });
    return { profile: "lexical-v1", configuredProfile: configuration.retrievalProfile.kind, attached: configuration.sourceRevisionIds.length, privateSources,
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
    z.strictObject({ operationId: z.string(), expectedGeneration: z.number(), action: z.enum(["approve", "withdraw", "visibility"]), revisionId: z.uuid().optional(), visibility: z.enum(["private", "public"]).optional() }).parse(request.body)) }));
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
