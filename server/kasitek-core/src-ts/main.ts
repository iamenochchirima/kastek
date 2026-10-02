import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfig } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerOrganizationRoutes } from './routes/orgs.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { registerBookingRoutes } from './routes/bookings.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerReferralRoutes } from './routes/referrals.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerRealtimeRoutes } from './routes/realtime.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerInternalWorkspaceRoutes } from './routes/internal-workspace.js';
import { registerConnectionRoutes } from './routes/connections.js';

export async function start(): Promise<void> {
  process.env.TZ = 'UTC';
  const config = readConfig();
  // Temporary migration guard: missing workers must never look like a successful start.
  const mode = config.env.KASITEK_PROCESS ?? 'api';
  if (mode !== 'api') throw new Error(`TypeScript process ${mode} has not been migrated yet`);
  if (!['1', 'true', 'yes', 'on'].includes(config.env.KASITEK_DISABLE_BACKGROUND_WORKERS?.toLowerCase() ?? '')) {
    throw new Error('During migration, start the TypeScript comparison API with KASITEK_DISABLE_BACKGROUND_WORKERS=1');
  }
  const pool = createPool(config);
  const app = await buildApp({ config, pool }, CORE_REGISTRARS);
  app.addHook('onClose', async () => pool.end());
  try {
    await pool.query('SELECT 1');
    await app.listen({ host: '0.0.0.0', port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
}

export const CORE_REGISTRARS = [registerAuthRoutes, registerProfileRoutes, registerOrganizationRoutes,
  registerAdminAuthRoutes, registerBookingRoutes, registerCustomerRoutes, registerBillingRoutes,
  registerReferralRoutes, registerNotificationRoutes, registerRealtimeRoutes, registerAnalyticsRoutes,
  registerInternalWorkspaceRoutes, registerConnectionRoutes];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(() => {
    console.error('Core startup failed. Check service configuration and database availability.');
    process.exitCode = 1;
  });
}
