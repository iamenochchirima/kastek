import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractAdmin, grantsForRole } from "../identity/admin-session.js";
import { ApiError } from "../error.js";
import {
  customerOperationsEnabled,
  customerActionEnabled,
  parseCustomerOperation,
} from "@kasitek-labs/server-support/admin-customers";
import * as customers from "../services/admin/customers.js";
import { obj, bad } from "../services/admin/common.js";
export function registerAdminCustomerRoutes(
  app: FastifyInstance,
  context: CoreContext,
) {
  const prefix = "/api/admin/customers/:customerId";
  const customer = (r: FastifyRequest) => String(obj(r.params).customerId);
  async function access(r: FastifyRequest, operate = false) {
    const actor = await extractAdmin(r, context);
    if (
      !grantsForRole(actor.role).has(operate ? "admin:operate" : "admin:read")
    )
      throw new ApiError(403, "forbidden", "Insufficient permissions");
    if (
      context.config.environment.toLowerCase() === "production" ||
      !customerOperationsEnabled(context.config.env)
    )
      throw new ApiError(404, "not_found", "Customer operations unavailable");
    return actor;
  }
  function command(r: FastifyRequest) {
    let body;
    try {
      body = parseCustomerOperation(r.body);
    } catch (error) {
      bad((error as Error).message);
    }
    if (!["webhook.replay", "webhook.replay.approve"].includes(body.action))
      bad("Unsupported Growth customer action");
    if (!customerActionEnabled(body.action, context.config.env))
      throw new ApiError(403, "forbidden", "Customer action disabled");
    return body;
  }
  app.get(prefix, async (r) => {
    await access(r);
    const overview = await customers.customerOverview(
      context.pool,
      customer(r),
    );
    return {
      ...overview,
      sections: overview.sections.map((section) => ({
        ...section,
        records: section.records.map((record) => ({
          ...record,
          actions: record.actions?.filter((a) =>
            customerActionEnabled(a.action, context.config.env),
          ),
        })),
      })),
    };
  });
  app.get(prefix + "/operations/:operationId", async (r) => {
    await access(r);
    return customers.customerReceipt(
      context.pool,
      customer(r),
      String(obj(r.params).operationId),
    );
  });
  app.get(prefix + "/:collection", async (r) => {
    await access(r);
    const section = await customers.customerCollection(
      context.pool,
      customer(r),
      String(obj(r.params).collection),
      obj(r.query),
    );
    return {
      ...section,
      records: section.records.map((record) => ({
        ...record,
        actions: record.actions?.filter((a) =>
          customerActionEnabled(a.action, context.config.env),
        ),
      })),
    };
  });
  app.post(prefix + "/operations/preview", async (r) => {
    const actor = await access(r, true);
    return customers.previewCustomerOperation(
      context.pool,
      customer(r),
      command(r),
      actor.id,
    );
  });
  app.post(prefix + "/operations", async (r) => {
    const actor = await access(r, true);
    return customers.executeCustomerOperation(
      context.pool,
      customer(r),
      actor.id,
      command(r),
    );
  });
  app.post(prefix + "/operations/:operationId/approve", async (r) => {
    const actor = await access(r, true),
      body = command(r),
      id = String(obj(r.params).operationId);
    if (
      body.action !== "webhook.replay.approve" ||
      body.targetId !== id ||
      body.expected.status !== "awaiting_approval"
    )
      bad("Invalid approval scope");
    return customers.approveCustomerOperation(
      context.pool,
      customer(r),
      id,
      actor.id,
      body,
    );
  });
}
