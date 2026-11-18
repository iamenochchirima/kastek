import { skillPackageCodec } from "../../capabilities/skills/package";
import type { FastifyInstance,FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { ArtifactStore } from "../../execution/artifacts/artifacts";
import { MemoryStore,type ManagementScope } from "../../execution/memory/memory";
import { type PrivateObjectStore } from "../../infrastructure/object-store";
import { memoryAssertionSchema } from "../../contracts/memory";
import { memoryCapability } from "../../platform/memory/capability";

const operationId = z.string().min(1).max(128), expectedRevision = z.number().int().positive();
export function registerMemoryRoutes(app: FastifyInstance, options: { pool: Pool; resolveScope(request: FastifyRequest): Promise<ManagementScope>; objects?: PrivateObjectStore }) {
  const memory = new MemoryStore(options.pool, skillPackageCodec), artifacts = new ArtifactStore(options.pool, options.objects);
  const base = memoryCapability.agentBasePath;
  const id = (request: FastifyRequest) => z.uuid().parse((request.params as Record<string, string>).id);
  app.get(`${base}/memory`, async request => { const page = z.strictObject({ offset: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
    const result = await memory.list(await options.resolveScope(request), page); return { generation: result.generation, items: result.memories, candidates: result.candidates, nextOffset: result.nextOffset }; });
  app.post(`${base}/memory`, async request => memory.proposeManaged(await options.resolveScope(request), z.strictObject({ operationId, kind: z.enum(["semantic", "episodic"]), content: z.string().min(1).max(8192), assertion: memoryAssertionSchema.optional() }).parse(request.body)));
  app.post(`${base}/memory/candidates/:id/accept`, async request => memory.mutate(await options.resolveScope(request), id(request), { ...z.strictObject({ operationId, expectedRevision, assertion: memoryAssertionSchema.optional() }).parse(request.body), action: "accept" }));
  app.patch(`${base}/memory/:id`, async request => memory.mutate(await options.resolveScope(request), id(request), { ...z.strictObject({ operationId, expectedRevision, content: z.string().min(1).max(8192), assertion: memoryAssertionSchema.optional() }).parse(request.body), action: "correct" }));
  app.post(`${base}/memory/:id/forget`, async request => memory.mutate(await options.resolveScope(request), id(request), { ...z.strictObject({ operationId, expectedRevision }).parse(request.body), action: "forget" }));
  app.get(`${base}/skills`, async request => { const scope = await options.resolveScope(request); return { skills: await memory.listSkills(scope.accountId, scope.organizationId, scope.agentId) }; });
  app.post(`${base}/skills`, async request => ({ skill: await memory.publishSkill(await options.resolveScope(request), z.strictObject({ operationId, name: z.string().min(1).max(80), description: z.string().min(1).max(1024), body: z.string().min(1).max(16384) }).parse(request.body)) }));
  app.get(`${base}/artifacts`, async request => ({ artifacts: await artifacts.list(await options.resolveScope(request)) }));
  app.post(`${base}/artifacts`, { bodyLimit: 1_100_000 }, async request => { const scope = await options.resolveScope(request); const input = z.strictObject({ operationId, contentType: z.enum(["text/plain", "text/markdown", "application/json"]), content: z.string().max(1_048_576) }).parse(request.body);
    return artifacts.put(scope, { ...input, content: Buffer.from(input.content) }); });
  app.get(`${base}/artifacts/:id`, async (request, reply) => { const result = await artifacts.get(await options.resolveScope(request), id(request));
    return reply.header("content-type", result.artifact.contentType).header("content-disposition", `attachment; filename="${result.artifact.id}.txt"`).header("x-content-type-options", "nosniff").send(Buffer.from(result.content)); });
  app.delete(`${base}/artifacts/:id`, async request => artifacts.forget(await options.resolveScope(request), id(request)));
}
