import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { ManagementScope } from "../../platform/memory";
import { parseSkillPackage, parseSkillZip, SKILL_PACKAGE_LIMITS } from "../../capabilities/skills/package";
import { SkillPackageStore } from "./skill-package-store";
import { curatedSkillPackage } from "../../capabilities/skills/curated";

export function registerSkillPackageRoutes(app: FastifyInstance, options: { pool: Pool; resolveScope(request: FastifyRequest): Promise<ManagementScope> }) {
  const store = new SkillPackageStore(options.pool), base = "/api/organizations/:organizationId/agents/:agentId/skills/packages";
  const id = (request: FastifyRequest) => z.uuid().parse((request.params as Record<string, string>).id);
  const curatedBase = "/api/organizations/:organizationId/agents/:agentId/skills/curated";
  const slug = (request: FastifyRequest) => z.enum(["grounded-answers", "customer-handoff"]).parse((request.params as Record<string, string>).slug);
  app.get(curatedBase, async request => ({ skills: await store.curated(await options.resolveScope(request)) }));
  app.get(`${curatedBase}/:slug`, async request => {
    const skills = await store.curated(await options.resolveScope(request)), selected = slug(request);
    return { skill: skills.find(skill => skill.slug === selected), body: curatedSkillPackage(selected).body };
  });
  app.post(`${curatedBase}/:slug/install`, async request => {
    const input = z.strictObject({ operationId: z.string().min(1).max(128) }).parse(request.body);
    return { package: await store.installCurated(await options.resolveScope(request), slug(request), input.operationId) };
  });
  app.get(base, async request => ({ packages: await store.list(await options.resolveScope(request)) }));
  app.get(`${base}/:id`, async request => store.get(await options.resolveScope(request), id(request)));
  app.post(`${base}/repository`,async request=>{
    const input=z.strictObject({operationId:z.string().min(1).max(128),repository:z.string(),commit:z.string(),path:z.string().default("")}).parse(request.body);
    return {package:await store.importRepository(await options.resolveScope(request),input.operationId,{repository:input.repository,commit:input.commit,path:input.path})};
  });
  app.get(`${base}/:id/compare`,async request=>{
    const input=z.strictObject({candidateId:z.uuid()}).parse(request.query);
    return store.compare(await options.resolveScope(request),id(request),input.candidateId);
  });
  app.post(`${base}/:id/state`,async request=>({package:await store.setState(await options.resolveScope(request),id(request),request.body)}));
  app.post(base, { bodyLimit: 4_300_000 }, async request => {
    const scope = await options.resolveScope(request);
    const input = z.union([
      z.strictObject({ operationId: z.string().min(1).max(128), files: z.array(z.unknown()).min(1).max(SKILL_PACKAGE_LIMITS.files) }),
      z.strictObject({ operationId: z.string().min(1).max(128), zipBase64: z.string().min(1).max(Math.ceil(SKILL_PACKAGE_LIMITS.archiveBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }),
    ]).parse(request.body);
    const current = "zipBase64" in input ? await parseSkillZip(Buffer.from(input.zipBase64, "base64")) : parseSkillPackage({ files: input.files });
    return { package: await store.import(scope, input.operationId, current) };
  });
  app.post(`${base}/:id/review`, async request => {
    const input = z.strictObject({ contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    return { package: await store.review(await options.resolveScope(request), id(request), input.contentDigest) };
  });
  app.get(`${base}/:id/files`, async request => {
    const query = z.strictObject({ path: z.string().min(1).max(SKILL_PACKAGE_LIMITS.pathBytes) }).parse(request.query);
    return store.file(await options.resolveScope(request), id(request), query.path);
  });
}
