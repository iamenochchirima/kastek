import type { FastifyInstance } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { billingServiceConfig } from "../services/billing-service.js";
import { typedQuery } from "../typed-query.js";
import { registerBillingServiceRoutes } from "./billing-service-routes.js";

const BILLING_ROUTES = [
  ["GET", "/api/billing/summary"],
  ["GET", "/api/billing/usage"],
  ["GET", "/api/billing/credits"],
  ["GET", "/api/billing/plans"],
  ["GET", "/api/billing/plans/:planKey"],
  ["POST", "/api/billing/checkout"],
  ["POST", "/api/billing/checkout/:reference/verify"],
  ["POST", "/api/billing/subscriptions/:id/:action"],
] as const;

export function registerBillingRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  const service = billingServiceConfig(context.config.env);
  if (!service) {
    for (const [method, path] of BILLING_ROUTES)
      app.route({
        method,
        url: path,
        handler: async (request) => {
          if (path === "/api/billing/usage")
            typedQuery<{ range?: string }>(request.query, ["range"]);
          throw new ApiError(
            503,
            "service_unavailable",
            "Customer billing is not configured",
          );
        },
      });
    return;
  }
  registerBillingServiceRoutes(app, context, service);
}
