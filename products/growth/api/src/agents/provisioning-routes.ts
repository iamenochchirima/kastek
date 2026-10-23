import type { FastifyInstance } from "fastify";
import { GROWTH_AGENT_PROVISION_CHECK_PATH, parseGrowthAgentProvisionRequest } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { verifyGrowthAgentProvisioningCheck } from "./security.js";
import { currentGrowthAgentSetup } from "./setup.js";
export function registerGrowthAgentProvisioningRoutes(app: FastifyInstance, core: CoreContext): void {
  app.post(GROWTH_AGENT_PROVISION_CHECK_PATH, { bodyLimit: 16384 }, async request => {
    await verifyGrowthAgentProvisioningCheck(core.config, request.headers.authorization, request.body);
    let target;
    try { target = parseGrowthAgentProvisionRequest(request.body); }
    catch { throw new ApiError(400,"agent_setup_request_invalid","Agent setup request is invalid"); }
    return { active: await currentGrowthAgentSetup(core, target) };
  });
}
