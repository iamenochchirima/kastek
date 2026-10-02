import type { FastifyInstance } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireMember, requireAdmin } from "../services/orgs.js";
import {
  attributeReferral,
  getReferralSummary,
  referralRewardConfig,
} from "../services/referrals.js";
import { ApiError } from "../error.js";
export function registerReferralRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  app.get("/api/referrals", async (request) => {
    const user = await extractUser(request, context),
      org = await resolveActiveOrgId(request, context, user.id);
    await requireMember(context.pool, org, user.id);
    return getReferralSummary(
      context.pool,
      org,
      referralRewardConfig(context.config),
      context.config.frontendUrl,
    );
  });
  app.post("/api/referrals/attribute", async (request) => {
    const user = await extractUser(request, context),
      org = await resolveActiveOrgId(request, context, user.id);
    await requireAdmin(context.pool, org, user.id);
    const code = (request.body as { code?: unknown } | null)?.code;
    if (typeof code !== "string")
      throw new ApiError(400, "bad_request", "Referral code is required");
    return {
      attributed: await attributeReferral(
        context.pool,
        org,
        code,
        referralRewardConfig(context.config),
      ),
    };
  });
}
