import type { FastifyInstance } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser } from "../identity/session.js";
import { ApiError } from "../error.js";
import {
  generateSocialCaption,
  generateSocialIdeas,
  type SocialCaptionRequest,
  type SocialIdeasRequest,
} from "../services/ai.js";
function parse(value: unknown, strings: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "bad_request", "Invalid request");
  const body = value as Record<string, unknown>;
  for (const key of strings)
    if (body[key] != null && typeof body[key] !== "string")
      throw new ApiError(400, "bad_request", "Invalid request");
  if (
    body.channels != null &&
    (!Array.isArray(body.channels) ||
      body.channels.some((item) => typeof item !== "string"))
  )
    throw new ApiError(400, "bad_request", "Invalid request");
  return body;
}
export function registerAiRoutes(app: FastifyInstance, context: CoreContext) {
  app.post("/api/social/ai/ideas", async (request) => {
    const user = await extractUser(request, context);
    return generateSocialIdeas(
      context.pool,
      user.id,
      parse(request.body, ["topic", "objective"]) as SocialIdeasRequest,
    );
  });
  app.post("/api/social/ai/caption", async (request) => {
    const user = await extractUser(request, context);
    return generateSocialCaption(
      context.pool,
      user.id,
      parse(request.body, [
        "prompt",
        "title",
        "currentContent",
      ]) as SocialCaptionRequest,
    );
  });
}
