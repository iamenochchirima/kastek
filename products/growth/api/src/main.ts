import {registerAdminCustomerRoutes} from "./routes/admin-customers.js";
import {loadServiceEnvironment} from "@kasitek-labs/server-support/config";
import {registerAdminReportingRoutes} from "./routes/admin-reporting.js";
import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readConfig } from "./config.js";
import { createPool } from "./db.js";
import { buildApp } from "./app.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerOrganizationRoutes } from "./routes/orgs.js";
import { registerAdminAuthRoutes } from "./routes/admin-auth.js";
import { registerBookingRoutes } from "./routes/bookings.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerReferralRoutes } from "./routes/referrals.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerEarlyAccessRoutes } from "./routes/early-access.js";
import { registerWhatsappConnectionRoutes } from "./routes/whatsapp-connections.js";
import { registerWhatsappMarketingRoutes } from "./routes/whatsapp.js";
import { registerSocialRoutes } from "./routes/social.js";
import { registerEmailRoutes } from "./routes/email.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { createWhatsappInboxPorts } from "./services/whatsapp/inbox.js";
import { publishInboxEvent } from "./services/realtime.js";
import type { FastifyInstance } from "fastify";
import type { CoreContext } from "./context.js";
import { registerAdminOperationsRoutes } from "./routes/admin-operations.js";
import { registerWhatsappInboxRoutes } from "./routes/whatsapp-inbox.js";
import { registerWhatsappCallRoutes } from "./routes/whatsapp-calls.js";
import { registerWhatsappWebhookRoutes } from "./routes/whatsapp-webhooks.js";
import { ingestWebhookCalls } from "./services/whatsapp/calls.js";
import { registerCommunicationsRoutes } from "./routes/communications.js";
import { registerDeveloperRoutes } from "./routes/developers.js";
import { registerGrowthOAuthRoutes } from "./oauth/index.js";
import { registerGrowthOperationRoutes } from "./operations/routes.js";
import { registerGrowthMcpRoutes } from "./operations/mcp.js";
import { registerGrowthMediaTransferRoutes } from "./operations/media-transfers.js";
import { registerPublicV1Routes } from "./routes/public-v1.js";
import {
  createPublicDomainAdapter,
  createPublicReadPorts,
} from "./capabilities/public-adapter.js";
import { registerGrowthAgentRoutes } from "./agents/routes.js";
import { registerGrowthAgentProvisioningRoutes } from "./agents/provisioning-routes.js";
import { registerGrowthAgentActionRoutes } from "./agents/action-routes.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerAdminLaunchAccessRoutes } from "./routes/admin-launch-access.js";
import {
  API_WORKERS,
  apiWorkersEnabled,
  createWorkerRunners,
  processWorkers,
  runWorkerGroup,
} from "./workers/runtime.js";

function registerUnifiedInboxRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  registerInboxRoutes(app, context, {
    config: context.config,
    whatsapp: createWhatsappInboxPorts(context),
    publishEvent: (orgId, event) => publishInboxEvent(context, orgId, event),
  });
}
function registerPublicRoutes(
  app: FastifyInstance,
  context: CoreContext,
): void {
  registerPublicV1Routes(
    app,
    context,
    createPublicDomainAdapter(context.pool, createPublicReadPorts(context)),
  );
}
async function registerWhatsappCallbacks(
  app: FastifyInstance,
  context: CoreContext,
): Promise<void> {
  await registerWhatsappWebhookRoutes(app, context, {
    config: context.config,
    publishEvent: (orgId, event) => publishInboxEvent(context, orgId, event),
    ingestCalls: ingestWebhookCalls,
  });
}

export async function start(runtime?: {
  shutdownTelemetry(): Promise<void>;
}): Promise<void> {
  // Load service-local environment settings even when launched from another directory.
  loadServiceEnvironment(fileURLToPath(new URL("../.env", import.meta.url)), path => loadEnvironment(path === undefined ? {} : {path}));
  process.env.TZ = "UTC";
  const config = readConfig();
  const dedicatedWorkers = processWorkers(config.rawEnv.KASITEK_PROCESS);
  const pool = createPool(config);
  const core = { config, pool };
  let app: FastifyInstance;
  try {
    app = await buildApp(core, dedicatedWorkers ? [] : CORE_REGISTRARS);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const controller = new AbortController();
  let workers: Promise<void> = Promise.resolve();
  app.addHook("preClose", async () => {
    controller.abort();
  });
  app.addHook("onClose", async () => {
    controller.abort();
    await workers.catch(() => {});
    try {
      await pool.end();
    } finally {
      await runtime?.shutdownTelemetry();
    }
  });
  const shutdown = () => {
    controller.abort();
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, shutdown);
  app.addHook("onClose", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.removeListener(signal, shutdown);
  });
  try {
    await pool.query("SELECT 1");
    if (dedicatedWorkers) {
      workers = runWorkerGroup(
        dedicatedWorkers,
        createWorkerRunners(core, app.log),
        controller,
        app.log,
      );
      await workers;
      await app.close();
      return;
    }
    await app.listen({ host: "0.0.0.0", port: config.port });
    if (apiWorkersEnabled(config.rawEnv.KASITEK_DISABLE_BACKGROUND_WORKERS)) {
      app.log.info({
        event: "service.startup",
        component: "background_workers",
        process: "api",
      });
      workers = runWorkerGroup(
        API_WORKERS,
        createWorkerRunners(core, app.log),
        controller,
        app.log,
      );
      void workers.catch(() => {
        process.exitCode = 1;
        shutdown();
      });
    } else {
      app.log.info({
        event: "worker.disabled",
        process: "api",
        reason: "separate_worker_deployment_required",
      });
    }
  } catch (error) {
    await app.close();
    throw error;
  }
}

export const CORE_REGISTRARS = [
  registerAuthRoutes,
  registerProfileRoutes,
  registerOrganizationRoutes,
  registerAdminAuthRoutes,
  registerBookingRoutes,
  registerCustomerRoutes,
  registerBillingRoutes,
  registerReferralRoutes,
  registerNotificationRoutes,
  registerRealtimeRoutes,
  registerAnalyticsRoutes,
  registerConnectionRoutes,
  registerEarlyAccessRoutes,
  registerWhatsappConnectionRoutes,
  registerWhatsappMarketingRoutes,
  registerSocialRoutes,
  registerEmailRoutes,
  registerUnifiedInboxRoutes,
  registerLeadRoutes,
  registerAdminOperationsRoutes,
  registerAdminReportingRoutes,
  registerAdminCustomerRoutes,
  registerWhatsappInboxRoutes,
  registerWhatsappCallRoutes,
  registerWhatsappCallbacks,
  registerCommunicationsRoutes,
  registerDeveloperRoutes,
  registerGrowthOAuthRoutes,
  registerGrowthOperationRoutes,
  registerGrowthMediaTransferRoutes,
  registerGrowthMcpRoutes,
  registerPublicRoutes,
  registerWorkspaceRoutes,
  registerGrowthAgentRoutes,
  registerGrowthAgentActionRoutes,
  registerGrowthAgentProvisioningRoutes,
  registerAdminLaunchAccessRoutes,
];

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  import("./bootstrap.js")
    .then(({ boot }) => boot())
    .catch(() => {
      console.error(
        "Core startup failed. Check service configuration and database availability.",
      );
      process.exitCode = 1;
    });
}
