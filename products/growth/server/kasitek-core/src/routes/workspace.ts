import type { FastifyInstance } from 'fastify';
import type { CoreContext } from '../context.js';
import { extractUser, resolveActiveOrgId } from '../identity/session.js';
import { workspaceSummary } from '../services/workspace-summary.js';
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  context: CoreContext,
) {
  app.get('/api/workspace/summary', async (request) => {
    const user = await extractUser(request, context),
      org = await resolveActiveOrgId(request, context, user.id);
    return workspaceSummary(context, org, user.id);
  });
}
