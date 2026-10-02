import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { AgentPlatformClient } from "../services/agent-platform/client.js";
import {
  publicMediaUrl,
  uploadContentMediaBytes,
} from "../services/social/media.js";
import * as website from "../services/website/index.js";
import {
  websiteChannelMessagePayload,
  websiteChannelAudioPayload,
} from "../services/website/payloads.js";
import {
  WEBSITE_CHAT_FRAME,
  WEBSITE_CHAT_LOADER,
} from "../services/website/assets.js";
import type {
  LeadOptions,
  QuoteInput,
  WaitlistInput,
} from "../services/website/leads.js";
import type { Row } from "../services/website/deployments.js";
export interface WebsiteOptions extends LeadOptions {
  client?: (
    core: CoreContext,
  ) => Pick<
    AgentPlatformClient,
    | "ingestChannelMessage"
    | "getAudioTranscriptionJob"
    | "retryAudioTranscription"
  >;
  upload?: typeof uploadContentMediaBytes;
}
const PREFIX = "/api/widget/v1";
const bad = website.bad;
const unauthorized = () => new ApiError(401, "unauthorized", "Unauthorized");
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
function path(request: FastifyRequest, key: string): string {
  return (request.params as Record<string, string>)[key]!.trim();
}
function query(request: FastifyRequest): Record<string, string> {
  return (request.query ?? {}) as Record<string, string>;
}
function origin(
  request: FastifyRequest,
  core: CoreContext,
): { origin: string; normalized: string; share: boolean } {
  const share = ["1", "true"].includes(query(request).share ?? "");
  const value =
    header(request, "origin") ?? (share ? core.config.publicApiUrl : undefined);
  if (value == null) throw unauthorized();
  const normalized = website.normalizeOrigin(value);
  return {
    origin: value,
    normalized,
    share:
      share && normalized === website.normalizeOrigin(core.config.publicApiUrl),
  };
}
function cors(reply: FastifyReply, value: string): FastifyReply {
  return reply
    .header("Access-Control-Allow-Origin", value)
    .header("Vary", "Origin");
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw bad("Invalid request");
  return value as Row;
}
function optionalString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw bad("Invalid request");
  return value;
}
function leadInput(
  value: unknown,
  waitlist: boolean,
): QuoteInput | WaitlistInput {
  const input = object(value),
    output: Row = {};
  for (const key of [
    "businessName",
    "contactPerson",
    "phone",
    "email",
    "businessType",
    ...(waitlist ? ["companyWebsite", "notes", "website"] : ["description"]),
  ])
    output[key] = optionalString(input[key]);
  const key = waitlist ? "products" : "services";
  if (
    input[key] != null &&
    (!Array.isArray(input[key]) ||
      input[key].some((v: unknown) => typeof v !== "string"))
  )
    throw bad("Invalid request");
  output[key] = input[key] ?? null;
  if (waitlist) {
    if (
      input.contactConsent != null &&
      typeof input.contactConsent !== "boolean"
    )
      throw bad("Invalid request");
    output.contactConsent = input.contactConsent ?? null;
  }
  return output;
}
async function activeDeployment(core: CoreContext, session: Row): Promise<Row> {
  const row = (
    await core.pool.query(
      `SELECT deployment."orgId",organization."ownerId",deployment."publicId",deployment."installationId" FROM "AgentWebsiteDeployment" deployment JOIN "Organization" organization ON organization.id=deployment."orgId" WHERE deployment.id=$1 AND deployment.status='ACTIVE'`,
      [session.deploymentId],
    )
  ).rows[0];
  if (!row) throw website.missing();
  return row;
}
async function scopedAudio(
  client: Pick<AgentPlatformClient, "getAudioTranscriptionJob">,
  core: CoreContext,
  session: Row,
  deployment: Row,
  job: string,
): Promise<Row> {
  const raw = await client.getAudioTranscriptionJob(
      deployment.orgId,
      deployment.ownerId,
      job,
    ),
    status =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Row)
        : null,
    asset =
      typeof status?.assetId === "string" && status.assetId.trim()
        ? status.assetId
        : null;
  if (!asset) throw website.missing("audio");
  const row = (
    await core.pool.query(
      `SELECT EXISTS(SELECT 1 FROM "ContentMediaAsset" WHERE id=$1 AND "orgId"=$2 AND metadata->>'source'='website_widget' AND metadata->>'sourceKey' LIKE $3) AS exists`,
      [
        asset,
        deployment.orgId,
        `website:${deployment.publicId}:${session.publicSessionId}:%`,
      ],
    )
  ).rows[0];
  if (!row?.exists) throw website.missing("audio");
  return status!;
}
export async function registerWebsiteRoutes(
  app: FastifyInstance,
  core: CoreContext,
  options: WebsiteOptions = {},
): Promise<void> {
  const client = () =>
    options.client?.(core) ?? new AgentPlatformClient(core.config);
  const leads = { ...options, logger: options.logger ?? app.log };
  app.get(`${PREFIX}/loader.js`, async (_request, reply) =>
    reply
      .type("application/javascript; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .send(WEBSITE_CHAT_LOADER),
  );
  app.get(`${PREFIX}/frame.html`, async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(WEBSITE_CHAT_FRAME),
  );
  app.get(`${PREFIX}/share/:publicId`, async (request, reply) => {
    const shareOrigin = website.normalizeOrigin(core.config.publicApiUrl),
      id = path(request, "publicId");
    await website.publicAgentWebsiteDeployment(
      core.pool,
      id,
      shareOrigin,
      true,
    );
    const api = core.config.publicApiUrl.replace(/\/+$/, "");
    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(
        `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website Chat</title>\n<style>html,body{min-height:100%;margin:0}body{min-height:100vh;background:#f8fafc}</style></head>\n<body><script async src="${api}/api/widget/v1/loader.js" data-kasitek-deployment="${id}" data-kasitek-share="true"></script></body></html>`,
      );
  });
  app.get(`${PREFIX}/deployments/:publicId`, async (request, reply) => {
    const source = origin(request, core),
      deployment = await website.publicAgentWebsiteDeployment(
        core.pool,
        path(request, "publicId"),
        source.origin,
        source.share,
      );
    return cors(reply, source.normalized).send(
      Object.fromEntries([
        ...[
          "publicId",
          "displayName",
          "welcomeText",
          "launcherPosition",
          "colorPreset",
          "appearance",
          "avatarUrl",
          "privacyPolicyUrl",
        ].map((key) => [key, deployment[key]]),
        ["poweredBy", "KasiTek"],
      ]),
    );
  });
  app.post(
    `${PREFIX}/deployments/:publicId/sessions`,
    async (request, reply) => {
      const source = origin(request, core),
        deployment = await website.publicAgentWebsiteDeployment(
          core.pool,
          path(request, "publicId"),
          source.origin,
          source.share,
        ),
        session = await website.createAgentWebsiteVisitorSession(
          core.pool,
          deployment,
          source.origin,
        );
      return cors(reply, source.normalized)
        .code(201)
        .send({
          sessionId: session.publicSessionId,
          expiresAt: session.expiresAt,
        });
    },
  );
  app.post(`${PREFIX}/sessions/:sessionId/messages`, async (request, reply) => {
    const source = origin(request, core),
      input = object(request.body);
    if (
      typeof input.text !== "string" ||
      typeof input.idempotencyKey !== "string"
    )
      throw bad("Invalid request");
    const text = input.text.trim(),
      key = input.idempotencyKey;
    if (
      !text ||
      Buffer.byteLength(text) > 4000 ||
      !key.trim() ||
      Buffer.byteLength(key) > 240
    )
      throw bad("Website Chat message is invalid");
    const display = optionalString(input.displayName)?.trim() || null,
      session = await website.activeAgentWebsiteVisitorSession(
        core.pool,
        path(request, "sessionId"),
        source.origin,
      );
    const deployment = (
      await core.pool.query(
        `SELECT "publicId","orgId" FROM "AgentWebsiteDeployment" WHERE id=$1 AND status='ACTIVE'`,
        [session.deploymentId],
      )
    ).rows[0];
    if (!deployment) throw website.missing();
    const accepted = await client().ingestChannelMessage(
      deployment.orgId,
      `website-session:${session.publicSessionId}`,
      websiteChannelMessagePayload(
        deployment.publicId,
        key,
        session.externalIdentity,
        session.externalConversationId,
        text,
        display,
      ),
    );
    return cors(reply, source.normalized).code(202).send(accepted);
  });
  app.get(
    `${PREFIX}/sessions/:sessionId/audio/:jobId`,
    async (request, reply) => {
      const source = origin(request, core),
        session = await website.activeAgentWebsiteVisitorSession(
          core.pool,
          path(request, "sessionId"),
          source.origin,
        ),
        deployment = await activeDeployment(core, session),
        status = await scopedAudio(
          client(),
          core,
          session,
          deployment,
          path(request, "jobId"),
        );
      status.audioUrl = publicMediaUrl(core.config, status.assetId);
      return cors(reply, source.normalized).send(status);
    },
  );
  app.post(
    `${PREFIX}/sessions/:sessionId/audio/:jobId/retry`,
    async (request, reply) => {
      const source = origin(request, core),
        session = await website.activeAgentWebsiteVisitorSession(
          core.pool,
          path(request, "sessionId"),
          source.origin,
        ),
        deployment = await activeDeployment(core, session),
        proxy = client();
      await scopedAudio(
        proxy,
        core,
        session,
        deployment,
        path(request, "jobId"),
      );
      return cors(reply, source.normalized)
        .code(202)
        .send(
          await proxy.retryAudioTranscription(
            deployment.orgId,
            deployment.ownerId,
            path(request, "jobId"),
          ),
        );
    },
  );
  app.get(
    `${PREFIX}/sessions/:sessionId/deliveries`,
    async (request, reply) => {
      const source = origin(request, core),
        session = await website.activeAgentWebsiteVisitorSession(
          core.pool,
          path(request, "sessionId"),
          source.origin,
        ),
        deliveries = await website.listAgentWebsiteDeliveries(
          core.pool,
          session,
          query(request).after,
        ),
        org = await website.agentWebsiteDeploymentOrgId(
          core.pool,
          session.deploymentId,
        );
      await website.addAgentWebsiteDeliveryPreviews(
        core.pool,
        core.config,
        org,
        deliveries,
      );
      return cors(reply, source.normalized).send({ deliveries });
    },
  );
  for (const route of [
    `deployments/:publicId/sessions`,
    `sessions/:sessionId/messages`,
    `sessions/:sessionId/audio`,
    `sessions/:sessionId/audio/:jobId`,
    `sessions/:sessionId/audio/:jobId/retry`,
  ])
    app.options(`${PREFIX}/${route}`, async (request, reply) => {
      const value = header(request, "origin");
      if (!value) throw unauthorized();
      return cors(reply, website.normalizeOrigin(value))
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header(
          "Access-Control-Allow-Headers",
          "Content-Type, X-Audio-Idempotency-Key, X-Audio-File-Name, X-Audio-Caption, X-Audio-Display-Name",
        )
        .code(204)
        .send();
    });
  app.post("/api/quote-requests", async (request, reply) =>
    reply
      .code(201)
      .send(
        await website.createQuoteRequest(
          core,
          leadInput(request.body, false) as QuoteInput,
          leads,
        ),
      ),
  );
  app.post("/api/waitlist", { bodyLimit: 32 * 1024 }, async (request, reply) =>
    reply
      .code(201)
      .send(
        await website.createWaitlistEntry(
          core,
          leadInput(request.body, true) as WaitlistInput,
          leads,
        ),
      ),
  );
  await app.register(async (audio) => {
    audio.setErrorHandler((error, request, reply) => {
      if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
        return reply
          .code(400)
          .send({
            error: "Audio must be 25 MB or smaller",
            code: "bad_request",
          });
      throw error;
    });
    audio.removeAllContentTypeParsers();
    audio.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    audio.post(
      `${PREFIX}/sessions/:sessionId/audio`,
      { bodyLimit: 25 * 1024 * 1024 },
      async (request, reply) => {
        const source = origin(request, core),
          key = header(request, "x-audio-idempotency-key")?.trim();
        if (!key || Buffer.byteLength(key) < 8 || Buffer.byteLength(key) > 240)
          throw bad("A valid audio idempotency key is required");
        const mime = header(request, "content-type")?.split(";")[0]?.trim();
        if (
          !mime ||
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
          throw bad("A supported audio MIME type is required");
        const encoded = header(request, "x-audio-file-name");
        let filename: string | null = null;
        try {
          filename = encoded == null ? null : decodeURIComponent(encoded);
        } catch {}
        const caption = header(request, "x-audio-caption")?.trim() || null;
        if (caption && Array.from(caption).length > 4000)
          throw bad("Audio caption is too long");
        const rawDisplay = header(request, "x-audio-display-name")?.trim(),
          display =
            rawDisplay && Array.from(rawDisplay).length <= 120
              ? rawDisplay
              : null;
        const bytes = request.body;
        if (bytes == null) throw bad("Audio is required");
        if (!Buffer.isBuffer(bytes)) throw bad("Failed to read audio");
        if (!bytes.length) throw bad("Audio is required");
        if (bytes.length > 25 * 1024 * 1024)
          throw bad("Audio must be 25 MB or smaller");
        const session = await website.activeAgentWebsiteVisitorSession(
            core.pool,
            path(request, "sessionId"),
            source.origin,
          ),
          deployment = await activeDeployment(core, session);
        const count = (
          await core.pool.query(
            `SELECT COUNT(*) FROM "ContentMediaAsset" WHERE "orgId"=$1 AND metadata->>'source'='website_widget' AND metadata->>'sourceKey' LIKE $2 AND "createdAt">NOW()-INTERVAL '1 hour'`,
            [
              deployment.orgId,
              `website:${deployment.publicId}:${session.publicSessionId}:%`,
            ],
          )
        ).rows[0]?.count;
        if (BigInt(count ?? 0) >= 20n)
          throw new ApiError(
            429,
            "too_many_requests",
            "Website Chat audio upload limit reached",
          );
        const asset = await (options.upload ?? uploadContentMediaBytes)(
          core.pool,
          core.config,
          deployment.ownerId,
          deployment.orgId,
          {
            fileName: filename,
            mimeType: mime,
            bytes,
            source: "website_widget",
            sourceKey: `website:${deployment.publicId}:${session.publicSessionId}:${key}`,
          },
        );
        const result = await client().ingestChannelMessage(
          deployment.orgId,
          deployment.ownerId,
          websiteChannelAudioPayload(
            deployment.publicId,
            deployment.installationId,
            key,
            session.externalIdentity,
            session.externalConversationId,
            caption ?? "",
            asset.id,
            mime,
            filename,
            display,
          ),
        );
        return cors(reply, source.normalized).code(202).send(result);
      },
    );
  });
}
