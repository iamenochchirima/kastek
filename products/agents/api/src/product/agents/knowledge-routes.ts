import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentRuntime } from "../../capabilities/knowledge/document-runtime";
import { KnowledgeStore,requireKnowledgeMember,type KnowledgeScope } from "../../capabilities/knowledge/knowledge";
import { PlatformError } from "../../contracts/contracts";

export function registerKnowledgeRoutes(app: FastifyInstance, options: { knowledge: KnowledgeStore; runtime?: Pick<DocumentRuntime,"available"|"profile">; resolveScope(request: FastifyRequest): Promise<KnowledgeScope> }) {
  const base = "/api/organizations/:organizationId/knowledge", params = (request: FastifyRequest) => request.params as Record<string, string>;
  app.get(`${base}/sources`, async request => {
    const scope = await options.resolveScope(request);
    const [sources, imports, role] = await Promise.all([options.knowledge.list(scope), options.knowledge.listImports(scope), requireKnowledgeMember(options.knowledge.pool, scope)]);
    return { sources, imports, canApprove: role !== "member" };
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
  app.get(`${base}/sources/:sourceId/revisions/:revisionId/preview`, async request => options.knowledge.preview(await options.resolveScope(request), z.uuid().parse(params(request).sourceId), z.uuid().parse(params(request).revisionId)));
}
