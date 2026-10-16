import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthContext } from "./auth";
import type { WebsiteDeploymentRecord, WebsiteDeploymentRepository } from "../db/repositories/website-deployment-repository";

export function normalizeWebsiteOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw Object.assign(new Error("Use a full http(s) website origin without a path"), { statusCode: 400 }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw Object.assign(new Error("Use a full http(s) website origin without a path"), { statusCode: 400 });
  }
  return url.origin;
}
const appearance = z.object({
  primaryColor: z.string().regex(/^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/).optional(),
  launcherSize: z.number().int().min(44).max(96).optional(),
  windowWidth: z.number().int().min(300).max(600).optional(),
  windowHeight: z.number().int().min(360).max(800).optional(),
  borderRadius: z.number().int().min(0).max(28).optional(),
  launcherOffset: z.number().int().min(8).max(48).optional(),
  showBranding: z.boolean().optional(),
}).strict();
const inputSchema = z.object({
  allowedOrigins: z.array(z.string().trim().min(1).max(1000)).min(1).max(30).optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  welcomeText: z.string().trim().max(2000).optional(),
  launcherPosition: z.enum(["bottom-right", "bottom-left"]).optional(),
  colorPreset: z.enum(["indigo", "violet", "emerald", "blue", "slate"]).optional(),
  avatarUrl: z.url().refine(value => ["http:", "https:"].includes(new URL(value).protocol)).optional(),
  privacyPolicyUrl: z.url().refine(value => ["http:", "https:"].includes(new URL(value).protocol)).optional(),
  appearance: appearance.optional(),
}).strict();

export function projectWebsiteDeployment(row: WebsiteDeploymentRecord) {
  return { ...row.configuration, id: row.id, publicId: row.public_id, orgId: row.organization_id,
    installationId: row.installation_id, sourceInstallationId: row.source_installation_id,
    channelConnectionId: row.channel_connection_id, status: row.status, allowedOrigins: row.allowed_origins,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function registerWebsiteDeploymentRoutes(app: FastifyInstance, dependencies: {
  websites: Pick<WebsiteDeploymentRepository, "list" | "create" | "update" | "setStatus">;
  authorize: (request: FastifyRequest, writing: boolean) => AuthContext;
  publicOrigin?: string;
}) {
  const prefix = "/v1/installations/:installationId/website-deployments";
  function project(row: WebsiteDeploymentRecord) {
    const base = dependencies.publicOrigin?.replace(/\/+$/, "");
    return { ...projectWebsiteDeployment(row), ...(base ? {
      embedCode: `<script async src="${base}/api/widget/v1/loader.js" data-kasitek-deployment="${row.public_id}"></script>`,
    } : {}) };
  }
  function context(request: FastifyRequest, writing: boolean) {
    const auth = dependencies.authorize(request, writing);
    const params = z.object({ installationId: z.uuid(), deploymentId: z.uuid().optional(),
      status: z.enum(["ACTIVE", "PAUSED", "REVOKED"]).optional() }).parse(request.params);
    return { organizationId: auth.organizationId, actorId: auth.actorId,
      sourceInstallationId: params.installationId, deploymentId: params.deploymentId!, status: params.status! };
  }
  function parse(body: unknown) {
    const { allowedOrigins, ...configuration } = inputSchema.parse(body);
    return { origins: allowedOrigins ? [...new Set(allowedOrigins.map(normalizeWebsiteOrigin))] : undefined, configuration };
  }
  app.get(prefix, async request => {
    const ctx = context(request, false);
    return { deployments: (await dependencies.websites.list(ctx.organizationId, ctx.sourceInstallationId)).map(project) };
  });
  app.post(prefix, async (request, reply) => {
    const ctx = context(request, true), input = parse(request.body);
    if (!dependencies.publicOrigin) return reply.code(503).send({ error: "Configure the Agents public URL before publishing website chat" });
    if (!input.origins) return reply.code(400).send({ error: "Add at least one allowed website origin" });
    const configuration = { displayName: "Agent", welcomeText: "How can I help?", launcherPosition: "bottom-right",
      colorPreset: "indigo", ...input.configuration,
      appearance: { primaryColor: "#3730a3", launcherSize: 56, windowWidth: 390,
        windowHeight: 620, borderRadius: 16, launcherOffset: 16, showBranding: true, ...input.configuration.appearance } };
    const row = await dependencies.websites.create({ ...ctx, origins: input.origins, configuration });
    // Public IDs identify deployments; they are never administrative credentials.
    const projected = project(row);
    return reply.code(201).send({ deployment: projected, embedCode: projected.embedCode,
    });
  });
  app.patch(`${prefix}/:deploymentId`, async (request, reply) => {
    const ctx = context(request, true), input = parse(request.body);
    const row = await dependencies.websites.update({ ...ctx, ...input });
    return row ? { deployment: project(row) } : reply.code(404).send({ error: "Website deployment not found" });
  });
  app.post(`${prefix}/:deploymentId/status/:status`, async (request, reply) => {
    const ctx = context(request, true);
    z.object({}).strict().parse(request.body ?? {});
    const row = await dependencies.websites.setStatus(ctx);
    return row ? { deployment: project(row) } : reply.code(404).send({ error: "Website deployment not found" });
  });
}
